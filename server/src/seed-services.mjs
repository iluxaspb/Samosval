import {fail,map} from './tabel-access.mjs';
export async function seedServices(pool,{workspaceId='main_workspace',sha256}={}){
  if(workspaceId!=='main_workspace'||!/^[a-f0-9]{64}$/.test(sha256||''))throw fail('inspected-test-import-required');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if((await client.query('SELECT current_database() AS name')).rows[0].name!=='samosval_test')throw fail('test-database-required');
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[workspaceId]);
    for(const table of ['workspace_settings','game_records','workspace_services_state']){
      await client.query(`LOCK TABLE ${table} IN EXCLUSIVE MODE`);
      if((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 LIMIT 1`,[workspaceId])).rowCount)throw fail('target-not-empty',409);
    }
    const identity=(await client.query('SELECT initialized,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    const source=(await client.query('SELECT workspace_id,source_project,counts FROM migration_imports WHERE sha256=$1',[sha256])).rows[0];
    if(!identity?.initialized||identity.import_sha256!==sha256||!source||source.workspace_id!==workspaceId||source.source_project!=='samosval-offline')throw fail('wrong-import-source');
    const config=(await client.query("SELECT payload FROM migration_documents WHERE import_sha256=$1 AND document_path='settings/appConfig'",[sha256])).rows;
    if(config.length!==1||!map(config[0].payload))throw fail('settings-source-missing',409);
    const cycle=(await client.query('SELECT cycle_minutes FROM workspaces WHERE id=$1',[workspaceId])).rows[0].cycle_minutes;
    const data={...config[0].payload,cycleMinutes:cycle};
    await client.query('INSERT INTO workspace_settings(workspace_id,payload) VALUES ($1,$2)',[workspaceId,data]);
    const counts={};
    for(const collection of ['audit','coinTransactions']){
      const prefix=`workspaces/${workspaceId}/${collection}/`;
      const rows=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2 ORDER BY document_path',[sha256,prefix])).rows;
      if(!Number.isSafeInteger(source.counts?.[collection])||source.counts[collection]!==rows.length)throw fail('game-source-count-mismatch',409);
      for(const row of rows){
        const id=row.document_path.slice(prefix.length);if(!id||id.includes('/')||!map(row.payload))throw fail('invalid-game-source',409);
        await client.query('INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,$3,$4)',[workspaceId,id,collection,row.payload]);
      }
      counts[collection]=rows.length;
    }
    await client.query('INSERT INTO workspace_services_state(workspace_id,import_sha256) VALUES ($1,$2)',[workspaceId,sha256]);
    await client.query('COMMIT');return {sha256,settings:1,...counts};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
