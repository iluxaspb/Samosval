import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mergeRecord} from './tabel-merge.mjs';
import {canView, canRead, canWrite, manager, parseKey, validateJob, fail} from './tabel-access.mjs';
const WORKSPACE = process.env.WORKSPACE_ID || 'main_workspace';
const empty = () => ({revision:0,data:null});
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export const jobHash = job => createHash('sha256').update(JSON.stringify(canonical({id:job.id,key:job.key,data:job.data,before:{revision:job.before.revision,data:job.before.data},label:job.label||'Изменение табеля'}))).digest('hex');
async function actorFor(client, uid) {
  const profile = (await client.query('SELECT display_name,role,status FROM app_users WHERE uid=$1 FOR SHARE',[uid])).rows[0];
  if (!profile || profile.status !== 'active') throw fail('forbidden',403);
  const permissions = (await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true FOR SHARE',[profile.role])).rows.map(r=>r.action);
  const actor = {...profile,uid,permissions};
  if (!canView(actor)) throw fail('forbidden',403);
  const policy = (await client.query('SELECT enabled FROM tabel_policy WHERE workspace_id=$1 FOR SHARE',[WORKSPACE])).rows[0];
  if (!policy?.enabled) throw fail('tabel-not-ready',409);
  return actor;
}
async function getRow(client,key) {
  const {recordId} = parseKey(key);
  return (await client.query('SELECT payload FROM tabel_records WHERE workspace_id=$1 AND record_id=$2',[WORKSPACE,recordId])).rows[0]?.payload || empty();
}
async function transaction(pool, fn, readOnly = false) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}
// Reads use a consistent snapshot; writes additionally lock profiles/policy against revocation.
async function readActor(client,uid) {
  const profile = (await client.query('SELECT display_name,role,status FROM app_users WHERE uid=$1',[uid])).rows[0];
  if (!profile || profile.status !== 'active') throw fail('forbidden',403);
  const permissions = (await client.query('SELECT action FROM role_permissions WHERE role=$1 AND allowed=true',[profile.role])).rows.map(r=>r.action);
  const actor = {...profile,uid,permissions};
  if (!canView(actor)) throw fail('forbidden',403);
  if (!(await client.query('SELECT enabled FROM tabel_policy WHERE workspace_id=$1',[WORKSPACE])).rows[0]?.enabled) throw fail('tabel-not-ready',409);
  return actor;
}
export function readTabel(pool,uid,{key,objectId,cursor='',kind='records'}={}) {
  if (key !== undefined) parseKey(key);
  else if (typeof objectId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(objectId)) throw fail('invalid-object-id');
  if (typeof cursor !== 'string' || cursor.length > 250 || !['records','history'].includes(kind)) throw fail('invalid-query');
  return transaction(pool,async client=>{
    const actor = await readActor(client,uid);
    if (key !== undefined) {
      const {objectId} = parseKey(key), current = await getRow(client,key);
      const config = (await getRow(client,objectId+'/config')).data;
      if (!canRead(actor,key,config)) throw fail('forbidden',403);
      return {record:current};
    }
    if (kind === 'history' && !manager(actor)) throw fail('forbidden',403);
    const config = (await getRow(client,objectId+'/config')).data;
    const history = kind === 'history';
    const rows = (await client.query(history
      ? 'SELECT operation_id AS id,payload FROM tabel_receipts WHERE workspace_id=$1 AND object_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT 51'
      : 'SELECT record_id AS id,payload FROM tabel_records WHERE workspace_id=$1 AND object_id=$2 AND record_id>$3 ORDER BY record_id LIMIT 51', [WORKSPACE,objectId,cursor])).rows;
    const page = rows.slice(0,50);
    const allowed = history ? page : page.filter(r=>canRead(actor,r.payload.key,config));
    return {rows:allowed.map(r=>history ? {id:r.id,...r.payload} : [r.payload.key,r.payload]),cursor:rows.length>50?page.at(-1).id:null};
  },true);
}
export function commitTabel(pool,uid,job) {
  validateJob(job);
  // Copy before the first await: the request hash and saved bytes must describe the same job.
  job = structuredClone(job);
  const hash = jobHash(job), {objectId,recordId} = parseKey(job.key);
  return transaction(pool,async client=>{
    const actor = await actorFor(client,uid);
    // Serialize a workspace's table commits. This also serializes ACL changes with data writes.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['tabel:'+WORKSPACE]);
    const config = (await getRow(client,objectId+'/config')).data;
    const current = await getRow(client,job.key);
    if (!canRead(actor,job.key,config) || !canWrite(actor,job.key,job.data,current.data,config)) throw fail('forbidden',403);
    const receipt = (await client.query('SELECT uid,request_hash,payload FROM tabel_receipts WHERE workspace_id=$1 AND operation_id=$2',[WORKSPACE,job.id])).rows[0];
    if (receipt) {
      if (receipt.uid !== uid || receipt.request_hash !== hash) throw fail('operation-id-reused',409);
      return receipt.payload.after;
    }
    let outgoing = job.data;
    if (job.before.revision > current.revision)
      return {conflict:true,current,fields:['future-base-revision']};
    if (current.revision === job.before.revision && !isDeepStrictEqual(current.data,job.before.data))
      return {conflict:true,current,fields:['base-content-mismatch']};
    if (current.revision !== job.before.revision) {
      if (job.before.revision > 0) {
        const history = (await client.query(
          "SELECT payload->'after' AS record FROM tabel_receipts WHERE workspace_id=$1 AND object_id=$2 AND payload->>'key'=$3 AND (payload->'after'->>'revision')::bigint=$4 LIMIT 1",
          [WORKSPACE,objectId,job.key,job.before.revision])).rows[0]?.record;
        let base = history;
        if (!base) base = (await client.query(
          'SELECT baseline_payload AS record FROM tabel_records WHERE workspace_id=$1 AND record_id=$2',
          [WORKSPACE,recordId])).rows[0]?.record;
        if (!base || base.revision !== job.before.revision || !isDeepStrictEqual(base.data,job.before.data))
          return {conflict:true,current,fields:['base-not-verified']};
      }
      const merged = mergeRecord(job.before.data,job.data,current.data,job.key);
      if (merged.conflicts.length) return {conflict:true,current,fields:merged.conflicts};
      outgoing = merged.merged;
    }
    if (!canWrite(actor,job.key,outgoing,current.data,config)) throw fail('forbidden',403);
    if (Buffer.byteLength(JSON.stringify(outgoing)) > 350000) throw fail('record-too-large',413);
    const after = {recordId,key:job.key,objectId,revision:current.revision+1,data:outgoing,
      author:uid,authorName:actor.display_name.slice(0,160),time:Date.now(),operationId:job.id};
    const receiptData = {key:job.key,objectId,before:current,after,author:uid,time:after.time,label:job.label||'Изменение табеля'};
    await client.query('INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,record_id) DO UPDATE SET payload=EXCLUDED.payload',[WORKSPACE,recordId,objectId,job.key,after]);
    await client.query('INSERT INTO tabel_receipts(workspace_id,operation_id,uid,request_hash,object_id,payload) VALUES ($1,$2,$3,$4,$5,$6)',[WORKSPACE,job.id,uid,hash,objectId,receiptData]);
    return after;
  });
}
