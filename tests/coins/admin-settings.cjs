// Deterministic DOM/transaction fixture; no network or live Firebase writes.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const context2d=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>k in o?o[k]:()=>{}});
let body;
function descendants(n){return n.children.flatMap(c=>[c,...descendants(c)]);}
function simple(el,s){if(s==='*')return true;const tag=s.match(/^[a-zA-Z][\w-]*/)?.[0];if(tag&&el.tagName!==tag.toUpperCase())return false;for(const id of s.matchAll(/#([\w-]+)/g))if(el.id!==id[1])return false;for(const c of s.matchAll(/\.([\w-]+)/g))if(!el.classList.contains(c[1]))return false;for(const a of s.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/g)){const v=a[1]==='open'?(el.open?'':undefined):el.getAttribute(a[1]);if(v===undefined||a[2]!==undefined&&v!==a[2])return false;}return true;}
function matches(el,s){const parts=s.trim().split(/\s+/);if(!simple(el,parts.pop()))return false;let p=el.parentNode;while(parts.length){const part=parts.pop();while(p&&!simple(p,part))p=p.parentNode;if(!p)return false;p=p.parentNode;}return true;}
class El{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attrs={};this.dataset={};this.style={};this.events={};this.hidden=false;this.disabled=false;this.open=false;this.value='';this.checked=false;this.textContent='';this.className='';this.classList={contains:c=>this.className.split(' ').includes(c),add:c=>{if(!this.classList.contains(c))this.className+=' '+c;},remove:c=>this.className=this.className.split(' ').filter(x=>x!==c).join(' ')};}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='id')this.id=v;if(k==='class')this.className=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=String(v);if(k==='value')this.value=String(v);if(k==='disabled')this.disabled=true;if(k==='hidden')this.hidden=true;}
 getAttribute(k){if(k==='id')return this.id;if(k==='class')return this.className;return this.attrs[k];}
 append(...nodes){for(const n of nodes){if(n.parentNode)n.remove();n.parentNode=this;this.children.push(n);}}
 insertBefore(n,b){if(!b){this.append(n);return;}n.parentNode=this;this.children.splice(this.children.indexOf(b),0,n);}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
 set innerHTML(html){this.children=[];const stack=[this];for(const match of html.matchAll(/<\/?[a-zA-Z][^>]*>/g)){const text=match[0];if(text.startsWith('</')){if(stack.length>1)stack.pop();continue;}const tag=text.match(/^<([\w-]+)/)[1],el=new El(tag);for(const a of text.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))el.setAttribute(a[1],a[2]??a[3]??a[4]??'');stack.at(-1).append(el);if(!['input','br','hr','img','meta','link'].includes(tag))stack.push(el);}}
 querySelectorAll(s){return descendants(this).filter(el=>s.split(',').some(q=>matches(el,q)));}querySelector(s){return this.querySelectorAll(s)[0]||null;}closest(s){let el=this;while(el){if(s.split(',').some(q=>matches(el,q)))return el;el=el.parentNode;}return null;}
 addEventListener(n,f){(this.events[n]??=[]).push(f);}showModal(){this.open=true;}close(){this.open=false;for(const f of this.events.close||[])f();}getContext(){return context2d;}setPointerCapture(){}focus(){this.focused=true;}
}

const clone=x=>JSON.parse(JSON.stringify(x));
function setup(script){
 body=new El('body');
 const header=new El('header');header.id='mainHeader';const top=new El('div');top.className='top-row';const gear=new El('button');gear.className='gear-btn';top.append(gear);header.append(top);body.append(header);
 const slot=new El('div');slot.id='admin-game-settings-slot';body.append(slot);
 const handlers={},store=new Map(),timers=new Map();let timerId=0,writes=0,denyRead=false,afterRead=null;
 let policy={testReviewFlags:{game_effects:false},unrelatedSetting:'preserved'};
 const ctx={window:{addEventListener:(n,f)=>(handlers[n]??=[]).push(f),dispatchEvent:e=>(handlers[e.type]||[]).forEach(f=>f(e))},document:{body,hidden:false,createElement:t=>new El(t),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),getElementById:id=>body.querySelector('#'+id),addEventListener:(n,f)=>(handlers[n]??=[]).push(f)},escapeHtml:String,resolveUserDisplayName:(email,name)=>name||email,state:{objects:[],truckStatus:{},shift:{id:'s',isActive:true}},currentUid:'admin1',currentEmail:'admin@example.test',currentUserStatus:'active',currentUserRole:'admin',permissionsLoaded:true,appConfig:clone(policy),canAdmin:()=>ctx.currentUserRole==='admin'&&ctx.currentUserStatus==='active',getUserName:()=> 'Admin',firebaseConfig:{projectId:'fixture'},WORKSPACE_ID:'fixture',localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},showError:e=>{throw Error(e);},setInterval:f=>{timers.set(++timerId,f);return timerId;},clearInterval:id=>timers.delete(id),setTimeout:f=>{timers.set(++timerId,f);return timerId;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:f=>{timers.set(++timerId,f);return timerId;},cancelAnimationFrame:id=>timers.delete(id),performance:{now:()=>1000},Event,console,matchMedia:()=>({matches:true}),navigator:{onLine:true},offlineJournalRead:()=>[]};
 ctx.appConfigRef={id:'appConfig'};
 ctx.db={runTransaction:async fn=>{const pending=[];const result=await fn({get:async ref=>{assert.equal(ref,ctx.appConfigRef);if(denyRead)throw Error('fixture denied');if(afterRead)afterRead();return {exists:true,data:()=>clone(policy)};},set:(ref,data,options)=>{assert.equal(ref,ctx.appConfigRef);assert.deepEqual(options,{merge:true});pending.push(clone(data));}});for(const data of pending){policy={...policy,...data};writes++;}return result;}};
 ctx.refs={audit:{where:()=>({onSnapshot:(options,next)=>{next({docs:[],metadata:{fromCache:false,hasPendingWrites:false}});return ()=>{};}})}};
 ctx.refs.coinTransactions={where:()=>ctx.refs.coinTransactions,onSnapshot:(options,next)=>{next({docs:[]});return ()=>{};}};
 vm.createContext(ctx);vm.runInContext(script,ctx);ctx.window.__gameConfigChanged();
 return {ctx,el:id=>body.querySelector('#'+id),policy:()=>clone(policy),writes:()=>writes,denyRead:v=>denyRead=v,afterRead:f=>afterRead=f,set:(kind,value)=>{const input=body.querySelector('#game-reward-'+kind);input.value=String(value);for(const f of input.events.input||[])f();},save:()=>body.querySelector('#game-rewards-save').onclick()};
}
async function check(label,script){
 const f=setup(script),{ctx}=f;
 for(const [kind,value] of Object.entries({load:1,arrive:2,ttn:0}))assert.equal(f.el('game-reward-'+kind).value,String(value),label+' default '+kind);
 assert.equal(f.el('game-admin').hidden,false);
 f.set('load',5);f.set('arrive',7);f.set('ttn',3);
 ctx.window.__gameAccessChanged();assert.equal(f.el('game-reward-load').value,'5',label+' unsaved edit survives periodic paint');
 await f.save();assert.equal(f.writes(),1,label+' saved');
 let saved=f.policy();assert.equal(saved.gameRewardSchedule.length,1);assert.equal(saved.gameRewardSchedule[0].load,5);assert.equal(saved.gameRewardSchedule[0].arrive,7);assert.equal(saved.gameRewardSchedule[0].ttn,3);assert.equal(saved.unrelatedSetting,'preserved');assert.deepEqual(saved.testReviewFlags,{game_effects:false});assert.match(f.el('game-rewards-status').textContent,/Сохранено/);assert.equal(f.el('game-rewards-save').disabled,false);
 const first=clone(saved.gameRewardSchedule[0]);
 await f.save();assert.equal(f.writes(),1,label+' no-op save does not append');
 for(const invalid of ['',-1,1.5,10001,'NaN']){f.set('load',invalid);await f.save();assert.equal(f.writes(),1,label+' invalid '+invalid);assert.match(f.el('game-rewards-status').textContent,/целые числа/);}
 f.set('load',0);f.set('arrive',0);f.set('ttn',0);await f.save();saved=f.policy();assert.equal(f.writes(),2);assert.equal(saved.gameRewardSchedule.length,2);assert.deepEqual(saved.gameRewardSchedule[0],first,label+' prior policy preserved');assert(saved.gameRewardSchedule[1].effectiveAt>first.effectiveAt);assert.equal(saved.gameRewardSchedule[1].ttn,0);
 // A reload reads the persisted policy, not stale form defaults.
 ctx.appConfig=clone(saved);ctx.window.__gameConfigChanged();await new Promise(resolve=>setTimeout(resolve,3));ctx.window.__gameAccessChanged();assert.equal(f.el('game-reward-load').value,'0');assert.equal(f.el('game-reward-arrive').value,'0');
 f.set('load',8);ctx.navigator.onLine=false;await f.save();assert.equal(f.writes(),2);assert.match(f.el('game-rewards-status').textContent,/интернету/);ctx.navigator.onLine=true;
 f.denyRead(true);await f.save();assert.equal(f.writes(),2);assert.match(f.el('game-rewards-status').textContent,/Не удалось сохранить/);assert.equal(f.el('game-rewards-save').disabled,false);assert.equal(f.el('game-reward-load').value,'8');f.denyRead(false);
 ctx.currentUserRole='master';ctx.window.__gameAccessChanged();assert.equal(f.el('game-admin').hidden,true);assert.equal(f.el('game-rewards-save').disabled,true);await f.save();assert.equal(f.writes(),2,label+' nonadmin blocked');
 ctx.currentUserRole='admin';ctx.window.__gameAccessChanged();f.afterRead(()=>{ctx.currentUserRole='master';});await f.save();assert.equal(f.writes(),2,label+' role revoked during read blocked');f.afterRead(null);ctx.currentUserRole='admin';
 f.afterRead(()=>{ctx.currentUid='other';});await f.save();assert.equal(f.writes(),2,label+' account switched during read blocked');
 console.log('PASS '+label+': defaults, admin save, persisted reload, unchanged fields, append-only rates, no-op, dirty form, validation, zero, offline/failure, role and identity gates');
}
(async()=>{const prod=require('../../tools/read-production-html.cjs')().match(/<script id="game-coins-v2">([\s\S]*?)<\/script>/)[1];await check('production',prod);const test=require('../../tools/read-test-html.cjs')().match(/<script id="game-coins-v2">([\s\S]*?)<\/script>/)[1];await check('TEST',test);})().catch(e=>{console.error(e);process.exitCode=1;});
