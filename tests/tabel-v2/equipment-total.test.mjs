import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivals} from '../../test-app/tabel-v2/line.mjs';
import {equipmentCount} from '../../test-app/tabel-v2/table-domain.mjs';
const day='2026-10-29', timestamp=Date.parse(day+'T10:00:00+03:00');
const event=(id, extra={})=>({objectId:'site',timestamp,history:{operations:[{collection:'truckStatus',id,before:{shiftId:'s',onLine:true},after:null}]},...extra});
test('daily total includes selected, loaded, removed and archived trucks, excludes GAI and duplicate numbers',()=>{
 const snapshot={shift:{id:'s',objectId:'site',startDate:'29.10.2026'},
  trucks:[...Array.from({length:7},(_,i)=>({id:'t'+i,number:'А'+i+'ВС78'})),{id:'copy',number:'A0BC78'},{id:'gai',number:'Х111ХХ78',isGAI:true}],
  statuses:{t0:{shiftId:'s',onLine:true},copy:{shiftId:'s',addedAt:timestamp},t1:{shiftId:'s',arriveTimestamp:timestamp},gai:{shiftId:'s',onLine:true},old:{shiftId:'yesterday',onLine:true}},
  logs:[{shiftId:'s',truckId:'t2'}],audit:[],lineAudit:[event('t3'),event('gai'),event('wrong',{objectId:'other'}),event('yesterday',{timestamp:timestamp-86400000})],
  archive:[{objectId:'site',date:'29.10.2026',logs:[{truckId:'t4',isGAI:false}],activeLineIds:['t5'],tabelV2Arrivals:[{id:'t6',plate:'А6ВС78',isGAI:false}]}]};
 const config={equipment:[]};const days=[{equipment:Array.from({length:4},(_,i)=>({id:'machine'+i}))}];
 const count=()=>equipmentCount(days,arrivals(snapshot,'site',day).rows,config,snapshot.trucks);
 assert.equal(count(),11);
 snapshot.statuses={};snapshot.logs=[];
 snapshot.lineAudit.push(event('t0'),event('t1'),event('t2'));
 assert.equal(count(),11,'departure must not lower daily total');
 days.push({equipment:[...days[0].equipment,{id:'registered-truck',plate:'A0BC78'}]});
 assert.equal(count(),11,'day/night selections and plate aliases counted once');
});
test('old positive arrivals and modern journal rows share the same daily count',()=>{
 const snap={trucks:[{id:'t',number:'А123ВС78'}],audit:[{objectId:'site',timestamp,eventType:'arrive',text:'Прибытие на линию',truckId:'t'},event('t')]};
 assert.equal(equipmentCount([],arrivals(snap,'site',day).rows,{equipment:[]}),1);
 assert.equal(equipmentCount([],arrivals(snap,'site','2026-10-28').rows,{equipment:[]}),0);
});
test('one full-day listener survives rerenders and object changes; date/account changes replace it',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=(await readFile(new URL('../../test-app/source/core/04-subscriptions.js',import.meta.url),'utf8')).split('  function startSync()')[0];
 const calls=[],listeners=[];let stopped=0;
 const query={where(...args){calls.push(args);return this;},orderBy(){return this;},onSnapshot(cb){listeners.push(cb);return ()=>stopped++;}};
 const context=vm.createContext({isNasRuntime:()=>false,state:{shift:{id:'s',objectId:'a',startDate:'29.10.2026'}},currentUid:'u',refs:{audit:query},saveCache(){},scheduleRender(){},console});
 vm.runInContext(source,context);
 const sync=()=>vm.runInContext('syncLineCountAudit()',context);
 sync();for(let i=0;i<10;i++)sync();context.state.shift.objectId='b';sync();
 assert.equal(listeners.length,1);assert.equal(calls[0][2],Date.parse('2026-10-29T00:00:00+03:00'));
 const docs=Array.from({length:250},(_,i)=>({id:'e'+i,data:()=>({timestamp:i})}));listeners[0]({docs});assert.equal(context.state.lineAudit.length,250);
 context.state.shift.startDate='30.10.2026';sync();assert.equal(listeners.length,2);assert.equal(stopped,1);
 listeners[0]({docs});assert.equal(context.state.lineAudit.length,0,'old subscription cannot overwrite new day');
 context.currentUid='other';sync();assert.equal(stopped,2);context.state.shift=null;sync();assert.equal(stopped,3);
});
