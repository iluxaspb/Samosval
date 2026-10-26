'use strict';
// Real TEST account gates, stylesheet, modal and logout handler. No Firebase/network.
// JSDOM verifies computed stacking and cancellation behavior; CI browser uses real clicks.
const fs=require('node:fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const source=file=>fs.readFileSync('test-app/src/'+file,'utf8');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
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
