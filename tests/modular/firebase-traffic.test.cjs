/* Regression tests: safe, no Firebase credentials/network/emulator needed. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../test-app/source/features/firebase-traffic-hook.js'),'utf8');
class Query {
  constructor(path){this.path=path||'workspaces/PRIVATE/logs';this.callback=null;}
  get(){return Promise.resolve({size:3,metadata:{fromCache:false},docChanges(){return[];}});}
  onSnapshot(callback){this.callback=callback;return()=>{this.callback=null;};}
}
class DocumentReference {
  constructor(path){this.path=path||'workspaces/PRIVATE/logs/SECRET';}
  get(){return Promise.resolve({exists:true,metadata:{fromCache:false}});}
  onSnapshot(callback){this.callback=callback;return()=>{this.callback=null;};}
  set(){return Promise.resolve();}
  update(){return Promise.resolve();}
  delete(){return Promise.resolve();}
}
class CollectionReference extends Query{
  add(){return Promise.resolve(new DocumentReference());}
}
class WriteBatch{
  set(){return this;}update(){return this;}delete(){return this;}commit(){return Promise.resolve();}
}
class Transaction{
  get(){return Promise.resolve({exists:true,metadata:{fromCache:false}});}
  set(){return this;}update(){return this;}delete(){return this;}
}
class Firestore{runTransaction(callback){return Promise.resolve(callback(new Transaction()));}}
function firestore(){}
Object.assign(firestore,{Query,DocumentReference,CollectionReference,WriteBatch,Transaction,Firestore});
const listeners={};
const window={
  firebase:{firestore},dispatchEvent(){},addEventListener(n,f){listeners[n]=f;}
};
const context={window,document:{addEventListener(){}},CustomEvent:class {constructor(type){this.type=type;}},performance:{now:()=>100},Intl,Date,Promise,Symbol,Set,Map,WeakMap,Object,Array,JSON,Number,String,Math,console,setTimeout(){return 0;},clearTimeout(){},indexedDB:undefined};
vm.runInNewContext(source,context,{filename:'firebase-traffic-hook.js'});
const T=window.FirebaseTraffic;
async function main(){
 assert.ok(T,'Recorder installed');
 assert.equal(T.dayMsk(Date.parse('2026-10-29T06:59:59Z')),'2026-10-28');
 assert.equal(T.dayMsk(Date.parse('2026-10-29T07:00:00Z')),'2026-10-29');
 assert.equal(T.quotaDay(Date.parse('2026-01-01T07:59:59Z')),'2025-12-31');
 assert.equal(T.quotaDay(Date.parse('2026-01-01T08:00:00Z')),'2026-01-01');
 const q=new Query(),doc=new DocumentReference();
 await q.get();await doc.get();await doc.set({name:'private'});await doc.update({hours:5});await doc.delete();
 const stop=q.onSnapshot(()=>{});
 assert.equal(T.data.active,1);
 q.callback({size:2,metadata:{fromCache:true},docChanges(){return[{type:'added'}];}});
 q.callback({size:3,metadata:{fromCache:false},docChanges(){return[{type:'modified'},{type:'removed'}];}});
 stop();assert.equal(T.data.active,0);
 const batch=new WriteBatch();batch.set(doc,{}).update(doc,{}).delete(doc);await batch.commit();
 const f=new Firestore();await f.runTransaction(async tx=>{await tx.get(doc);tx.set(doc,{x:1});tx.delete(doc);return true;});
 const day=T.data.days[T.todayMsk()];
 assert.ok(day);
 assert.equal(day.reads,3+1+1+1,'query 3 + doc 1 + listener change 1 + transaction get 1');
 assert.equal(day.cached,2);
 assert.equal(day.writes,5,'doc set/update + batch set/update + transaction set');
 assert.equal(day.deletes,3,'doc delete + batch delete + transaction delete');
 assert.ok(T.hooks.includes('query.onSnapshot'));
 const json=JSON.stringify(T.data);
 assert.equal(json.includes('SECRET'),false,'Never log doc ids');
 assert.equal(json.includes('PRIVATE'),false,'Never log workspace ids');
 console.log('FIREBASE_TRAFFIC_TEST_OK hooks='+T.hooks.length+' reads='+day.reads);
}
main().catch(e=>{console.error(e);process.exitCode=1;});