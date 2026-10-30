import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {normalizeAuxiliary,publicAuxiliary,readAuxiliary,submitAuxiliary} from '../src/auxiliary-store.mjs';
test('auxiliary intents reject minted game/history events and malformed backup IDs',()=>{
 const op={id:'a',type:'auxiliary.save',collection:'audit',recordId:'r',expectedRevision:0,data:{text:'Fixture'}};
 for(const eventType of ['history','game_arcade','game_penalty','undo','redo'])assert.throws(()=>normalizeAuxiliary({...op,data:{text:'Fixture',eventType}}));
 assert.throws(()=>normalizeAuxiliary({...op,recordId:'../r'}));
 const item={collection:'objects',recordId:'one',expectedRevision:0,data:{name:'One'}};
 assert.throws(()=>normalizeAuxiliary({id:'a',type:'backup.import',items:[item,item]}));
 assert.deepEqual(publicAuxiliary({maxToken:'fixture',nested:{password:'fixture',name:'Safe'},list:[{maxUrl:'fixture',ok:1}]}),{nested:{name:'Safe'},list:[{ok:1}]});
});
test('PostgreSQL auxiliary: preserved import, concurrent revisions, atomic backup, immutable audit and revoked receipt',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),sha=randomBytes(32).toString('hex'),ws='aux_'+sha.slice(0,20),admin=ws+'_a',user=ws+'_u';let original;
 const save=(id,recordId,expectedRevision,data,uid=admin)=>submitAuxiliary(pool,uid,{id,type:'auxiliary.save',collection:'plugins',recordId,expectedRevision,data},ws);
 try{
  original=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
  await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
  for(const [uid,role] of [[admin,'admin'],[user,'viewer']])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$1,$3,'active')",[uid,uid+'@example.test',role]);
  await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,$2,'samosval-offline',1,'{}')",[sha,ws]);
  await pool.query('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[sha]);
  for(const [collection,id,payload] of [['plugins','legacy',{name:'Legacy',enabled:true,allowedRoles:['admin'],code:'original'}],['patches','motion',{name:'Motion',enabled:true,code:'original'}],['audit','old',{text:'Old',timestamp:1,history:{maxToken:'fixture'}}]])await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,`workspaces/${ws}/${collection}/${id}`,payload]);
  await t.test('source payload stays intact; role views redact secrets and excluded plugins',async()=>{
   const a=await readAuxiliary(pool,admin,ws),u=await readAuxiliary(pool,user,ws);assert.equal(a.plugins[0].code,'original');assert.equal(u.plugins.length,0);assert.equal(u.audit.find(x=>x.id==='old').history.maxToken,undefined);assert.equal(a.patches[0].code,'original');
   await assert.rejects(save('forged','legacy',1,{name:'Changed'},user),{code:'forbidden'});
  });
  await t.test('same command commits once, and a competing editor cannot overwrite its revision',async()=>{
   const op={name:'Changed',enabled:true,code:'new'};const results=await Promise.all([save('edit','legacy',1,op),save('edit','legacy',1,op)]);assert.equal(results.filter(r=>r.replayed).length,1);
   await assert.rejects(save('compete','legacy',1,{name:'Other'}),{code:'auxiliary-changed'});await assert.rejects(save('edit','legacy',1,{name:'Other'}),{code:'operation-id-reused'});
   assert.equal((await pool.query("SELECT payload->>'code' code FROM migration_documents WHERE import_sha256=$1 AND document_path=$2",[sha,`workspaces/${ws}/plugins/legacy`])).rows[0].code,'original');
  });
  await t.test('backup is atomic; receipts retain the same IDs and source remains recoverable',async()=>{
   const items=[{collection:'objects',recordId:'site',expectedRevision:0,data:{name:'Site'}},{collection:'trucks',recordId:'truck',expectedRevision:0,data:{brand:'Truck',number:'A001AA',defaultVol:24,isGAI:false}},{collection:'archive',recordId:'old_shift',expectedRevision:0,data:{objectId:'site',date:'30.10.2026',logs:[],activeLineIds:[],paper:{width:700}}}];
   const op={id:'import',type:'backup.import',items};await assert.rejects(submitAuxiliary(pool,user,op,ws),{code:'forbidden'});
   await submitAuxiliary(pool,admin,op,ws);assert.equal((await submitAuxiliary(pool,admin,op,ws)).replayed,true);
   await assert.rejects(submitAuxiliary(pool,admin,{...op,id:'conflict',items:[{...items[0],recordId:'new_site'},items[1]]},ws),{code:'backup-target-changed'});
   assert.equal((await pool.query("SELECT count(*)::int n FROM workspace_objects WHERE workspace_id=$1 AND object_id='new_site'",[ws])).rows[0].n,0);
  });
  await t.test('audit authors come from the profile and revocation denies an old success replay',async()=>{
   const op={id:'audit',type:'auxiliary.save',collection:'audit',recordId:'note',expectedRevision:0,data:{text:'Note',userName:'forged',timestamp:1}};await submitAuxiliary(pool,user,op,ws);
   const note=(await readAuxiliary(pool,admin,ws)).audit.find(x=>x.id==='note');assert.equal(note.userName,user);assert.ok(note.timestamp>1);
   await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[user]);await assert.rejects(submitAuxiliary(pool,user,op,ws),{code:'forbidden'});
  });
 }finally{
  if(original)await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[original.initialized,original.owner_uid,original.import_sha256]);
  for(const table of ['workspace_aux_records','workspace_service_audit','workspace_service_receipts','archive_overrides','line_trucks','workspace_objects'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
  await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);await pool.query('DELETE FROM migration_imports WHERE sha256=$1',[sha]);await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[admin,user]]);await pool.end();
 }
});
