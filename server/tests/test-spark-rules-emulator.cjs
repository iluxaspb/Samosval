// Runs only against local Firestore Emulator. Never connects to real Firebase.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {initializeTestEnvironment,assertSucceeds,assertFails}=
 require('@firebase/rules-unit-testing');
const {doc,collection,query,where,limit,getDoc,getDocs,setDoc,updateDoc}=
 require('firebase/firestore');

const GEN='0123456789abcdef01234567';
const ROOT='samosval_test_replica/v1';
const OWNER='samosval_test_replica/write_owner';
const ACL=ROOT+'/access_'+GEN;
const ROWS=ROOT+'/rows_'+GEN;
let env,admin,operator,other;
before(async()=>{
 env=await initializeTestEnvironment({
  projectId:'demo-samosval-spark-ci',
  firestore:{host:'127.0.0.1',port:8089}
 });
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async context=>{
  const f=context.firestore();
  await setDoc(doc(f,ROOT),{protocol:1,channel:'test',writer:'synology',
   projectId:'samosval-offline',generation:GEN,
   hash:'a'.repeat(64),lastSequence:22,readyForFailover:false});
  await setDoc(doc(f,OWNER),{protocol:1,projectId:'samosval-offline',generation:GEN,
   owner:'synology',epoch:2,holder:'nas_writer_A',
   observedSequence:22,leaseUntil:1900000000000,pending:{}});
  await setDoc(doc(f,ACL+'/operatorA'),{
   protocol:1,source:'nas-spark-mirror',projectId:'samosval-offline',
   workspaceId:'main_workspace',generation:GEN,uid:'operatorA',
   sourceSequence:22,active:true,lineRead:true,
   permissions:{tabs:['line'],actions:['action_load']},
   profile:{uid:'operatorA',status:'active',role:'lopater',deleted:false}
  });
  await setDoc(doc(f,ACL+'/operatorB'),{
   protocol:1,source:'nas-spark-mirror',projectId:'samosval-offline',
   workspaceId:'main_workspace',generation:GEN,uid:'operatorB',
   sourceSequence:22,active:false,lineRead:false,
   permissions:{tabs:[],actions:[]},
   profile:{uid:'operatorB',status:'disabled',role:'viewer',deleted:false}
  });
  await setDoc(doc(f,ROWS+'/line_logs_test'),{
   table:'line_logs',keyJson:'{"workspace_id":"main_workspace"}',
   rowJson:'{"id":"load1"}',appliedSequence:22
  });
  await setDoc(doc(f,ROWS+'/app_users_test'),{
   table:'app_users',keyJson:'{"uid":"operatorA"}',
   rowJson:'{"email":"secret@example.com"}',appliedSequence:22
  });
 });
 operator=env.authenticatedContext('operatorA').firestore();
 other=env.authenticatedContext('operatorB').firestore();
 admin=env.unauthenticatedContext().firestore();
});
after(async()=>{if(env)await env.cleanup();});
test('unauthenticated clients cannot inspect mirror or owner',async()=>{
 await assertFails(getDoc(doc(admin,ROOT)));
 await assertFails(getDoc(doc(admin,OWNER)));
 await assertFails(getDocs(query(collection(admin,ROWS),where('table','==','line_logs'),limit(301))));
});
test('signed-in clients can inspect public coordinator and their own ACL',async()=>{
 await assertSucceeds(getDoc(doc(operator,ROOT)));
 await assertSucceeds(getDoc(doc(operator,OWNER)));
 const acl=await assertSucceeds(getDoc(doc(operator,ACL+'/operatorA')));
 assert.equal(acl.data().active,true);
 await assertFails(getDoc(doc(operator,ACL+'/operatorB')));
 await assertFails(getDocs(collection(operator,ACL)));
});
test('active line operator sees only explicitly queried line tables',async()=>{
 const data=await assertSucceeds(getDocs(query(collection(operator,ROWS),
  where('table','==','line_logs'),limit(301))));
 assert.equal(data.size,1);
 await assertFails(getDoc(doc(operator,ROWS+'/app_users_test')));
 await assertFails(getDocs(query(collection(operator,ROWS),
  where('table','==','app_users'),limit(301))));
 await assertFails(getDocs(query(collection(operator,ROWS),limit(301))));
 await assertFails(getDocs(query(collection(operator,ROWS),
  where('table','==','line_logs'))));
});
test('disabled user sees their own access decision but no line documents',async()=>{
 const acl=await assertSucceeds(getDoc(doc(other,ACL+'/operatorB')));
 assert.equal(acl.data().active,false);
 await assertFails(getDocs(query(collection(other,ROWS),
  where('table','==','line_logs'),limit(301))));
 await assertFails(getDoc(doc(other,ROWS+'/line_logs_test')));
});
test('clients cannot change replica metadata, coordinator, ACL or SQL rows',async()=>{
 await assertFails(updateDoc(doc(operator,ROOT),{readyForFailover:true}));
 await assertFails(updateDoc(doc(operator,OWNER),{owner:'firebase'}));
 await assertFails(updateDoc(doc(operator,ACL+'/operatorA'),{lineRead:true}));
 await assertFails(setDoc(doc(operator,ROWS+'/new_line'),{
  table:'line_logs',keyJson:'{}',rowJson:'{}',appliedSequence:23
 }));
 await assertFails(updateDoc(doc(operator,ROWS+'/line_logs_test'),{rowJson:'{"forged":true}'}));
});
test('source-side revocation immediately removes read access',async()=>{
 const beforeRevoke=await assertSucceeds(getDoc(doc(operator,ROWS+'/line_logs_test')));
 assert.equal(beforeRevoke.exists(),true);
 await env.withSecurityRulesDisabled(async ctx=>{
  await updateDoc(doc(ctx.firestore(),ACL+'/operatorA'),{active:false,lineRead:false});
 });
 await assertFails(getDoc(doc(operator,ROWS+'/line_logs_test')));
 await assertFails(getDocs(query(collection(operator,ROWS),
  where('table','==','line_logs'),limit(301))));
});
