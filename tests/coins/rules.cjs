const fs = require('node:fs');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, setDoc, getDoc, getDocs, collection, query, where, updateDoc, deleteDoc} = require('firebase/firestore');
(async () => {
  const env = await initializeTestEnvironment({projectId:'demo-coin-rules', firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore-coins-test.rules','utf8')}});
  try {
    await env.withSecurityRulesDisabled(async c => {
      for (const [uid,role,status] of [['admin','admin','active'],['operator','lopater','active'],['other','lopater','active'],['disabled','lopater','disabled']])
        await setDoc(doc(c.firestore(),'users',uid),{email:uid+'@example.com',role,status});
    });
    const db = uid => env.authenticatedContext(uid,{email:uid+'@example.com'}).firestore();
    const admin=db('admin'), operator=db('operator'), other=db('other');
    const path='workspaces/main_workspace/coinTransactions';
    const row={eventType:'game_coin_adjustment',amount:25,targetUid:'operator',targetEmail:'operator@example.com',targetName:'Operator',reason:'Compensation',timestamp:Date.now(),userEmail:'admin@example.com',userName:'Admin',createdByEmail:'admin@example.com',createdByUid:'admin',text:'Award',timeStr:'12:00'};
    await assertSucceeds(setDoc(doc(admin,path,'award'),row));
    await assertSucceeds(getDoc(doc(operator,path,'award')));
    await assertSucceeds(getDocs(query(collection(operator,path),where('targetUid','==','operator'))));
    await assertSucceeds(getDocs(collection(admin,path)));
    await assertFails(getDocs(collection(operator,path)));
    await assertFails(getDoc(doc(other,path,'award')));
    await assertFails(getDoc(doc(db('disabled'),path,'award')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),path,'award')));
    await assertFails(setDoc(doc(operator,path,'forged'),row));
    for (const amount of [-1,0,1.5,10001]) await assertFails(setDoc(doc(admin,path,'invalid'),{...row,amount}));
    await assertFails(setDoc(doc(admin,path,'invalid'),{...row,reason:'x'}));
    await assertFails(setDoc(doc(admin,path,'invalid'),{...row,createdByUid:'operator'}));
    await assertFails(setDoc(doc(admin,path,'invalid'),{...row,targetEmail:'other@example.com'}));
    await assertFails(setDoc(doc(admin,path,'invalid'),{...row,targetUid:'missing'}));
    await assertFails(setDoc(doc(admin,path,'invalid'),{...row,targetUid:'disabled',targetEmail:'disabled@example.com'}));
    await assertFails(updateDoc(doc(admin,path,'award'),{amount:99}));
    await assertFails(deleteDoc(doc(admin,path,'award')));
    await assertSucceeds(setDoc(doc(admin,'workspaces/main_workspace/trucks/test'),{number:'test'}));
    await assertSucceeds(getDoc(doc(operator,'workspaces/main_workspace/trucks/test')));
    console.log('PASS: coin rules compilation, awards, recipient queries, role isolation, validation, immutability, existing shared access');
  } finally {await env.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
