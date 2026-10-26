const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const read = file => fs.readFileSync('test-app/src/' + file, 'utf8');
const queueSource = read('core/11-max-queue.js'), retrySource = read('features/max-retry.js'), plateSource = read('features/max-plate-notifications.js');
const legacy = JSON.stringify([{type:'text',text:'PRODUCTION PRIVATE'},{type:'document',base64:'OLD PDF'}]);
function fixture() {
  const storage = new Map([['dt_max_queue',legacy],['samosval_offline_v1_live','PRESERVE']]), requests = [], timers = new Map();
  const c = {console:{log(){},warn(){},error:console.error}, firebaseConfig:{projectId:'samosval-offline'}, WORKSPACE_ID:'main_workspace', location:{pathname:'/index-test.html'}, currentUid:'user-a', currentUserStatus:'active',
    appConfig:{maxEnabled:true,maxUrl:'https://relay.invalid',maxToken:'fixture',maxChatId:'test-chat',maxPlateMode:'png'},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true};}, AbortController,
    setTimeout:(fn,ms)=>{const key=Symbol();timers.set(key,{fn,ms});if(ms>=1000&&ms<30000)queueMicrotask(fn);return key;},clearTimeout:key=>timers.delete(key),
    showToastEl(){},showError(){},appNotice(){},canAdmin:()=>true,findTruck:()=>null,
    document:{querySelector:()=>null,getElementById:()=>null,readyState:'complete'},
  };
  c.window=c;vm.createContext(c);vm.runInContext(queueSource,c);
  const key = uid => 'dt_max_queue:samosval-offline:main_workspace:/index-test.html:'+uid;
  const stamp = (kind,uid='user-a') => `dt_max_last_${kind}:samosval-offline:main_workspace:/index-test.html:${uid}:https://relay.invalid`;
  return {c,storage,requests,timers,key,stamp};
}
(async()=>{
  const f=fixture();
  f.storage.set(f.key('user-a'),JSON.stringify([{id:'a',type:'text',text:'A',tries:0},{id:'pdf',type:'document',base64:'old'},null,{type:'image',text:'bad'}]));
  f.c.loadMaxQueue();assert.deepEqual(JSON.parse(f.storage.get(f.key('user-a'))).map(x=>x.id),['a']);
  assert.equal(f.storage.get('dt_max_queue'),legacy,'test must not consume or erase unscoped production queue');
  assert.equal(f.storage.get('samosval_offline_v1_live'),'PRESERVE');
  assert.equal(await f.c.sendMaxOnce({type:'document',base64:'forbidden'}),'drop');assert.equal(f.requests.length,0);
  assert.equal(await f.c.sendMaxOnce({type:'text',text:'Arrival',image:'forbidden'}),'ok');
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{chat_id:'test-chat',text:'Arrival'});
  f.c.fetch=async()=>{throw new Error('offline');};assert.equal(await f.c.sendMaxOnce({type:'text',text:'Arrival'}),'retry','network interruption must retry');

  const q=fixture();q.storage.set(q.key('user-a'),JSON.stringify([{id:'a',type:'text',text:'Private A',tries:0}]));q.storage.set(q.key('user-b'),JSON.stringify([{id:'b',type:'text',text:'Private B',tries:0}]));
  let finish;
  q.c.fetch=async(url,options)=>{q.requests.push({url,options});return await new Promise(r=>{finish=r;});};
  q.c.loadMaxQueue();const sendA=q.c.runMaxQueue();await Promise.resolve();
  q.c.currentUid='user-b';q.c.loadMaxQueue();finish({ok:true});await sendA;
  assert.equal(q.requests.length,1);assert.equal(JSON.parse(q.requests[0].options.body).text,'Private A');
  assert.deepEqual(JSON.parse(q.storage.get(q.key('user-a'))),[],'successful old send is removed from old account');
  assert.equal(JSON.parse(q.storage.get(q.key('user-b')))[0].text,'Private B','in-flight account change cannot delete next user queue');
  q.c.currentUid='';q.c.loadMaxQueue();await q.c.runMaxQueue();assert.equal(q.requests.length,1,'signed out never sends');

  const r=fixture();r.storage.set(r.stamp('success'),String(Date.now()));vm.runInContext(retrySource,r.c);
  assert.equal(await r.c.sendMaxOnce({type:'document',base64:'old'}),'drop');assert.equal(r.requests.length,0);
  await r.c.sendMaxOnce({type:'text',text:'Loading'});assert.equal(r.requests.length,1);assert.deepEqual(JSON.parse(r.requests[0].options.body),{chat_id:'test-chat',text:'Loading'});
  vm.runInContext(plateSource,r.c);
  assert.equal(await r.c.sendMaxOnce({type:'image',text:'old'}),'drop');
  await r.c.sendMaxOnce({type:'text',text:'⚡ Погрузка\n🚛 А123ВС178\nОбъект: пример'});
  const payload=JSON.parse(r.requests[1].options.body);assert.deepEqual(Object.keys(payload).sort(),['chat_id','text']);assert(payload.text.includes('178\u00a0RUS'));assert(payload.text.includes('Объект: пример'));
  assert.equal(r.requests.length,2,'legacy PNG setting cannot trigger capability checks or image messages');

  for(const change of ['account','disabled','config']){
    const w=fixture();let resolveWarmup;
    w.c.fetch=async(url,options)=>{w.requests.push({url,options});return await new Promise(resolve=>{resolveWarmup=resolve;});};
    vm.runInContext(retrySource,w.c);const pending=w.c.sendMaxOnce({type:'text',text:'Secret from user A'});await Promise.resolve();
    if(change==='account')w.c.currentUid='user-b';else if(change==='disabled')w.c.currentUserStatus='disabled';else w.c.appConfig.maxChatId='another-chat';
    resolveWarmup({ok:true});assert.equal(await pending,'retry');assert.equal(w.requests.length,1);assert.equal(w.requests[0].options.method,'GET','no POST after session/config changes during warm-up');
    assert(![...w.timers.values()].some(t=>t.ms===90000),'warm-up timer is always cleared');
  }
  for(const source of [queueSource,retrySource,plateSource])assert(!/enqueueMaxDocument|content_base64|type\s*===\s*'document'/.test(source));
  console.log('PASS TEST MAX: text-only base/retry/plate; old PDF migration; production/user isolation; network retry; in-flight queue/auth/warm-up changes; timers cleaned');
})().catch(e=>{console.error(e);process.exitCode=1;});
