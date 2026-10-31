import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSparkAccessProjection,accessRowsFromMirrorSnapshot,
 affectedSparkAccessUids,needsSparkAccessRefresh,collectSparkAccessFromPostgres,
 sparkAccessRef} from '../src/test-spark-access.mjs';

const GEN='0123456789abcdef01234567';
const users=[
 {uid:'operatorA',email:'a@example.com',display_name:'Оператор А',role:'lopater',
  status:'active',revision:1,profile:{deleted:false}},
 {uid:'operatorB',email:'b@example.com',display_name:'Оператор Б',role:'lopater',
  status:'disabled',revision:2,profile:{deleted:false}},
 {uid:'engineerA',email:'f@example.com',display_name:'Мастер',role:'foreman',
  status:'active',revision:1,profile:{deleted:false}}
];
const permissions=[{role:'lopater',action:'tab_line',allowed:true},
 {role:'lopater',action:'action_load',allowed:true},
 {role:'lopater',action:'tab_admin',allowed:false},
 {role:'foreman',action:'tab_line',allowed:true},
 {role:'foreman',action:'action_load',allowed:false}];
const build=()=>buildSparkAccessProjection({users,permissions,generation:GEN,sourceSequence:7});
test('ACLs contain only each Auth UID profile and server-derived permissions',()=>{
 const rows=build(),a=rows.find(x=>x.uid==='operatorA'),
  b=rows.find(x=>x.uid==='operatorB'),c=rows.find(x=>x.uid==='engineerA');
 assert.equal(rows.length,3);
 assert.equal(a.active,true);
 assert.equal(a.lineRead,true);
 assert.deepEqual(a.permissions.actions,['action_load']);
 assert.equal(a.profile.email,'a@example.com');
 assert.equal(a.profile.uid,a.uid);
 assert.equal(a.permissions.tabs.includes('admin'),false);
 assert.equal(b.active,false);
 assert.equal(b.lineRead,false);
 assert.deepEqual(b.permissions,{tabs:[],actions:[]});
 assert.equal(c.active,true);
 assert.equal(c.lineRead,true);
 assert.equal(c.permissions.actions.includes('action_load'),false);
 assert.ok(rows.every(x=>x.generation===GEN&&x.sourceSequence===7&&
  x.projectId==='samosval-offline'&&x.workspaceId==='main_workspace'));
});
test('only the NAS owns the ACL document path; it can never choose a client UID',()=>{
 const r=sparkAccessRef({doc:path=>({path})},GEN,'operatorA');
 assert.equal(r.path,'samosval_test_replica/v1/access_'+GEN+'/operatorA');
 for(const bad of ['../admin','',123,'user/a']){
  assert.throws(()=>sparkAccessRef({doc:path=>({path})},GEN,bad),/spark-access-invalid-path/);
 }
 assert.throws(()=>sparkAccessRef({doc:path=>({path})},'fakegen','operatorA'),
  /spark-access-invalid-path/);
});
test('snapshot projection only trusts mirrored SQL app_users and role_permissions',()=>{
 const snapshot={sequence:7,rows:[
  ...users.map(x=>({table:'app_users',envelope:{rowJson:JSON.stringify(x)}})),
  ...permissions.map(x=>({table:'role_permissions',envelope:{rowJson:JSON.stringify(x)}})),
  {table:'line_logs',envelope:{rowJson:'{"id":"test"}'}}
 ]};
 assert.deepEqual(accessRowsFromMirrorSnapshot(snapshot,GEN),build());
 snapshot.rows[0].envelope.rowJson='garbage';
 assert.throws(()=>accessRowsFromMirrorSnapshot(snapshot,GEN),/spark-access-row-invalid/);
});
test('duplicate identities, invalid role, and oversized permission lists fail closed',()=>{
 assert.throws(()=>buildSparkAccessProjection({users:[users[0],users[0]],
  permissions,generation:GEN,sourceSequence:7}),/spark-access-invalid-user/);
 assert.throws(()=>buildSparkAccessProjection({users:[{...users[0],role:'unknown'}],
  permissions,generation:GEN,sourceSequence:7}),/spark-access-invalid-user/);
 assert.throws(()=>buildSparkAccessProjection({users,permissions:[{role:'lopater',
  action:'action_load',allowed:'true'}],generation:GEN,sourceSequence:7}),
  /spark-access-invalid-role-permission/);
});
test('app user changes update own UID; role changes update every matching account',()=>{
 const p=build();
 const changed=[
  {table_name:'app_users',row_key:{uid:'operatorB'}},
  {table_name:'role_permissions',row_key:{role:'lopater',action:'action_load'}}
 ];
 assert.equal(needsSparkAccessRefresh(changed),true);
 assert.deepEqual(affectedSparkAccessUids(changed,p),['operatorA','operatorB']);
 assert.deepEqual(affectedSparkAccessUids([
  {table_name:'app_users',row_key:{uid:'userDeleted'}}],p),['userDeleted']);
 assert.deepEqual(affectedSparkAccessUids([
  {table_name:'identity_state',row_key:{id:1}}],p),p.map(x=>x.uid).sort());
 assert.equal(needsSparkAccessRefresh([{table_name:'line_logs',row_key:{id:'l'}}]),false);
});
test('transaction-consistent local PostgreSQL ACL read carries source high-water',async()=>{
 const seen=[];
 const pool={connect:async()=>({
  query:async(sql)=>{
   seen.push(sql);
   if(sql.includes('last_sequence::text'))return {rows:[{n:'19'}]};
   if(sql.includes('FROM app_users'))return {rows:users.map(value=>({value}))};
   if(sql.includes('FROM role_permissions'))return {rows:permissions.map(value=>({value}))};
   return {rows:[]};
  },
  release:()=>seen.push('release')
 })};
 const x=await collectSparkAccessFromPostgres(pool,GEN);
 assert.equal(x.sourceSequence,19);
 assert.equal(x.projection.length,3);
 assert.ok(x.projection.every(r=>r.sourceSequence===19));
 assert.equal(seen[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.ok(seen.includes('COMMIT'));
 assert.equal(seen.at(-1),'release');
});
