// Minimal dependency-free Chromium CDP driver (Node 26 native WebSocket).
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
export async function chromium(base, executable){
 const child=spawn(executable,['--headless','--no-sandbox','--ignore-certificate-errors','--disable-background-networking','--disable-dev-shm-usage','--host-resolver-rules=MAP samosval-test.iluxa.pro 127.0.0.1, MAP * ~NOTFOUND','--user-data-dir='+base+'/chrome','--remote-debugging-port=19222','about:blank'],{stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',()=>{});
 let target;
 for(let i=0;i<150;i++){try{target=(await (await fetch('http://127.0.0.1:19222/json/list')).json()).find(t=>t.type==='page');if(target)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!target){child.kill();throw Error('Chromium CDP readiness timeout');}
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 let seq=0;const pending=new Map(),errors=[],network=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}else{
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+(m.params.exceptionDetails.exception?.description||''));
  if(m.method==='Network.requestWillBeSent')network.push({url:m.params.request.url,method:m.params.request.method});
 }};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},45000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
 await send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__qaRejections=[];addEventListener('unhandledrejection',e=>__qaRejections.push(String(e.reason?.message||e.reason)));"});
 return {send,evaluate,errors,network,async close(){writeFileSync(base+'/network.json',JSON.stringify(network,null,2));writeFileSync(base+'/pageerrors.json',JSON.stringify(errors,null,2));try{await send('Browser.close');}catch{}ws.close();child.kill();}};
}
export async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
