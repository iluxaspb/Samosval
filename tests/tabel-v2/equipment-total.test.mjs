import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivals} from '../../working-test/tabel-v2/line.mjs';
import {equipmentCount} from '../../working-test/tabel-v2/table-domain.mjs';
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
