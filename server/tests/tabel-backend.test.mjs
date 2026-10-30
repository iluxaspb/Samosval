import test from 'node:test';
import assert from 'node:assert/strict';
import {storageScope,tableRemote,sameTableSession} from '../../test-app/tabel-v2/backend.mjs';
import {createTabelRemote} from '../../test-app/synology/tabel-remote.mjs';
import {Store} from '../../test-app/tabel-v2/store.mjs';
const session=(uid='one',origin='https://nas.test',workspaceId='main_workspace')=>({projectId:'samosval-offline',workspaceId,uid,provider:'synology',providerScope:JSON.stringify(['synology',origin,workspaceId,uid])});
const response=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
test('Tabel NAS and Firebase queues stay separate while existing Firebase database names remain unchanged',()=>{
  const firebase={projectId:'samosval-offline',workspaceId:'main_workspace',uid:'one'};
  assert.equal(storageScope(firebase),'samosval-offline_main_workspace_one');
  const nas=storageScope(session());for(const other of [firebase,session('two'),session('one','https://other.test'),session('one','https://nas.test','other')])assert.notEqual(storageScope(other),nas);
});
test('Tabel validates NAS owner/workspace/origin and treats changed or invalid sessions as different',()=>{
  for(const other of [{...session(),uid:'other'},{...session(),workspaceId:'other'},{...session(),providerScope:'bad'},session('one','http://nas.test')]){
    assert.throws(()=>storageScope(other));assert.equal(sameTableSession(session(),other),false);
  }
  assert.equal(sameTableSession({...session(),runtimeId:1},{...session(),runtimeId:2}),false);
});
test('Tabel NAS remote factory never initializes Firestore, and missing or invalid factory fails closed',async()=>{
  let callbacks=0;const guard=()=>callbacks++,remote={read(){},list(){},commit(){},watch(){}};
  const host={session,workspace:{collection(){throw Error('Firestore must not be accessed');}},remoteFactory:async savedGuard=>{savedGuard();return remote;}};
  assert.equal(await tableRemote(host,guard),remote);assert.equal(callbacks,1);
  await assert.rejects(tableRemote({session},guard),/не подключён/);
  await assert.rejects(tableRemote({session,remoteFactory:async()=>null},guard),/Некорректный/);
});
test('Tabel lost NAS response preserves ID, formula, colors and dimensions until replay acknowledges it',async()=>{
  const key='site/sheet:book',data={rows:20,cols:10,cells:{A1:{raw:'12.5'},B1:{raw:'=ROUND(A1*2,0)',bg:'#ffff00',color:'#000000'}},widths:{A:120},heights:{1:24}};
  const sent=[];let lost=true;
  const remote=createTabelRemote({baseUrl:'https://nas.test',getIdToken:async()=> 'token',fetchImpl:async(_url,options)=>{
    sent.push(options.body);if(lost){lost=false;throw Error('lost response');}
    return response({operationId:'stable',key,revision:1,data});
  }});
  const store=new Store(storageScope(session()),remote,()=>({uid:'one',name:'Operator'}));store.reloadQuiet=async()=>{};store.persist=async()=>{};
  store.state.records[key]={revision:0,localId:'stable',data:structuredClone(data)};
  store.state.jobs=[{id:'stable',key,data:structuredClone(data),before:{revision:0,data:null},status:'queued',label:'Table',author:{uid:'one'},time:1}];
  await store.flush();assert.equal(store.state.jobs.length,1);assert.equal(store.state.jobs[0].id,'stable');
  await store.flush();assert.equal(store.state.jobs.length,0);assert.equal(sent[0],sent[1]);assert.deepEqual(store.get(key).data,data);assert.equal(store.state.history.length,1);
});
test('Tabel NAS watch delivers deleted global config instead of retaining stale catalog data',async()=>{
  const remote=createTabelRemote({baseUrl:'https://nas.test',getIdToken:async()=> 'token',fetchImpl:async url=>response(url.includes('objectId=')?{rows:[],cursor:null}:{record:{revision:4,data:null}})});
  let stop;const rows=await new Promise((resolve,reject)=>{stop=remote.watch('site','','',value=>{stop();resolve(value);},reject);});
  assert.deepEqual(rows,[['_catalog/config',{revision:4,data:null}],['_defaults/config',{revision:4,data:null}]]);
});
