import {fail} from './tabel-access.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
export async function readArchiveSnapshot(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor=(await client.query('SELECT role,status,profile FROM app_users WHERE uid=$1',[uid])).rows[0];
    if(!actor||actor.status!=='active'||actor.profile?.deleted)throw fail('forbidden',403);
    if(actor.role!=='admin'&&!(await client.query("SELECT 1 FROM role_permissions WHERE role=$1 AND action IN ('tab_archive','tab_analytics') AND allowed=true LIMIT 1",[actor.role])).rowCount)throw fail('forbidden',403);
    const state=(await client.query('SELECT initialized,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    if(!state?.initialized||!state.import_sha256)throw fail('archive-not-ready',409);
    const source=(await client.query('SELECT workspace_id,source_project,exported_at FROM migration_imports WHERE sha256=$1',[state.import_sha256])).rows[0];
    if(!source||source.workspace_id!==ws||source.source_project!=='samosval-offline')throw fail('archive-source-mismatch',409);
    // Retain every saved display field and trip order. Never rebuild from live logs.
    const prefix='workspaces/'+ws+'/archive/';
    const original=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2 ORDER BY document_path',[state.import_sha256,prefix])).rows;
    const archives=new Map();
    for(const row of original){
      const id=row.document_path.slice(prefix.length);
      if(!id||id.includes('/'))throw fail('invalid-archive-import',409);
      archives.set(id,{...row.payload,id});
    }
    const current=(await client.query('SELECT archive_id,payload FROM shift_archives WHERE workspace_id=$1 ORDER BY archive_id',[ws])).rows;
    for(const row of current){
      if(archives.has(row.archive_id))throw fail('archive-id-conflict',409);
      archives.set(row.archive_id,{...row.payload,id:row.archive_id});
    }
    const trashPrefix='workspaces/'+ws+'/trash/';
    const trash=(await client.query('SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND left(document_path,length($2))=$2 ORDER BY document_path',[state.import_sha256,trashPrefix])).rows.map(row=>({...row.payload,id:row.document_path.slice(trashPrefix.length)}));
    await client.query('COMMIT');
    return {format:'samosval-archive-snapshot',version:1,source:'synology',workspaceId:ws,importedAt:Number(source.exported_at),archives:[...archives.values()],trash};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
