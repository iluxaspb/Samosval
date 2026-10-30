// Promote the inspected TEST snapshot once; never overwrite a live dictionary.
import {fail,map} from './tabel-access.mjs';
export async function seedObjects(pool,{workspaceId='main_workspace',sha256}={}) {
  if(workspaceId!=='main_workspace'||!/^[a-f0-9]{64}$/.test(sha256||''))throw fail('inspected-test-import-required');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    if((await client.query('SELECT current_database() AS name')).rows[0].name!=='samosval_test')throw fail('test-database-required');
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[workspaceId]);
    await client.query('LOCK TABLE workspace_objects IN EXCLUSIVE MODE');
    if((await client.query('SELECT 1 FROM workspace_objects WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rowCount)throw fail('target-not-empty',409);
    const source=(await client.query('SELECT workspace_id,source_project,counts FROM migration_imports WHERE sha256=$1',[sha256])).rows[0];
    if(!source||source.workspace_id!==workspaceId||source.source_project!=='samosval-offline'||!Number.isSafeInteger(source.counts?.objects)||source.counts.objects<1)throw fail('wrong-import-source');
    const prefix='workspaces/'+workspaceId+'/objects/';
    const rows=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND document_path LIKE $2 ORDER BY document_path',[sha256,prefix+'%'])).rows;
    if(rows.length!==source.counts.objects)throw fail('object-count-mismatch');
    for(const row of rows){
      const id=row.document_path.slice(prefix.length),data=row.payload;
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||!map(data)||typeof data.name!=='string'||!data.name.trim()||data.name.length>500)throw fail('corrupt-object-import');
      await client.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)',[workspaceId,id,data]);
    }
    await client.query('COMMIT');return {objects:rows.length,sha256};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release();}
}
