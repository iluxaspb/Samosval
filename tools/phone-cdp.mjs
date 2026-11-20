// Minimal dependency-free Chromium CDP driver (Node 26 native WebSocket).
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
// Node owns these records: document teardown never resets a cursor or evidence.
// Consume protocol metadata only; never retain bodies, headers, URLs or reasons.
export function cdpErrorCollector(){
 const auth=[],exceptions=[],requests=new Map(),documents=new Map();
 const documentId=loader=>{if(!documents.has(loader))documents.set(loader,documents.size+1);return documents.get(loader);};
 const copy=rows=>rows.map(row=>({...row}));
 const failures=start=>auth.slice(start).filter(row=>row.status>=400||row.transportFailure);
 return {
  authMark:()=>auth.length,
  authFailuresSince:start=>copy(failures(start)),
  get errors(){return copy(exceptions);},
  get rejections(){return copy(exceptions.filter(row=>row.kind==='unhandled-rejection'));},
  snapshot:()=>({auth:copy(auth),exceptions:copy(exceptions)}),
  assertAuthSince(start){if(failures(start).length)throw Error('QA auth failure: '+JSON.stringify(failures(start)));},
  assertNoExceptions(){if(exceptions.length)throw Error('QA browser exception: '+JSON.stringify(exceptions));},
  event(method,params){
   if(method==='Runtime.exceptionThrown'){
    // V8 reports unhandled Promise rejections here even if the old document
    // disappears before a page-side listener or the next evaluate can run.
    exceptions.push({sequence:exceptions.length+1,kind:params.exceptionDetails?.text==='Uncaught (in promise)'?'unhandled-rejection':'page-exception'});
   }
   if(method==='Network.requestWillBeSent'){
    // Redirect responses belong to the preceding request, before reusing its ID.
    const previous=requests.get(params.requestId);
    if(previous&&params.redirectResponse)previous.status=params.redirectResponse.status;
    requests.delete(params.requestId);
    const url=new URL(params.request.url);
    if(!/^\/api\/v1\/auth\/[a-z-]+$/.test(url.pathname))return;
    const route=['login','register','refresh','logout','session','reset-password'].includes(url.pathname.split('/').at(-1))?url.pathname:'/api/v1/auth/other';
    const row={sequence:auth.length+1,document:documentId(params.loaderId),route,status:null};
    auth.push(row);requests.set(params.requestId,row);
   }
   if(method==='Network.responseReceived'){
    const row=requests.get(params.requestId);if(row)row.status=params.response.status;
   }
   if(method==='Network.loadingFailed'){
    const row=requests.get(params.requestId);if(row)row.transportFailure=true;
    requests.delete(params.requestId);
   }
   if(method==='Network.loadingFinished')requests.delete(params.requestId);
  }
 };
}
export function isContextLoss(error){
 return error?.code==='QA_CONTEXT_CHANGED'||(error?.code===-32000&&/Cannot find context with specified id|Execution context was destroyed|Cannot find object with given id/.test(error.message));
}
export function cdpLifecycle(){
 let generation=0;const events=[];
 const note=(method,phase)=>{events.push({method,phase,generation});if(events.length>160)events.shift();};
 return {get generation(){return generation;},note,snapshot:()=>events.slice(),event(method){
  if(['Runtime.executionContextsCleared','Runtime.executionContextDestroyed','Page.frameNavigated'].includes(method))generation++;
  if(method.startsWith('Runtime.executionContext')||method==='Page.frameNavigated')note(method,'event');
 }};
}
export async function evaluateCdp(send,expression,lifecycle=cdpLifecycle()){
 // REPL top-level await supports statement snippets, but may return an
 // unawaited Promise even with awaitPromise:true. Inspect BEFORE serialization.
 const generation=lifecycle.generation;
 const current=()=>{if(generation!==lifecycle.generation)throw Object.assign(Error('QA evaluation document changed'),{code:'QA_CONTEXT_CHANGED'});};
 const command=async(method,params)=>{current();lifecycle.note(method,'start');try{const result=checked(await send(method,params));current();lifecycle.note(method,'ok');return result;}catch(error){lifecycle.note(method,isContextLoss(error)?'context-lost':'failed');throw error;}};
 const checked=result=>{if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result;};
 let r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:false,replMode:true});
 checked(r);
 const objectId=r.result?.objectId;
 if(!objectId)return r.result?.value;
 let failure;
 try{
  if(r.result.subtype==='promise')r=await command('Runtime.awaitPromise',{promiseObjectId:objectId,returnByValue:true});
  else r=await command('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this;}',returnByValue:true});
  checked(r);return r.result?.value;
 }catch(error){failure=error;throw error;}finally{
  // Never send an old document's handle, and never mask a product exception.
  if(generation===lifecycle.generation&&!isContextLoss(failure))try{await command('Runtime.releaseObject',{objectId});}catch(error){if(!failure)throw error;}
 }
}
// Only explicitly read-only navigation probes may retry. Actions are never replayed.
export async function navigationProbe(evaluate,expression){try{return await evaluate(expression);}catch(error){if(isContextLoss(error))return false;throw error;}}
export async function chromium(base, executable){
 const child=spawn(executable,['--headless','--no-sandbox','--ignore-certificate-errors','--disable-background-networking','--disable-dev-shm-usage','--host-resolver-rules=MAP samosval-test.iluxa.pro 127.0.0.1, MAP * ~NOTFOUND','--user-data-dir='+base+'/chrome','--remote-debugging-port=19222','about:blank'],{stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',()=>{});
 let target;
 for(let i=0;i<150;i++){try{target=(await (await fetch('http://127.0.0.1:19222/json/list')).json()).find(t=>t.type==='page');if(target)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!target){child.kill();throw Error('Chromium CDP readiness timeout');}
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 let seq=0;const pending=new Map(),network=[],lifecycle=cdpLifecycle(),collector=cdpErrorCollector();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error.message),{code:m.error.code,method:p.method})):p.resolve(m.result);}}else{
  lifecycle.event(m.method);
  collector.event(m.method,m.params);
  if(m.method==='Network.requestWillBeSent')network.push({url:m.params.request.url,method:m.params.request.method});
 }};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},45000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=expression=>evaluateCdp(send,expression,lifecycle);
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
 return {send,evaluate,collector,get errors(){return collector.errors;},network,diagnostic:()=>lifecycle.snapshot(),async close(){writeFileSync(base+'/cdp-lifecycle.json',JSON.stringify(lifecycle.snapshot(),null,2));writeFileSync(base+'/network.json',JSON.stringify(network,null,2));writeFileSync(base+'/pageerrors.json',JSON.stringify(collector.errors,null,2));writeFileSync(base+'/auth-http.json',JSON.stringify(collector.snapshot().auth,null,2));writeFileSync(base+'/cdp-errors.json',JSON.stringify(collector.snapshot(),null,2));try{await send('Browser.close');}catch{}ws.close();child.kill();}};
}
export async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
