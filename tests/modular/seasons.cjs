const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=require('../../tools/read-test-html.cjs')(),script=html.match(/<script id="road-season-effects-v1">([\s\S]*?)<\/script>/)[1];
class El {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.attributes={};this.textContent='';this.checked=false;this.disabled=false;this._class='';this.listeners={};this.classList={contains:x=>this._class.split(' ').includes(x),add:x=>{if(!this.classList.contains(x))this._class+=' '+x;},remove:x=>this._class=this._class.split(' ').filter(y=>y!==x).join(' ')};}
  set className(v){this._class=v;}get className(){return this._class;}
  set innerHTML(v){this.children=[];if(v.includes('data-season-note')){this.append(new El('input'));const n=new El('p');n.attributes['data-season-note']='';this.append(n);}}
  setAttribute(k,v){this.attributes[k]=v;}
  append(e){if(e.parentNode)e.remove();e.parentNode=this;this.children.push(e);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}
  get isConnected(){return this===body||!!this.parentNode?.isConnected;}
  querySelector(q){if(q==='input')return this.children.find(x=>x.tagName==='INPUT');if(q==='[data-season-note]')return this.children.find(x=>'data-season-note'in x.attributes);if(q===':scope > .season-snow-cap')return this.children.find(x=>x.classList.contains('season-snow-cap'));if(q==='.road-season-setting')return this.children.find(x=>x.classList.contains('road-season-setting'));return null;}
  getBoundingClientRect(){return {bottom:90};}
  getContext(){return context2d;}
}
let draws=0;const context2d=new Proxy({createRadialGradient:()=>({addColorStop(){}})},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='fill')draws++;}});
const body=new El('body'),modalBody=new El('div'),card=new El('div'),button=new El('button'),shop=new El('dialog'),preview=new El('div'),header=new El('header');card.className='truck-card';button.className='btn';body.append(modalBody);body.append(card);card.append(button);body.append(shop);shop.append(preview);body.append(header);
const tree=(node=body)=>[node,...node.children.flatMap(tree)];
let theme='season-winter';let motionHandler;const motion={matches:false,addEventListener:(name,cb)=>{motionHandler=cb;}};
const events={},intervals=[],raf=new Map(),storage=new Map();let frameId=0;
const doc={body,hidden:false,createElement:t=>new El(t),getElementById:id=>id==='mainHeader'?header:tree().find(n=>n.id===id),querySelector:q=>q==='#settingsModal .modal-body'?modalBody:q==='#road-shop-dialog[open] .shop-preview-tools'?(shop.open?preview:null):q==='#road-shop-dialog[open]'?(shop.open?shop:null):null,querySelectorAll:q=>q.includes('.truck-card,')?[card,button]:q.startsWith('.')?tree().filter(n=>n.classList.contains(q.slice(1))):[],addEventListener:(n,f)=>{events[n]=f;}};
const ctx={document:doc,window:{RoadShop:{getAppliedTheme:()=>theme},addEventListener:(n,f)=>{events[n]=f;}},matchMedia:()=>motion,permissionsLoaded:true,currentUserStatus:'active',currentUid:'alice',firebaseConfig:{projectId:'p'},WORKSPACE_ID:'w',appConfig:{testReviewFlags:{}},innerWidth:390,innerHeight:844,devicePixelRatio:2,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},MutationObserver:class{observe(){}},showError:m=>{throw Error(m);},requestAnimationFrame:f=>{raf.set(++frameId,f);return frameId;},cancelAnimationFrame:id=>raf.delete(id),setInterval:f=>intervals.push(f)};
vm.createContext(ctx);vm.runInContext(script,ctx);const core=ctx.window.__seasonEffectsCore,sync=intervals[0];
const layer=doc.getElementById('road-season-layer');assert(layer&&layer.inert);assert.equal(layer.attributes['aria-hidden'],'true');assert.equal(body.dataset.roadSeason,'winter');assert.equal(doc.querySelectorAll('.season-snow-cap').length,2);assert(raf.size);
function step(t){const callbacks=[...raf.values()];raf.clear();callbacks.forEach(f=>f(t));}step(100);step(140);assert(draws>0);
const choice=doc.querySelectorAll('.road-season-setting')[0].querySelector('input');choice.onchange({target:{checked:false}});assert.equal(raf.size,0);assert.equal(doc.querySelectorAll('.season-snow-cap').length,0);assert(!body.dataset.roadSeason);assert.equal(storage.get('samosval-season-effects-v1:p:w:alice'),'0');
ctx.currentUid='bob';sync();assert.equal(body.dataset.roadSeason,'winter');ctx.currentUid='alice';sync();assert(!body.dataset.roadSeason);choice.onchange({target:{checked:true}});
motion.matches=true;motionHandler();assert.equal(raf.size,0);assert.equal(doc.querySelectorAll('.season-snow-cap').length,2);motion.matches=false;motionHandler();assert(raf.size);
for(const id of ['season-autumn','season-spring','season-summer','roadworks']){theme=id;sync();assert.equal(doc.querySelectorAll('.season-snow-cap').length,0);assert(raf.size);step(200);step(240);}
shop.open=true;theme='season-winter';sync();assert.equal(layer.parentNode,shop);assert.equal(doc.querySelectorAll('.road-season-setting').length,2);shop.open=false;sync();assert.equal(layer.parentNode,body);
doc.hidden=true;events.visibilitychange();assert.equal(raf.size,0);doc.hidden=false;events.visibilitychange();assert(raf.size);
ctx.appConfig.testReviewFlags.game_effects=false;events['review-flags-changed']();assert.equal(raf.size,0);assert.equal(doc.querySelectorAll('.season-snow-cap').length,0);ctx.appConfig.testReviewFlags.game_effects=true;sync();theme='road';sync();assert.equal(raf.size,0);assert(!body.dataset.roadSeason);
for(const season of ['winter','autumn','spring','roadworks']){const p=core.createParticles(season,390,844,()=>.5);assert(p.length<=24);for(let i=0;i<30000;i++)core.advanceParticles(p,.033,390,844,()=>.5);assert(p.every(x=>x.x>=-20&&x.x<=410&&x.y>=-16&&x.y<=860));}
assert.equal(core.createParticles('summer',390,844).length,0);assert.equal(core.sunOpacity(4),1);assert.equal(core.sunOpacity(15),0);assert.equal(core.seasonForTheme('winter'),'');
console.log('Season effects: animation lifecycle, snow cleanup, account preferences, reduced motion, global switch, shop preview hosting, bounded particles and intermittent sun passed');

const road=core.createParticles('roadworks',390,844,()=>.5);assert.equal(road.length,9);assert.deepEqual(new Set(road.map(p=>p.kind)),new Set(['warning','cone','direction']));assert.equal(core.seasonForTheme('roadworks'),'roadworks');console.log('Roadworks cones and both sign types use bounded particles, effect preference and reduced-motion handling');
