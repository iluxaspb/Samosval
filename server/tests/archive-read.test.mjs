import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {readArchiveSnapshot} from '../src/archive-read.mjs';

test('PostgreSQL archive retains imported sheet fields, isolates source and enforces access',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const sha=randomBytes(32).toString('hex'),suffix=sha.slice(0,20),ws='archive_'+suffix,uid=ws+'_user',role=ws+'_role',admin=ws+'_admin',disabled=ws+'_disabled';let originalState;
  const q=(sql,args)=>pool.query(sql,args);
  try{
    originalState=(await q('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    await q('CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)');
    await q('CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))');
    await q('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    for(const [id,r,status] of [[uid,role,'active'],[admin,'admin','active'],[disabled,'admin','disabled']])await q('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$1,$3,$4)',[id,'fixture@example.test',r,status]);
    await q("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,$2,'samosval-offline',1000,'{}')",[sha,ws]);
    await q('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[sha]);
    const legacy={id:'untrusted-id',sourceShiftId:'old-shift',date:'29.10.2026',totalTrips:2,totalVolume:48,paper:{width:900,heights:[20,31]},logs:[{id:'later',truckId:'a',timestamp:2,isGAI:false},{id:'early',truckId:'a',timestamp:1,isGAI:false}]};
    await q('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3),($1,$4,$5)',[sha,'workspaces/'+ws+'/archive/legacy',legacy,'workspaces/other/archive/foreign',{secret:'must not leak'}]);
    await q('INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[ws,'new','new-shift',{sourceShiftId:'new-shift',logs:[],totalTrips:0}]);
    await t.test('default deny, disabled and unknown account checks precede data',async()=>{
      for(const actor of [uid,disabled,'missing'])await assert.rejects(readArchiveSnapshot(pool,actor,ws),{status:403});
      await q("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'tab_archive',true)",[role]);
    });
    await t.test('import field values and trip ordering are unchanged',async()=>{
      const result=await readArchiveSnapshot(pool,uid,ws);
      assert.equal(result.source,'synology');assert.equal(result.importedAt,1000);
      assert.equal(result.archives.length,2);assert.deepEqual(result.archives.find(a=>a.id==='legacy'),{...legacy,id:'legacy',revision:1});
      assert.equal(JSON.stringify(result).includes('must not leak'),false);
      assert.deepEqual(result.trash,[]);
    });
    await t.test('wrong workspace and absent seed fail instead of showing an empty success',async()=>{
      await assert.rejects(readArchiveSnapshot(pool,admin,'other'),{code:'archive-source-mismatch'});
      await q('UPDATE identity_state SET initialized=false WHERE id=1');
      await assert.rejects(readArchiveSnapshot(pool,admin,ws),{code:'archive-not-ready'});
      await q('UPDATE identity_state SET initialized=true WHERE id=1');
    });
    await t.test('native/import ID collisions fail visibly without replacing archived sheet',async()=>{
      await q('INSERT INTO shift_archives(workspace_id,archive_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[ws,'legacy','collision',{logs:[]}]);
      await assert.rejects(readArchiveSnapshot(pool,admin,ws),{code:'archive-id-conflict'});
    });
    await t.test('revocation immediately blocks the next archive read',async()=>{
      await q('UPDATE role_permissions SET allowed=false WHERE role=$1',[role]);
      await assert.rejects(readArchiveSnapshot(pool,uid,ws),{status:403});
    });
  }finally{
    if(originalState)await q('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[originalState.initialized,originalState.owner_uid,originalState.import_sha256]);
    await q('DELETE FROM shift_archives WHERE workspace_id=$1',[ws]);
    await q('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);
    await q('DELETE FROM migration_imports WHERE sha256=$1',[sha]);
    await q('DELETE FROM role_permissions WHERE role=$1',[role]);
    await q('DELETE FROM app_users WHERE uid IN ($1,$2,$3)',[uid,admin,disabled]);
    await q('DELETE FROM workspaces WHERE id=$1',[ws]);
    await pool.end();
  }
});
