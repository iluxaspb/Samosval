'use strict';
// Real TEST account gates, stylesheet, modal and logout handler. No Firebase/network.
// JSDOM verifies computed stacking and cancellation behavior; CI browser uses real clicks.
const fs=require('node:fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const source=file=>fs.readFileSync('test-app/src/'+file,'utf8');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Own the scheduling queue so a close/replacement can happen before its opening
// frame or autofocus, without browser timing assumptions or forced clicks.
async function lifecycleRegression(){
 const dom=new JSDOM('<!doctype html><html><head></head><body><button id="outside">Outside</button></body></html>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,document=w.document;let now=0,nextId=0;
 const frames=new Map(),timers=new Map();
 w.requestAnimationFrame=callback=>{const id=++nextId;frames.set(id,{callback,cancelled:false});return id;};
 w.cancelAnimationFrame=id=>{if(frames.has(id))frames.get(id).cancelled=true;};
 w.setTimeout=(callback,delay)=>{const id=++nextId;timers.set(id,{callback,at:now+delay,cancelled:false});return id;};
 w.clearTimeout=id=>{if(timers.has(id))timers.get(id).cancelled=true;};
 const frame=()=>{for(const [id,job] of [...frames]){frames.delete(id);if(!job.cancelled)job.callback(now);}};
 const advance=async ms=>{const end=now+ms;for(;;){const due=[...timers].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]);if(!due.length)break;const [id,job]=due[0];timers.delete(id);now=job.at;if(!job.cancelled)job.callback();await Promise.resolve();}now=end;await Promise.resolve();};
 const pendingFocus=()=>[...timers.values()].find(job=>job.at===now+100&&!job.cancelled);
 try{
  w.eval(source('features/confirmation.js'));
  const outside=document.getElementById('outside');outside.focus();
  const settled=[];const pending=w.showConfirmModal('Cancel before frame','');pending.then(result=>settled.push(result));
  const overlay=document.querySelector('.pcm-overlay'),opening=[...frames.values()][0],focus=pendingFocus();
  overlay.click(); // The real backdrop path can run before the opening frame.
  assert.equal(opening.cancelled,true,'Closing must cancel its pending opening frame');
  assert.equal(focus.cancelled,true,'Closing must cancel its pending autofocus');
  // An already-dispatched callback must be harmless too, not just cancelled.
  opening.callback(now);focus.callback();frame();
  assert.equal(overlay.classList.contains('pcm-open'),false,'A closed confirmation must never reopen');
  assert.equal(document.activeElement,outside,'A closed confirmation must not steal focus');
  document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));overlay.querySelector('.pcm-btn-confirm').click();
  await advance(279);assert.deepEqual(settled,[]);assert.equal(overlay.isConnected,true,'Preserve normal close animation duration');
  await advance(1);assert.equal(await pending,false);assert.deepEqual(settled,[false]);assert.equal(overlay.isConnected,false);assert.equal(w.__closeActiveConfirmation,null);
  console.log('PASS confirmation lifecycle: cancel before RAF cancels and guards both callbacks, does not reopen/steal focus, and settles once after animation');

  const firstResults=[],secondResults=[];
  const first=w.showConfirmModal('First','');first.then(result=>firstResults.push(result));
  const firstOverlay=document.querySelector('.pcm-overlay'),firstOpening=[...frames.values()][0],firstFocus=pendingFocus();frame();
  assert.equal(firstOverlay.classList.contains('pcm-open'),true,'Normal opening still happens on its animation frame');
  await advance(50);
  const second=w.showConfirmModal('Second','');second.then(result=>secondResults.push(result));
  const secondOverlay=[...document.querySelectorAll('.pcm-overlay')].at(-1),activeClose=w.__closeActiveConfirmation;
  assert.equal(firstFocus.cancelled,true,'Replacing confirmation cancels the previous autofocus');frame();
  assert.equal(firstOverlay.classList.contains('pcm-open'),false);assert.equal(secondOverlay.classList.contains('pcm-open'),true);
  firstOpening.callback(now);firstFocus.callback();assert.equal(document.activeElement,outside);assert.equal(firstOverlay.classList.contains('pcm-open'),false);
  await advance(50);assert.equal(document.activeElement,outside,'The old 100 ms focus deadline cannot steal focus');
  await advance(50);assert.equal(document.activeElement,secondOverlay.querySelector('.pcm-btn-confirm'),'Active confirmation keeps its normal autofocus');
  firstFocus.callback();assert.equal(document.activeElement,secondOverlay.querySelector('.pcm-btn-confirm'),'Late stale autofocus cannot steal from replacement');
  await advance(180);assert.equal(await first,false);assert.deepEqual(firstResults,[false]);assert.equal(firstOverlay.isConnected,false);assert.equal(w.__closeActiveConfirmation,activeClose,'Old cleanup cannot clear active replacement');
  secondOverlay.querySelector('.pcm-btn-confirm').click();secondOverlay.click();document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await advance(280);assert.equal(await second,true);assert.deepEqual(secondResults,[true]);assert.equal(document.querySelector('.pcm-overlay'),null);assert.equal(w.__closeActiveConfirmation,null);
  console.log('PASS confirmation replacement before autofocus: old callbacks stay inert, current animation/focus work, and each promise settles exactly once');
 }finally{dom.window.close();}
}
(async()=>{
 await lifecycleRegression();
 const dom=new JSDOM(source('shell.html'),{url:'https://auth-confirmation.example.test/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,document=w.document,errors=[];w.addEventListener('error',event=>errors.push(event.error));
 try{
  for(const file of ['styles/base.css','styles/game-coins-style.css']){const style=document.createElement('style');style.textContent=source(file);document.head.append(style);}
  const gates=['authOverlay','pendingScreen','disabledScreen'].map(id=>document.getElementById(id));gates.forEach(el=>el.style.display='none');
  document.getElementById('mainHeader').style.display='none';document.querySelector('.container').style.display='none';
  let signouts=0;w.auth={signOut:async()=>{signouts++;gates.forEach(el=>el.style.display='none');document.getElementById('authOverlay').style.display='flex';}};
  w.escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));w.showError=text=>errors.push(Error(text));
  w.eval(source('features/confirmation.js'));w.eval(source('features/confirmation-adapter.js'));
  const auth=source('core/09-auth.js');w.eval(auth.slice(auth.indexOf('  async function handleLogout()')));
  const open=async gate=>{
   gates.forEach(el=>el.style.display=el===gate?'flex':'none');const pending=w.handleLogout();await pause(30);
   const overlay=document.querySelector('.pcm-overlay.pcm-open');assert(overlay);
   assert.equal(overlay.parentElement,gate.parentElement,'Gate and confirmation remain sibling stacking contexts');
   assert.equal(w.getComputedStyle(overlay).position,'fixed');assert.equal(w.getComputedStyle(gate).position,'fixed');
   assert(Number(w.getComputedStyle(overlay).zIndex)>Number(w.getComputedStyle(gate).zIndex),'Confirmation must be above '+gate.id+' without lowering the access gate');
   assert.equal(gate.style.display,'flex','Opening confirmation must not grant access or hide the gate');
   return {pending,overlay};
  };
  const disabled=document.getElementById('disabledScreen');w.localStorage.setItem('dt_saved_email','disabled@example.test');
  let modal=await open(disabled);modal.overlay.querySelector('.pcm-btn-cancel').click();await modal.pending;
  assert.equal(signouts,0);assert.equal(disabled.style.display,'flex');assert.equal(w.localStorage.getItem('dt_saved_email'),'disabled@example.test');assert.equal(document.querySelector('.pcm-overlay'),null);
  modal=await open(disabled);document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await modal.pending;
  assert.equal(signouts,0);assert.equal(disabled.style.display,'flex');
  modal=await open(disabled);modal.overlay.querySelector('.pcm-btn-confirm').click();await modal.pending;
  assert.equal(signouts,1);assert.equal(disabled.style.display,'none');assert.equal(document.getElementById('authOverlay').style.display,'flex');assert.equal(w.localStorage.getItem('dt_saved_email'),null);
  assert.equal(document.querySelector('.container').style.display,'none','Logout does not expose disabled workspace content');
  console.log('PASS disabled logout: confirmation stacks above gate; cancel/Escape keep access blocked; confirm signs out once and reentry works');
  for(const id of ['pendingScreen','authOverlay']){
   modal=await open(document.getElementById(id));modal.overlay.querySelector('.pcm-btn-cancel').click();await modal.pending;assert.equal(signouts,1);
  }
  modal=await open(disabled);const replacement=w.appConfirm('Ещё одно подтверждение');await modal.pending;assert.equal(signouts,1);
  await pause(30);assert.equal(document.querySelectorAll('.pcm-overlay').length,1);document.querySelector('.pcm-btn-cancel').click();assert.equal(await replacement,false);
  assert.equal(document.querySelector('.pcm-overlay'),null);assert.deepEqual(errors,[]);
  console.log('PASS pending/auth gates and repeated modal replacement retain layering, cancel prior logout, and leave no stale overlay');
 }finally{dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
