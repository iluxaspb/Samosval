// Firestore Emulator only. An authenticated phone can promote only a
// SQL016-certified generation AFTER a server-time lease expiry. All testing
// is against demo-samosval-spark-ci; no live Rules or project is touched.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {initializeTestEnvironment,assertSucceeds,assertFails}=
 require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,updateDoc,runTransaction}=
 require('firebase/firestore');
const GEN='0123456789abcdef01234567',ROOT='samosval_test_replica/v1',
 OWNER='samosval_test_replica/write_owner',ACCESS=ROOT+'/access_'+GEN;
const HASH='a'.repeat(64),SNAP='b'.repeat(64),SEQ=45;
let env,alice,bob;
before(async()=>{
 env=await initializeTestEnvironment({
  projectId:'demo-samosval-spark-ci',
  firestore:{host:'127.0.0.1',port:8089}
 });
 alice=env.authenticatedContext('operatorA').firestore();
 bob=env.authenticatedContext('operatorB').firestore();
});
after(async()=>{await env?.cleanup();});
async function trusted(update){
 return env.withSecurityRulesDisabled(async ctx=>{
  const db=ctx.firestore();
  await update(db);
 });
}
const certificate={
 protocol:2,writerGate:'sql016',generation:GEN,epoch:7,
 sequence:SEQ,hash:HASH,snapshotHash:SNAP,documents:43
};
async function reset(){
 await env.clearFirestore();
 await trusted(async db=>{
  await setDoc(doc(db,ROOT),{
   protocol:1,channel:'test',writer:'synology',projectId:'samosval-offline',
   generation:GEN,lastSequence:SEQ,typedSequence:SEQ,
   typedProtocol:1,accessProtocol:1,readyForFailover:true,
   hash:HASH,promotionProof:certificate
  });
  await setDoc(doc(db,OWNER),{
   protocol:1,projectId:'samosval-offline',owner:'synology',
   holder:'nas_live_worker',generation:GEN,epoch:7,
   leaseUntil:Date.now()-120000,observedSequence:SEQ,
   reserveSequence:0,pending:{}
  });
  for(const uid of ['operatorA','operatorB'])
   await setDoc(doc(db,ACCESS+'/'+uid),{
    protocol:1,projectId:'samosval-offline',source:'nas-spark-mirror',
    generation:GEN,workspaceId:'main_workspace',uid,
    sourceSequence:SEQ,active:true,lineRead:true,
    profile:{uid,status:'active',deleted:false,role:'lopater'},
    permissions:{tabs:['line'],actions:['action_arrive','action_load']}
   });
 });
}
beforeEach(reset);
const promotion=db=>updateDoc(doc(db,OWNER),{
 owner:'firebase',holder:'firebase_reserve',epoch:8
});
test('expired lease and SQL016-sealed exact generation permit one phone promotion',async()=>{
 await assertSucceeds(promotion(alice));
 const o=(await getDoc(doc(alice,OWNER))).data();
 assert.equal(o.owner,'firebase');
 assert.equal(o.holder,'firebase_reserve');
 assert.equal(o.epoch,8);
 assert.deepEqual(o.pending,{});
 assert.equal(o.observedSequence,SEQ);
});
test('two operators racing to promote the same owner epoch cannot both win',async()=>{
 const settled=await Promise.allSettled([promotion(alice),promotion(bob)]);
 assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await getDoc(doc(alice,OWNER))).data().epoch,8);
});
test('active NAS lease, outstanding writes and unreplicated SQL head reject promotion',async()=>{
 for(const change of [
  db=>updateDoc(doc(db,OWNER),{leaseUntil:Date.now()+60000}),
  db=>updateDoc(doc(db,OWNER),{pending:{'permitA':{epoch:7,until:Date.now()+5000}}}),
  db=>updateDoc(doc(db,OWNER),{observedSequence:SEQ+1}),
  db=>updateDoc(doc(db,ROOT),{lastSequence:SEQ-1})
 ]){
  await reset();
  await trusted(change);
  await assertFails(promotion(alice));
  assert.equal((await getDoc(doc(alice,OWNER))).data().owner,'synology');
 }
});
test('forged or stale SQL016 readiness, missing ACL and revoked roles all fail closed',async()=>{
 for(const change of [
  db=>updateDoc(doc(db,ROOT),{readyForFailover:false}),
  db=>updateDoc(doc(db,ROOT),{promotionProof:{...certificate,epoch:6}}),
  db=>updateDoc(doc(db,ROOT),{promotionProof:{...certificate,hash:'c'.repeat(64)}}),
  db=>updateDoc(doc(db,ROOT),{promotionProof:{...certificate,writerGate:'legacy'}}),
  db=>updateDoc(doc(db,ROOT),{typedSequence:SEQ-1}),
  db=>updateDoc(doc(db,ACCESS+'/operatorA'),{active:false}),
  db=>updateDoc(doc(db,ACCESS+'/operatorA'),{permissions:{tabs:[],actions:[]}}),
  db=>updateDoc(doc(db,ACCESS+'/operatorA'),{sourceSequence:SEQ+1})
 ]){
  await reset();
  await trusted(change);
  await assertFails(promotion(alice));
  assert.equal((await getDoc(doc(alice,OWNER))).data().owner,'synology');
 }
});
test('client cannot alter metadata, grant, live epoch or any extra owner field',async()=>{
 await assertFails(updateDoc(doc(alice,ROOT),{readyForFailover:true}));
 await assertFails(updateDoc(doc(alice,ACCESS+'/operatorA'),{active:true}));
 await assertFails(updateDoc(doc(alice,OWNER),{
  owner:'firebase',holder:'firebase_reserve',epoch:8,pending:{fake:1}
 }));
 await assertFails(updateDoc(doc(alice,OWNER),{owner:'firebase',epoch:8}));
 await assertFails(updateDoc(doc(alice,OWNER),{
  owner:'firebase',holder:'firebase_reserve',epoch:9
 }));
 await trusted(db=>updateDoc(doc(db,OWNER),{owner:'reconciling',epoch:8}));
 await assertFails(promotion(alice));
});
test('only the signed-in UID with its own active projected role can promote',async()=>{
 const stranger=env.authenticatedContext('no_access').firestore();
 await assertFails(promotion(stranger));
 const anonymous=env.unauthenticatedContext().firestore();
 await assertFails(promotion(anonymous));
 // A user cannot impersonate another UID by editing its grant.
 await assertFails(updateDoc(doc(bob,ACCESS+'/operatorA'),{uid:'operatorB'}));
});
test('the phone transaction receives a verified Firebase owner without privileged credentials',async()=>{
 const {createSparkClientPromoter}=await import('../../test-app/synology/spark-client-promoter.mjs');
 const user={uid:'operatorA'};
 const web={
  app:{options:{projectId:'samosval-offline'}},
  doc:path=>doc(alice,path),
  runTransaction:fn=>runTransaction(alice,tx=>fn({
   get:async ref=>{
    const s=await tx.get(ref);
    return {exists:s.exists(),data:()=>s.data()};
   },update:(ref,changes)=>tx.update(ref,changes)
  }))
 };
 const ownerReader={async readOwner(){
  const [m,o]=await Promise.all([getDoc(doc(alice,ROOT)),getDoc(doc(alice,OWNER))]);
  const md=m.data(),od=o.data();
  return {owner:od.owner,epoch:od.epoch,generation:od.generation,
   projectId:'samosval-offline',confirmedSequence:md.lastSequence,
   leaseUntil:od.leaseUntil,
   promotionCertified:od.owner==='synology'&&md.readyForFailover&&
    md.promotionProof?.epoch===od.epoch,
   readyForFailover:od.owner==='firebase'&&md.readyForFailover};
 }};
 const promoter=createSparkClientPromoter({
  firestore:web,getUser:()=>user,ownerReader,clock:Date.now
 });
 const first=await promoter.tryPromote();
 assert.equal(first.promoted,true);
 assert.equal(first.epoch,8);
 assert.deepEqual(await promoter.tryPromote(),{promoted:false,reason:'not-certified'});
 promoter.stop();
});
