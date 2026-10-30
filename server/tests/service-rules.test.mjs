import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {normalizeGame} from '../src/game-store.mjs';
import {normalizeArchive,restoredLine} from '../src/archive-store.mjs';
import {calculate,rewardSnapshot} from '../src/game-economy.mjs';
import {settle,initialHead,initialPlayer,dayKey} from '../src/arcade-rules.mjs';
import {themePrices} from '../src/theme-prices.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('server reward calculator matches the existing UI including undo, redo, penalties and versioned rates',()=>{
  const source=read('test-app/source/features/game-coins-v2.js'),ctx={window:{},state:{objects:[]}};vm.createContext(ctx);vm.runInContext(source.slice(0,source.indexOf('  let records='))+'})();',ctx);
  const log={id:'load',shiftId:'s',truckId:'t',clientOperationId:'op',createdByEmail:'one@example.test',createdBy:'One',timestamp:10};
  const event={id:'history',eventType:'history',timestamp:10,userEmail:'one@example.test',history:{undone:false,gameRewards:{version:1,load:5,arrive:2,ttn:0},operations:[{collection:'logs',id:'load',before:null,after:log}]}};
  for(const undone of [false,true]){
    const entries=[{...event,history:{...event.history,undone}},{id:'penalty',eventType:'game_penalty',amount:-3,targetEmail:'one@example.test',timestamp:20}];
    assert.equal(JSON.stringify(calculate(entries)),JSON.stringify(ctx.window.__gameCoinsCore.calculate(entries)));
  }
  const policy={gameRewardSchedule:[{effectiveAt:20,load:4,arrive:6,ttn:2}]};
  assert.equal(JSON.stringify(rewardSnapshot(policy,{type:'load',id:'x',at:30},40)),JSON.stringify(ctx.window.__gameCoinsCore.rewardSnapshot(policy,{type:'load',id:'x',at:30},40)));
});
test('server arcade settlement and theme prices match the shipped UI',()=>{
  const ctx={};vm.createContext(ctx);vm.runInContext(read('test-app/source/features/road-arcade-core.js'),ctx);const ui=ctx.RoadArcadeCore;
  for(const roll of [0,1,99,100,1099,1100,4599,4600,9999])assert.equal(JSON.stringify(settle(initialHead(),initialPlayer('one','one@example.test','One'),{kind:'slot',roll},100,'2026-10-30')),JSON.stringify(ui.settle(ui.initialHead(),ui.initialPlayer('one','one@example.test','One'),{kind:'slot',roll},100,'2026-10-30')));
  const prices=Object.fromEntries([...read('test-app/source/features/road-shop-v1.js').matchAll(/\['([a-z-]+)','[^']*',([0-9]+),/g)].map(m=>[m[1],Number(m[2])]));assert.deepEqual(themePrices,prices);
  assert.equal(dayKey(Date.parse('2026-10-29T21:01:00Z')),'2026-10-30');
});
test('game requests cannot select a payout, inject a price or mint a grant without a valid bounded intent',()=>{
  assert.deepEqual(normalizeGame({id:'play',type:'game.play',action:{kind:'slot',roll:0,payout:100000}}),{id:'play',type:'game.play',action:{kind:'slot'}});
  const itemId=Object.keys(themePrices)[0];assert.deepEqual(normalizeGame({id:'play',type:'game.play',action:{kind:'purchase',itemId,price:0}}).action,{kind:'purchase',itemId});
  for(const action of [{kind:'mario',level:21,coin:0,day:'2026-10-30'},{kind:'mario',level:1,coin:5,day:'2026-10-30'},{kind:'purchase',itemId:'unknown'},{kind:'finish',level:1.5}])assert.throws(()=>normalizeGame({id:'play',type:'game.play',action}));
  for(const amount of [0,-1,1.5,10001])assert.throws(()=>normalizeGame({id:'grant',type:'game.grant',targetUid:'one',amount,reason:'Fixture'}));
});
test('restored line retains archive trip order, times, comments and pending TTN without modifying source',()=>{
  const archive={objectId:'site',objectName:'Site',date:'30.10.2026',activeLineIds:['zero'],ttnStatus:{truck:'pending'},paper:{width:900},logs:[{id:'late',truckId:'truck',volume:24,timestamp:20,comment:'late'},{id:'early',truckId:'truck',volume:24,timestamp:10,comment:'early'}]};
  const before=JSON.stringify(archive),line=restoredLine(archive,{id:'restore',recordId:'archive'},{uid:'one',display_name:'One'},100);
  assert.equal(JSON.stringify(archive),before);assert.deepEqual(line.logs.map(l=>l.timestamp),[20,10]);assert.deepEqual(line.logs.map(l=>l.comment),['late','early']);
  const status=line.statuses.find(s=>s.id==='truck');assert.equal(status.lastLoadTimestamp,20);assert.equal(status.lastLoadLogId,line.logs[0].id);assert.equal(status.ttnStatus,'pending');assert.equal(line.statuses.find(s=>s.id==='zero').lastLoadTimestamp,null);
  assert.equal(line.shift.restoredFrom,'archive');assert.throws(()=>normalizeArchive({id:'x',type:'archive.restore',recordId:'a',expectedRevision:0}));
});
