import assert from 'node:assert/strict';
import {readlinkSync,writeFileSync} from 'node:fs';
import pg from '../server/node_modules/pg/lib/index.js';
import {chromium,until} from './phone-cdp.mjs';
import {ROLES} from '../server/src/identity-rules.mjs';
import {restoreOverlap} from './phone-restore-overlap.mjs';

const base=process.env.PHONE_QA_BASE,origin='https://samosval-test.iluxa.pro:18499';
assert.ok(base?.includes('/browser-fix.')&&process.env.PGHOST===base+'/socket');
assert.match(process.env.PHONE_HOST_NS||'',/^net:\[[0-9]+\]$/);
assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.PHONE_HOST_NS);
const pool=new pg.Pool({host:process.env.PGHOST,database:'samosval_test',user:process.env.POSTGRES_USER});
let browser;const results=[];
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.message});throw e;}finally{writeFileSync(base+'/results.json',JSON.stringify(results,null,2));}}
try{
 await until(async()=>{try{return (await fetch('http://127.0.0.1:18099/health/live')).ok;}catch{return false;}},'API readiness');
 browser=await chromium(base,process.env.PHONE_CHROMIUM);
 const ev=browser.evaluate;
 await browser.send('Page.navigate',{url:origin+'/index-working-test.html'});
 await until(()=>ev("typeof handleLogin==='function' && !!document.getElementById('authEmail')"),'built application');
 async function login(role){
  await ev(`document.getElementById('authEmail').value=${JSON.stringify(role+'@example.test')};document.getElementById('authPassword').value='Synthetic-only-889!';handleLogin()`);
  await until(()=>ev(`typeof nasRuntimeClient!=='undefined' && !!nasRuntimeClient && currentUserRole===${JSON.stringify(role)} && currentUserStatus==='active'`),'real auth '+role);
  await until(()=>ev("state.trucks.some(t=>t.id==='synthetic_truck')"),'line seed');
 }
 await scenario('new Chromium profile, mobile built app, auth and epoch > 0',async()=>{
  assert.equal(await ev('innerWidth'),393);
  assert.equal(await ev('localStorage.getItem("wt_access_token")'),null);
  await login('admin');
  await until(()=>ev("truckPhoneRows instanceof Map"),'phone runtime');
  assert.equal(await ev('nasApiBase()'),origin);
  assert.equal((await pool.query("SELECT restore_epoch FROM workspaces WHERE id='main_workspace'")).rows[0].restore_epoch,'7');
 });
 // All HTTP traffic originates inside Chromium at the synthetic HTTPS origin.
 await ev(`window.qaHTTP=async(path,body,headers={})=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+wtAccessToken(),'Content-Type':'application/json','X-Samosval-Epoch':'7','X-Samosval-Generation':'3',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,text:await r.text()};};`);
 const http=(path,body,headers={})=>ev(`qaHTTP(${JSON.stringify(path)},${body===undefined?'undefined':JSON.stringify(body)},${JSON.stringify(headers)})`);
 await scenario('all roles and eight view/add/call combinations, grant/revoke, pending/disabled/anonymous',async()=>{
  const anon=await ev("fetch('/api/v1/truck-phones').then(r=>r.status)");assert.equal(anon,401);
  // Real password login gives a real middleware identity, not a forged role.
  for(const status of ['pending','disabled']){
   const r=await ev(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${status}@example.test',password:'Synthetic-only-889!'})}).then(async r=>({status:r.status,data:await r.json()}))`);
   if(status==='disabled')assert.ok(r.status>=400);else {assert.ok(r.data.pending===true||!r.data.accessToken);}
  }
  for(const role of ROLES){
   const session=await ev(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${role}@example.test',password:'Synthetic-only-889!'})}).then(r=>r.json())`);
   assert.ok(session.accessToken);
   for(let mask=0;mask<8;mask++){
    if(role!=='admin')for(const [i,action] of ['view_truck_phone','add_truck_phone','call_truck_phone'].entries())await pool.query('UPDATE role_permissions SET allowed=$1 WHERE role=$2 AND action=$3',[!!(mask&(1<<i)),role,action]);
    const h={Authorization:'Bearer '+session.accessToken};
    assert.equal((await http('/api/v1/truck-phones',undefined,h)).status,role==='admin'||mask&1?200:403,role+' read '+mask);
    await pool.query("DELETE FROM truck_phones WHERE workspace_id='main_workspace' AND truck_id='synthetic_empty'");
    assert.equal((await http('/api/v1/truck-phones',{truckId:'synthetic_empty',phone:'+12025550101'},h)).status,role==='admin'||(mask&3)===3?200:403,role+' write '+mask);
   }
   if(role!=='admin')await pool.query("UPDATE role_permissions SET allowed=true WHERE role=$1 AND action IN ('view_truck_phone','add_truck_phone','call_truck_phone')",[role]);
   assert.equal((await http('/api/v1/backups',undefined,{Authorization:'Bearer '+session.accessToken})).status,role==='admin'?200:403);
  }
  await pool.query("DELETE FROM truck_phones WHERE workspace_id='main_workspace' AND truck_id='synthetic_empty'");
 });
 const baseline=(await pool.query("SELECT jsonb_build_object('trucks',(SELECT jsonb_agg(t ORDER BY truck_id) FROM line_trucks t),'logs',(SELECT jsonb_agg(t ORDER BY log_id) FROM line_logs t),'statuses',(SELECT jsonb_agg(t ORDER BY truck_id) FROM line_truck_statuses t),'shifts',(SELECT jsonb_agg(t ORDER BY shift_id) FROM shifts t)) AS data")).rows[0].data;
 await scenario('UI cancel, add, tel safety, reload, Line and directory, queue and domain unchanged',async()=>{
  const queue=await ev('JSON.stringify(offlinePendingOps())');
  await ev("switchTab('trucks');renderGlobalTrucksManage();document.querySelector('#globalTrucksManageList button.truck-phone').click()");
  await until(()=>ev("!!document.querySelector('dialog[open] input[name=phone]')"),'add dialog');
  const posts=browser.network.filter(r=>r.url.endsWith('/api/v1/truck-phones')&&r.method==='POST').length;
  await ev("document.querySelector('dialog[open] [type=button]').click()");
  assert.equal(browser.network.filter(r=>r.url.endsWith('/api/v1/truck-phones')&&r.method==='POST').length,posts);
  await ev("addTruckPhone('synthetic_truck');document.querySelector('dialog input').value='+1 (202) 555-0100';document.querySelector('dialog form').requestSubmit()");
  await until(()=>ev("truckPhoneRows.get('synthetic_truck')==='+12025550100' && !document.querySelector('dialog[open]')"),'saved real API');
  await ev('renderGlobalTrucksManage()');
  assert.ok(await ev("!!document.querySelector('#globalTrucksManageList a[href=\"tel:+12025550100\"]')"));
  // Inspect href only; never navigate/call tel.
  await ev("switchTab('line');renderLine()");
  assert.ok(await ev("!!document.querySelector('.truck-card[data-truck-id=synthetic_truck] a[href=\"tel:+12025550100\"]')"));
  assert.equal(await ev('JSON.stringify(offlinePendingOps())'),queue);
  await browser.send('Page.reload');
  await until(()=>ev("typeof truckPhoneRows!=='undefined' && truckPhoneRows.get('synthetic_truck')==='+12025550100'"),'phone survives actual reload');
  const after=(await pool.query("SELECT jsonb_build_object('trucks',(SELECT jsonb_agg(t ORDER BY truck_id) FROM line_trucks t),'logs',(SELECT jsonb_agg(t ORDER BY log_id) FROM line_logs t),'statuses',(SELECT jsonb_agg(t ORDER BY truck_id) FROM line_truck_statuses t),'shifts',(SELECT jsonb_agg(t ORDER BY shift_id) FROM shifts t)) AS data")).rows[0].data;
  assert.deepEqual(after,baseline);
 });
 await scenario('old read routes exclude phone; stale epoch/generation, provider refusal and foreign fields',async()=>{
  // Page.reload discarded QA globals: install a fresh real-request helper.
  await ev(`window.qaHTTP=async(path,body,headers={})=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+wtAccessToken(),'Content-Type':'application/json','X-Samosval-Epoch':'7','X-Samosval-Generation':'3',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,text:await r.text()};};`);
  for(const path of ['/api/v1/catalog','/api/v1/line/snapshot','/api/v1/archive/snapshot','/api/v1/history','/api/v1/replica/journal']){const r=await http(path);assert.equal(r.status,200,path);assert.equal(r.text.includes('+12025550100'),false,path);}
  const patch={truckId:'synthetic_empty',phone:'+12025550101'};
  assert.equal((await http('/api/v1/truck-phones',patch,{'X-Samosval-Epoch':'6'})).status,409);
  assert.equal((await http('/api/v1/truck-phones',patch,{'X-Samosval-Generation':'2'})).status,409);
  assert.equal((await http('/api/v1/truck-phones',{...patch,brand:'foreign'})).status,400);
  await pool.query("UPDATE server_authority SET provider='firebase' WHERE workspace_id='main_workspace'");
  try{assert.equal((await http('/api/v1/truck-phones',patch)).status,409);}finally{await pool.query("UPDATE server_authority SET provider='ubuntu' WHERE workspace_id='main_workspace'");}
 });
 // Test hooks delay REAL response objects; do not manufacture API success.
 await ev(`window.qaOriginalFetch=window.fetch.bind(window);window.qaHeld=[];window.qaMode='';window.fetch=async(...args)=>{if(String(args[0]).endsWith('/api/v1/truck-phones')&&qaMode){const mode=qaMode;qaMode='';if(mode==='hang')return new Promise(()=>{});const response=await qaOriginalFetch(...args);if(mode==='badbody')return new Response('<not-json>',{status:200,headers:{'Content-Type':'application/json'}});if(mode==='error')return new Response(JSON.stringify({error:'synthetic-fault'}),{status:503,headers:{'Content-Type':'application/json'}});return new Promise((resolve,reject)=>qaHeld.push({resolve,reject,response}));}return qaOriginalFetch(...args);};window.qaRelease=i=>qaHeld[i].resolve(qaHeld[i].response);window.qaReject=i=>qaHeld[i].reject(Error('controlled late transport failure'));window.qaStart=body=>{window.qaOutcome=null;truckPhoneRequest(body).then(()=>qaOutcome='ok',e=>qaOutcome=e.code||e.message);};`);
 // The shared client captures fetchImpl at creation. Recreate through its real
 // factory so controlled transport is used, keeping real auth and middleware.
 await ev(`window.qaOldRuntimeClient=nasRuntimeClient;nasRuntimeClient=(await loadNasSessionClient()).createNasClient({baseUrl:nasApiBase(),getUser:()=>wtAuthUser(),fetchImpl:window.fetch,timeoutMs:15000});await nasRuntimeClient.readSession();`);
 await scenario('GET -> GET reverse order; GET before POST; GET during POST',async()=>{
  await ev("qaMode='hold';qaStart()");await until(()=>ev('qaHeld.length===1'),'first GET held');
  await ev('truckPhoneRequest()');await ev('qaRelease(0)');
  await until(()=>ev('qaOutcome!==null'),'late GET settled');
  assert.notEqual(await ev('qaOutcome'),'ok');
  await ev("qaMode='hold';qaStart()");await until(()=>ev('qaHeld.length===2'),'GET before POST');
  await ev("truckPhoneRequest({truckId:'synthetic_empty',phone:'+12025550101'})");await ev('qaRelease(1)');
  await until(()=>ev('qaOutcome!==null'),'old GET settled');
  assert.equal(await ev("truckPhoneRows.get('synthetic_empty')"),'+12025550101');
  await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_delete'");
  await ev("qaMode='hold';qaStart({truckId:'synthetic_delete',phone:'+12025550102'})");await until(()=>ev('qaHeld.length===3'),'POST held');
  const count=browser.network.filter(r=>r.url.endsWith('/api/v1/truck-phones')).length;
  await ev('window.qaReadDone=false;void truckPhoneRequest().then(()=>qaReadDone=true)');
  assert.equal(await ev('qaReadDone'),false);assert.equal(browser.network.filter(r=>r.url.endsWith('/api/v1/truck-phones')).length,count);
  await ev('qaRelease(2)');await until(()=>ev('qaReadDone'),'GET waits write');
  assert.equal(await ev("truckPhoneRows.get('synthetic_delete')"),'+12025550102');
 });
 await scenario('isolated faults: committed bad body vs unsent HTTP error/abort-aware timeout',async()=>{
  // Dedicated real client with short deadline; production configuration unchanged.
  for(const mode of ['badbody','error','hang']){
   // Each fault starts empty. badbody is an uncertain *committed* write;
   // error/hang below deliberately fail before dispatch, not server failures.
   await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_empty'");
   await ev(`resetTruckPhones();window.qaSavedClient=nasRuntimeClient;window.qaFaultAborted=false;window.qaFaultDispatches=0;window.qaFaultFetch=(url,options)=>{if(String(url).endsWith('/api/v1/truck-phones')){if('${mode}'==='error')return Promise.resolve(new Response(JSON.stringify({error:'injected-before-dispatch'}),{status:503,headers:{'Content-Type':'application/json'}}));if('${mode}'==='hang')return new Promise((resolve,reject)=>{const abort=()=>{qaFaultAborted=true;reject(new DOMException('Aborted','AbortError'));};if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});});qaFaultDispatches++;return qaOriginalFetch(url,options).then(()=>new Response('<not-json>',{status:200,headers:{'Content-Type':'application/json'}}));}return qaOriginalFetch(url,options);};window.qaTestClient=(await loadNasSessionClient()).createNasClient({baseUrl:nasApiBase(),getUser:()=>wtAuthUser(),fetchImpl:qaFaultFetch,timeoutMs:500});await qaTestClient.readSession();nasRuntimeClient=qaTestClient;addTruckPhone('synthetic_empty');document.querySelector('dialog input').value='+12025550109';document.querySelector('dialog form').requestSubmit();`);
   await until(()=>ev("!!document.querySelector('dialog[open] [role=alert]')?.textContent"),'visible '+mode+' failure');
   assert.ok(await ev("!!document.querySelector('dialog[open]')"));
   assert.equal(await ev("truckPhoneRows.has('synthetic_empty')"),false);
   const rows=(await pool.query("SELECT phone FROM truck_phones WHERE truck_id='synthetic_empty'")).rows;
   assert.deepEqual(rows,mode==='badbody'?[{phone:'+12025550109'}]:[]);
   assert.equal(await ev('qaFaultDispatches'),mode==='badbody'?1:0);
   if(mode==='hang'){assert.equal(await ev('qaFaultAborted'),true);assert.ok((await ev("document.querySelector('dialog [role=alert]').textContent")).includes('api-timeout'));}
   await ev("document.querySelector('dialog [type=button]').click();nasRuntimeClient=qaSavedClient;qaTestClient.stop();await nasRuntimeClient.readCatalog();await refreshTruckPhones()");
   assert.equal(await ev("truckPhoneRows.has('synthetic_empty')"),mode==='badbody');
  }
  await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_empty'");
  await ev('await refreshTruckPhones()');
 });
 await scenario('late GET/POST/errors across real logout/login same uid and runtime; view revoke/regrant DOM',async()=>{
  // wtClearSession/wtNotifySession are the same auth chain used by handleLogout;
  // call real logout HTTP, avoid replacing auth handlers or runtime functions.
  for(const kind of ['GET','POST','error']){
   await pool.query("DELETE FROM truck_phones WHERE truck_id='synthetic_delete'");
   const index=await ev('qaHeld.length');
   await ev(`qaMode='hold';qaStart(${kind==='POST'?"{truckId:'synthetic_delete',phone:'+12025550102'}":'undefined'})`);
   await until(()=>ev(`qaHeld.length===${index+1}`),'old response held');
   const epoch=await ev('nasRuntimeEpoch');
   await ev("await wtAuthRequest('/api/v1/auth/logout',{refreshToken:wtSession.refreshToken});wtClearSession();wtNotifySession(null);wtShowAuthScreens('signed-out')");
   assert.equal(await ev('truckPhoneRows.size'),0);
   await login('admin');assert.ok(await ev('nasRuntimeEpoch')>epoch);
   if(kind==='error')await ev(`qaReject(${index})`);else await ev(`qaRelease(${index})`);
   await until(()=>ev('qaOutcome!==null'),'old auth request settles');assert.notEqual(await ev('qaOutcome'),'ok');
  }
  // Switch via genuine password login to a restricted role.
  await ev("wtClearSession();wtNotifySession(null);wtShowAuthScreens('signed-out')");await login('viewer');
  await pool.query("UPDATE role_permissions SET allowed=false WHERE role='viewer' AND action='view_truck_phone'");
  await ev('applyNasSession(await nasRuntimeClient.readSession())');
  assert.equal(await ev('truckPhoneRows.size'),0);assert.equal(await ev("document.querySelectorAll('a.truck-phone').length"),0);
  await pool.query("UPDATE role_permissions SET allowed=true WHERE role='viewer' AND action='view_truck_phone'");
  await ev('applyNasSession(await nasRuntimeClient.readSession());await refreshTruckPhones()');
  assert.equal(await ev("truckPhoneRows.get('synthetic_truck')"),'+12025550100');
 });
 await scenario('full handleLogout confirmation, server revocation, reload and same uid login',async()=>{
  // Establish the account explicitly; the preceding ACL scenario ends as viewer.
  await ev("wtClearSession();wtNotifySession(null);wtShowAuthScreens('signed-out')");
  await login('admin');
  const uidBefore=await ev('wtAuthUser().uid');
  assert.equal(uidBefore,'synthetic_admin');
  assert.equal(await ev('currentUid'),uidBefore);
  const old=await ev('wtAccessToken()');
  const marker=await ev("window.qaDocumentMarker=String(Math.random())");
  await ev('void handleLogout()');
  await until(()=>ev("!!document.querySelector('.pcm-overlay .pcm-btn-confirm')"),'logout confirmation');
  // Activate the actual confirmation control; no replacement of appConfirm.
  await ev("document.querySelector('.pcm-overlay .pcm-btn-confirm').click()");
  await until(async()=>{try{return await ev(`window.qaDocumentMarker!==${JSON.stringify(marker)} && typeof wtAuthUser==='function' && wtAuthUser()===null && localStorage.getItem('wt_refresh_token')===null`);}catch{return false;}},'real logout navigation');
  assert.equal(await ev("localStorage.getItem('wt_access_token')"),null);
  assert.equal(await ev("typeof truckPhoneRows!=='undefined' ? truckPhoneRows.size : 0"),0);
  assert.equal(await ev("document.querySelectorAll('a.truck-phone').length"),0);
  assert.equal(await ev(`fetch('/api/v1/truck-phones',{headers:{Authorization:${JSON.stringify('Bearer '+old)}}}).then(r=>r.status)`),401);
  await login('admin');await until(()=>ev("truckPhoneRows.get('synthetic_truck')==='+12025550100'"),'same uid after reload');
  const uidAfter=await ev('wtAuthUser().uid');
  assert.equal(uidAfter,uidBefore);
  assert.equal(await ev('currentUid'),uidBefore);
 });
 await scenario('deterministic restore overlap, phone-first and restore-first SQL lock orders',async()=>{
  // Independent fetch requests avoid incidental runtime epoch reload while
  // exercising real HTTP middleware. Abort deadline prevents stuck cleanup.
  const token=await ev('wtAccessToken()');assert.ok(token);
  const request=async(path,body,epoch)=>{const r=await fetch('http://127.0.0.1:18099'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json','X-Samosval-Epoch':String(epoch),'X-Samosval-Generation':'3'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});return {status:r.status,data:await r.json()};};
  // Stop polling only for SQL scheduling; browser UI was verified above.
  await ev('stopNasRuntime()');
  const evidence=await restoreOverlap(pool,request);
  writeFileSync(base+'/restore-overlap.json',JSON.stringify(evidence,null,2));
 });
 await scenario('old actual 1.7.21 client on same synthetic API',async()=>{
  await browser.send('Page.navigate',{url:origin+'/legacy/index-working-test.html'});
  await until(()=>ev("typeof handleLogin==='function'"),'legacy loaded');
  await until(()=>ev("typeof nasRuntimeClient!=='undefined' && nasRuntimeClient && currentUserStatus==='active' && state.trucks.length>0"),'legacy real session and line');
  assert.equal(await ev('typeof truckPhoneRequest'),'undefined');
  await ev("switchTab('trucks');renderGlobalTrucksManage()");
  assert.ok(await ev("document.getElementById('globalTrucksManageList').textContent.includes('Synthetic')"));
  assert.equal(await ev("document.getElementById('globalTrucksManageList').textContent.includes('+12025550100')"),false);
 });
 await scenario('real Network URLs and browser error/rejection gate',async()=>{
  assert.ok(browser.network.some(r=>r.url===origin+'/api/v1/truck-phones'));
  assert.equal(browser.network.some(r=>r.url.includes(':18091')),false);
  const api=browser.network.filter(r=>r.url.includes('/api/'));assert.ok(api.every(r=>r.url.startsWith(origin+'/api/')));
  assert.deepEqual(browser.errors,[]);assert.deepEqual(await ev('window.__qaRejections'),[]);
 });
 console.log('Browser scenarios complete; HTTP/backup extended assertions are separate focused tests. No publication.');
}finally{if(browser)await browser.close();await pool.end();}
