import {fail,map} from './tabel-access.mjs';
export async function seedIdentity(pool,{sha256,ownerUid}={}){
  if(!/^[a-f0-9]{64}$/.test(sha256||'')||ownerUid!==undefined&&(typeof ownerUid!=='string'||!ownerUid||ownerUid.length>128))throw fail('inspected-test-import-required');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if((await client.query('SELECT current_database() AS name')).rows[0].name!=='samosval_test')throw fail('test-database-required');
    const state=(await client.query('SELECT initialized FROM identity_state WHERE id=1 FOR UPDATE')).rows[0];
    if(!state||state.initialized)throw fail('identity-already-initialized',409);
    await client.query('LOCK TABLE registration_requests,identity_receipts,identity_audit IN EXCLUSIVE MODE');
    for(const table of ['registration_requests','identity_receipts','identity_audit'])if((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)throw fail('identity-target-not-empty',409);
    const source=(await client.query('SELECT workspace_id,source_project,counts FROM migration_imports WHERE sha256=$1',[sha256])).rows[0];
    if(!source||source.workspace_id!=='main_workspace'||source.source_project!=='samosval-offline'||!Number.isSafeInteger(source.counts?.users)||source.counts.users<1)throw fail('wrong-import-source');
    const rows=(await client.query("SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND document_path LIKE 'users/%' ORDER BY document_path",[sha256])).rows;
    const users=(await client.query('SELECT uid,email,display_name,role,status,revision,profile,protected FROM app_users ORDER BY uid FOR UPDATE')).rows;
    if(rows.length!==source.counts.users||users.length!==rows.length)throw fail('identity-count-mismatch');
    const byUid=new Map(users.map(u=>[u.uid,u]));
    for(const row of rows){
      const uid=row.document_path.slice(6),data=row.payload,user=byUid.get(uid);
      if(!map(data)||!user||user.email!==data.email||user.role!==data.role||user.status!==data.status||data.deleted&&data.status==='active'||user.display_name!==(data.nickname||data.displayName||data.email)||Number(user.revision)!==1||user.protected||Object.keys(user.profile).length)throw fail('identity-source-mismatch');
    }
    const admins=users.filter(u=>u.role==='admin'&&u.status==='active');
    const owner=ownerUid?admins.find(u=>u.uid===ownerUid):admins.length===1?admins[0]:null;
    if(!owner)throw fail('explicit-owner-required');
    const ownerSource=rows.find(r=>r.document_path==='users/'+owner.uid)?.payload;
    if(ownerSource?.deleted)throw fail('invalid-owner');
    for(const row of rows)await client.query('UPDATE app_users SET profile=$2,protected=$3 WHERE uid=$1',[row.document_path.slice(6),row.payload,row.document_path==='users/'+owner.uid]);
    const requests=(await client.query("SELECT document_path,payload FROM migration_documents WHERE import_sha256=$1 AND document_path LIKE 'registration_requests/%' ORDER BY document_path",[sha256])).rows;
    if(requests.length!==source.counts.registrationRequests)throw fail('registration-count-mismatch');
    const pending=users.filter(u=>u.status==='pending'),seen=new Set();
    for(const {document_path,payload:data} of requests){
      if(!map(data))throw fail('corrupt-registration-import');
      const direct=data.uid||document_path.slice('registration_requests/'.length);
      let user=byUid.get(direct);
      if(!user&&!data.uid){const matches=pending.filter(u=>u.email===data.email);if(matches.length===1)user=matches[0];}
      if(!user||user.status!=='pending'||user.email!==data.email||seen.has(user.uid))throw fail('unresolved-registration-request');
      seen.add(user.uid);await client.query('INSERT INTO registration_requests(uid,payload) VALUES ($1,$2)',[user.uid,{...data,uid:user.uid,nickname:user.display_name,status:'pending',legacyRequestId:document_path.slice('registration_requests/'.length)}]);
    }
    for(const user of pending)if(!seen.has(user.uid)){
      await client.query('INSERT INTO registration_requests(uid,payload) VALUES ($1,$2)',[user.uid,{uid:user.uid,email:user.email,nickname:user.display_name,status:'pending',recovered:true}]);
    }
    await client.query('UPDATE identity_state SET initialized=true,owner_uid=$1,import_sha256=$2 WHERE id=1',[owner.uid,sha256]);
    await client.query('COMMIT');return {users:users.length,requests:pending.length,ownerProtected:true,sha256};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
