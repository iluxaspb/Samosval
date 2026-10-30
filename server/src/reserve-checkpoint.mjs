import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
export const RESERVE_TABLES=Object.freeze(['app_users','archive_overrides','control_audit','control_operation_receipts','game_records','history_audit','history_receipts','identity_audit','identity_receipts','identity_state','line_audit','line_history','line_logs','line_operation_receipts','line_truck_statuses','line_trucks','migration_documents','migration_imports','notification_outbox','registration_requests','role_permission_versions','role_permissions','shift_archives','shift_operation_receipts','shifts','tabel_policy','tabel_receipts','tabel_records','workspace_aux_records','workspace_backups','workspace_objects','workspace_service_audit','workspace_service_receipts','workspace_services_state','workspace_settings','workspaces']);
const hash=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=message=>{throw Error(message);};
export function canonicalReserve(value){
  const normalize=x=>{
    if(x instanceof Date)return x.toISOString();
    if(Array.isArray(x))return x.map(normalize);
    if(object(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])]));
    if(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return x;
    fail('unsupported-checkpoint-value');
  };
  return JSON.stringify(normalize(value));
}
export function validateReserveSnapshot(snapshot){
  if(!object(snapshot)||snapshot.format!=='samosval-native-reserve'||snapshot.version!==1||snapshot.projectId!=='samosval-offline'||snapshot.workspaceId!=='main_workspace'||!object(snapshot.tables)||!object(snapshot.schema))fail('invalid-test-reserve');
  for(const section of ['tables','schema'])if(Object.keys(snapshot[section]).sort().join('|')!==RESERVE_TABLES.join('|'))fail('reserve-schema-incomplete');
  for(const name of RESERVE_TABLES){
    const columns=snapshot.schema[name],rows=snapshot.tables[name];
    if(!Array.isArray(columns)||!columns.length||columns.some(c=>!object(c)||!/^\w+$/.test(c.column_name)||typeof c.data_type!=='string')||new Set(columns.map(c=>c.column_name)).size!==columns.length||!Array.isArray(rows))fail('invalid-reserve-table');
    const keys=columns.map(c=>c.column_name).sort().join('|');
    for(const row of rows)if(!object(row)||Object.keys(row).sort().join('|')!==keys||row.workspace_id!==undefined&&row.workspace_id!=='main_workspace')fail('invalid-reserve-row');
  }
  if(snapshot.tables.workspaces.length!==1||snapshot.tables.workspaces[0].id!=='main_workspace')fail('foreign-workspace');
  if(snapshot.tables.migration_imports.some(r=>r.source_project!=='samosval-offline'))fail('foreign-import-source');
  return snapshot;
}
// A repeatable-read transaction captures business data AND all receipt/audit
// tables. An acknowledgement lost after a load is part of the same checkpoint.
export async function captureReserveSnapshot(pool){
  const c=await pool.connect();try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if((await c.query('SELECT current_database() AS name')).rows[0]?.name!=='samosval_test')fail('test-database-required');
    const schema={},tables={},columns=(await c.query("SELECT table_name,column_name,data_type,udt_name,is_nullable,ordinal_position FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
    if([...new Set(columns.map(c=>c.table_name))].sort().join('|')!==RESERVE_TABLES.join('|'))fail('reserve-schema-incomplete');
    for(const name of RESERVE_TABLES){
      schema[name]=columns.filter(c=>c.table_name===name).map(({table_name,...c})=>c);
      tables[name]=(await c.query('SELECT * FROM '+name)).rows.sort((a,b)=>{const x=canonicalReserve(a),y=canonicalReserve(b);return x<y?-1:x>y?1:0;});
    }
    const snapshot=validateReserveSnapshot({format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',schema,tables});
    await c.query('COMMIT');return snapshot;
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
export function encodeReserveCheckpoint(snapshot,{chunkBytes=512*1024,maxBytes=64*1024*1024}={}){
  validateReserveSnapshot(snapshot);
  if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1024||chunkBytes>512*1024||!Number.isSafeInteger(maxBytes)||maxBytes<1)fail('invalid-checkpoint-limits');
  const plain=Buffer.from(canonicalReserve(snapshot));if(plain.length>maxBytes)fail('checkpoint-too-large');
  const packed=gzipSync(plain),chunks=[];
  for(let offset=0;offset<packed.length;offset+=chunkBytes){const data=packed.subarray(offset,offset+chunkBytes);chunks.push({index:chunks.length,hash:hash(data),data});}
  const manifest={format:'samosval-reserve-checkpoint',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',encoding:'gzip',hash:hash(plain),schemaHash:hash(canonicalReserve(snapshot.schema)),bytes:plain.length,packedBytes:packed.length,
    chunks:chunks.map(({index,hash,data})=>({index,hash,bytes:data.length})),counts:Object.fromEntries(RESERVE_TABLES.map(name=>[name,snapshot.tables[name].length]))};
  return {manifest,chunks};
}
export function decodeReserveCheckpoint(manifest,chunks,{maxBytes=64*1024*1024}={}){
  if(!object(manifest)||manifest.format!=='samosval-reserve-checkpoint'||manifest.version!==1||manifest.projectId!=='samosval-offline'||manifest.workspaceId!=='main_workspace'||manifest.encoding!=='gzip'||!digest(manifest.hash)||!digest(manifest.schemaHash)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>maxBytes||!Number.isSafeInteger(manifest.packedBytes)||manifest.packedBytes<1||manifest.packedBytes>maxBytes+65536||!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>65536||!Array.isArray(chunks)||chunks.length!==manifest.chunks.length)fail('invalid-checkpoint-manifest');
  let total=0;const buffers=manifest.chunks.map((record,index)=>{
    const chunk=chunks[index];if(!record||record.index!==index||!digest(record.hash)||!Number.isSafeInteger(record.bytes)||record.bytes<1||record.bytes>512*1024||chunk?.index!==index||!Buffer.isBuffer(chunk.data)||chunk.data.length!==record.bytes||hash(chunk.data)!==record.hash)fail('checkpoint-chunk-mismatch');
    total+=record.bytes;return chunk.data;
  });
  if(total!==manifest.packedBytes)fail('checkpoint-size-mismatch');
  const plain=gunzipSync(Buffer.concat(buffers),{maxOutputLength:Math.min(maxBytes,manifest.bytes)});
  if(plain.length!==manifest.bytes||hash(plain)!==manifest.hash)fail('checkpoint-hash-mismatch');
  const snapshot=validateReserveSnapshot(JSON.parse(plain.toString('utf8')));
  if(hash(canonicalReserve(snapshot.schema))!==manifest.schemaHash||canonicalReserve(manifest.counts)!==canonicalReserve(Object.fromEntries(RESERVE_TABLES.map(name=>[name,snapshot.tables[name].length]))))fail('checkpoint-schema-or-count-mismatch');
  return snapshot;
}
