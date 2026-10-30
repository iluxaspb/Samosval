import test from 'node:test';
import assert from 'node:assert/strict';
import {nasPresence} from '../../test-app/tabel-v2/presence-nas.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(remoteOverrides={}){
  const writes=[],removes=[],frames=[],events=new Map(),timers=new Map(),intervals=new Map();let n=0,leave,active=true;
  const root={hidden:false,isConnected:true},doc={hidden:false,addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const remote={write:async data=>writes.push(structuredClone(data)),remove:async data=>removes.push(structuredClone(data)),list:async()=>({peers:[]}),...remoteOverrides};
  const host={session:()=>({uid:'one',provider:'synology',providerScope:'source',active,view:active}),presenceRemote:remote,registerPresenceLeave:fn=>{leave=fn;return ()=>{leave=null;};},workspace:{collection(){throw Error('Firestore must not be accessed');}}};
  const s={host,root,object:{id:'site'},sheetVisible:()=>active,store:{save(){throw Error('presence must not enter business outbox');}}};
  const ui=nasPresence(s,(peers,error)=>frames.push({peers:structuredClone(peers),error}),{doc,nav:{onLine:true},events:{addEventListener(){},removeEventListener(){}},observe:()=>({observe(){},disconnect(){}}),sessionId:()=> 'browser',now:()=>1000,
    setTimer:fn=>{timers.set(++n,fn);return n;},clearTimer:id=>timers.delete(id),setEvery:fn=>{intervals.set(++n,fn);return n;},clearEvery:id=>intervals.delete(id)});
  return {ui,root,doc,events,writes,removes,frames,remote,intervals,setActive:value=>{active=value;},leave:()=>leave?.()};
}
test('NAS selection sends coordinates only and leaves names/UIDs to server',async()=>{
  const h=fixture();h.ui.update('one','A1','B2',true,{rowKeys:['row'],colKeys:['col']});await tick();
  assert.deepEqual(h.writes[0],{sessionId:'browser',sequence:1,objectId:'site',sheetId:'one',selection:{a:'A1',b:'B2',rowKeys:['row'],colKeys:['col']}});h.ui.dispose();
});
test('NAS selection clears on hide and explicit logout cleanup, without durable outbox writes',async()=>{
  const h=fixture({list:async()=>({peers:[{uid:'two',objectId:'site',sheetId:'one',seen:1000,name:'Peer'}]})});h.ui.update('one','A1','A1',true);await tick();assert.equal(h.frames.at(-1).peers.length,1);
  h.doc.hidden=true;h.events.get('visibilitychange')();await tick();assert.equal(h.frames.at(-1).peers.length,0);assert.equal(h.removes.length,1);
  await h.leave();assert.equal(h.removes.length,2);h.ui.dispose();assert.equal(h.intervals.size,0);
});
test('NAS selection discards old sheet responses and shows only peers of the current sheet',async()=>{
  let resolve;const h=fixture({list:()=>new Promise(ok=>{resolve=ok;})});h.ui.update('old','A1','B2',true);h.ui.update('new','C1','C2',true);
  resolve({peers:[{uid:'two',objectId:'site',sheetId:'old',seen:1000}]});await tick();assert.equal(h.frames.at(-1).peers.length,0);
  h.remote.list=async()=>({peers:[{uid:'two',objectId:'site',sheetId:'new',seen:1000},{uid:'one',objectId:'site',sheetId:'new',seen:1000},{uid:'foreign',objectId:'other',sheetId:'new',seen:1000}]});
  [...h.intervals.values()][0]();await tick();assert.deepEqual(h.frames.at(-1).peers.map(p=>p.uid),['two']);h.ui.dispose();
});
test('NAS pending selection cannot reappear after dispose or local access revocation',async()=>{
  let finish;const h=fixture({write:()=>new Promise(resolve=>{finish=resolve;})});h.ui.update('one','A1','B2',true);h.setActive(false);h.ui.dispose();finish();await tick();
  assert(h.removes.length>=1);assert(h.removes.every(x=>x.sequence>1));assert.equal(h.frames.at(-1).peers.length,0);
});
test('NAS peer read failures remove old highlights and show a connection error',async()=>{
  const h=fixture({list:async()=>({peers:[{uid:'two',objectId:'site',sheetId:'one',seen:1000}]})});h.ui.update('one','A1','A1',true);await tick();
  h.remote.list=async()=>{throw Error('denied');};[...h.intervals.values()][0]();await tick();assert.equal(h.frames.at(-1).peers.length,0);assert.match(h.frames.at(-1).error,/недоступно/);h.ui.dispose();
});
