// Explicit, one-time promotion of immutable TEST import records to the new table API.
// Requires the operator to supply the inspected import checksum. Never refreshes live rows.
import {parseKey,map,fail} from '../src/tabel-access.mjs';
export async function seedTabel(pool,{workspaceId='main_workspace',sha256}={}) {
  if (workspaceId!=='main_workspace' || !/^[a-f0-9]{64}$/.test(sha256||'')) throw fail('inspected-test-import-required');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query('SELECT current_database() AS name')).rows[0].name!=='samosval_test') throw fail('test-database-required');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['tabel:'+workspaceId]);
    await client.query('LOCK TABLE tabel_records,tabel_receipts,tabel_policy IN EXCLUSIVE MODE');
    for (const table of ['tabel_records','tabel_receipts','tabel_policy']) {
      if ((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 LIMIT 1`,[workspaceId])).rowCount) throw fail('target-not-empty',409);
    }
    const source=(await client.query('SELECT workspace_id,source_project FROM migration_imports WHERE sha256=$1',[sha256])).rows[0];
    if (!source || source.workspace_id!==workspaceId || source.source_project!=='samosval-offline') throw fail('wrong-import-source');
    const prefix='workspaces/'+workspaceId+'/';
    const rows=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND document_path LIKE $2 ORDER BY document_path',[sha256,prefix+'tabelNextRecords/%'])).rows;
    for (const {document_path,payload} of rows) {
      const {objectId,recordId}=parseKey(payload?.key);
      if (document_path!==prefix+'tabelNextRecords/'+recordId || payload.recordId!==recordId || payload.objectId!==objectId || !map(payload.data) || !Number.isSafeInteger(payload.revision) || payload.revision<1) throw fail('corrupt-tabel-import');
      await client.query('INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload,baseline_payload) VALUES ($1,$2,$3,$4,$5,$5)',[workspaceId,recordId,objectId,payload.key,payload]);
    }
    const policy=(await client.query('SELECT payload FROM migration_documents WHERE import_sha256=$1 AND document_path=$2',[sha256,prefix+'tabelNextMeta/config'])).rows[0]?.payload;
    if (!policy || policy.schema!==1 || typeof policy.enabled!=='boolean') throw fail('tabel-policy-not-in-import');
    await client.query('INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ($1,$2,$3)',[workspaceId,policy.enabled,sha256]);
    await client.query('COMMIT');
    return {records:rows.length,enabled:policy.enabled,sha256};
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally {client.release();}
}
