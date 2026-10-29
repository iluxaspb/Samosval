import test from "node:test";
import assert from "node:assert/strict";
import {mergeRecord} from "../../test-app/tabel-v2/merge-record.mjs";
import {Store} from "../../test-app/tabel-v2/store.mjs";

const key="road-13/sheet:linked";
const dayKey="road-13/day:2026-10-29:day";
const sheet=(raw,styles={},height={})=>({
  cells:{A1:{...(raw===undefined?{}:{raw}),...styles}},heights:height,widths:{},name:"Учёт"
});
const merge=(b,m,s,k=key)=>mergeRecord(b,m,s,k);
test("blank server cell + first entered number automatically merges, even with styling",()=>{
  const base=sheet(undefined);
  const remote=sheet(undefined,{style:{color:"#111"}},{0:26});
  const local=sheet("12",{numberFormat:"",style:{background:"#fff",fontSize:"12px"}},{0:27});
  const result=merge(base,local,remote);
  assert.deepEqual(result.conflicts,[]);
  assert.equal(result.merged.cells.A1.raw,"12");
  assert.equal(result.merged.cells.A1.style.background,"#fff");
  assert.equal(result.merged.cells.A1.style.color,"#111");
  assert.equal(result.merged.heights[0],27);
});
test("nonoverlapping numbers and independent row/column formatting merge without dialogs",()=>{
  const before={cells:{A1:{raw:"4"},B1:{raw:""}},widths:{A:90},heights:{0:27}};
  const remote={cells:{A1:{raw:"4"},B1:{raw:"7"}},widths:{A:90},heights:{0:31}};
  const device={cells:{A1:{raw:"5"},B1:{raw:""}},widths:{A:110},heights:{0:27}};
  const x=merge(before,device,remote);
  // Existing numeric edits must remain explicit under a changed revision.
  assert(x.conflicts.includes("cells.A1.raw"));
  const first={...device,cells:{A1:{raw:"4"},B1:{raw:""}}};
  const y=merge(before,first,remote);
  assert.deepEqual(y.conflicts,[]);
  assert.equal(y.merged.cells.B1.raw,"7");
  assert.equal(y.merged.widths.A,110);
  assert.equal(y.merged.heights[0],31);
});
test("same number conflicting, or deletion of existing number, requires a choice",()=>{
  const before=sheet("12");
  assert(merge(before,sheet("13"),sheet("12",{style:{color:"#aaa"}})).conflicts.includes("cells.A1.raw"));
  assert(merge(before,sheet("13"),sheet("14")).conflicts.includes("cells.A1.raw"));
  assert(merge(before,sheet(""),sheet("12",{style:{background:"#ddd"}})).conflicts.includes("cells.A1.raw"));
  assert(merge(before,sheet(undefined),sheet("12",{style:{background:"#ddd"}})).conflicts.includes("cells.A1.raw"));
  assert.deepEqual(merge(sheet(undefined),sheet("12"),sheet(undefined,{style:{background:"#ddd"}})).conflicts,[]);
});
test("day values: add missing material quantity, merge other equipment's hours",()=>{
  const base={date:"2026-10-29",shift:"day",values:{gran:{quantity:null}},equipment:[{id:"water",hours:null}]};
  const remote={...structuredClone(base),equipment:[{id:"water",hours:12}]};
  const local={...structuredClone(base),values:{gran:{quantity:42}}};
  const a=merge(base,local,remote,dayKey);
  assert.deepEqual(a.conflicts,[]);
  assert.equal(a.merged.values.gran.quantity,42);
  assert.equal(a.merged.equipment[0].hours,12);
  const second={...remote,values:{gran:{quantity:41}}};
  const conflict=merge(base,local,second,dayKey);
  assert(conflict.conflicts.includes("values.gran.quantity"));
});
test("non-sheet config and unknown root paths retain strict compare-and-swap",()=>{
  assert(merge({x:1},{x:2},{x:3},"road-13/config").conflicts.length);
  assert(merge(null,{x:1},{x:3},"_catalog/config").conflicts.length);
});
function fixture(underlying){
  const store=new Store("merge-test",underlying,()=>({uid:"qa",name:"QA"}));
  store.reloadQuiet=async()=>{};
  store.persist=async()=>{};
  return store;
}
test("local optimistic save rebases independent style and input without a conflict job",async()=>{
  const store=fixture(null);
  const original={revision:1,data:sheet(undefined),localId:"old"};
  store.state.records[key]=structuredClone(original);
  const previous=store.get(key);
  store.state.records[key]={...previous,data:sheet(undefined,{style:{background:"#eee"}},{0:31}),localId:"new"};
  const changed=sheet("8");
  assert.equal(await store.save(key,changed,previous,"Ввод числа"),true);
  assert.equal(store.state.jobs.filter(j=>j.status==="conflict").length,0);
  assert.equal(store.get(key).data.cells.A1.raw,"8");
  assert.equal(store.get(key).data.heights[0],31);
});
test("queued edits preserve server-only numeric values when earlier edit is confirmed",async()=>{
  let reply;
  let began;
  const called=new Promise(ok=>began=ok);
  const remote={commit:()=>{began();return new Promise(resolve=>reply=resolve);}};
  const store=fixture(remote);
  const baseline={revision:0,data:sheet(undefined),localId:"first"};
  store.state.records[key]={...baseline,data:sheet("10"),localId:"first"};
  store.state.jobs=[{
    id:"first",key,data:sheet("10"),before:{revision:0,data:sheet(undefined)},
    status:"queued",label:"Первое число",author:{uid:"qa"}
  }];
  const sending=store.flush();
  await called;
  const original=store.get(key),local=structuredClone(original.data);
  local.cells.B1={raw:"15"};
  assert.equal(await store.save(key,local,original,"Второе число"),true);
  // Another operator filled C1 while we were offline.
  reply({revision:1,data:{...sheet("10"),cells:{A1:{raw:"10"},C1:{raw:"23"}}}});
  await sending;
  assert.equal(store.state.jobs.length,1);
  assert.equal(store.state.jobs[0].data.cells.C1.raw,"23");
  assert.equal(store.state.jobs[0].data.cells.B1.raw,"15");
  assert.equal(store.get(key).data.cells.C1.raw,"23");
});
test("previously persisted benign conflict repairs itself without losing remote values",async()=>{
  let uploaded;
  const remote={commit:async job=>{uploaded=job;return {revision:3,data:job.data};}};
  const store=fixture(remote);
  const base=sheet(undefined);
  const remoteRow={revision:2,data:{...base,cells:{A1:{raw:"9"}}},authorName:"server"};
  const mine=sheet(undefined,{style:{background:"#fff"}},{0:27});
  store.state.records[key]={revision:1,data:mine,localId:"conflict"};
  store.state.jobs=[{id:"conflict",key,data:mine,before:{revision:1,data:base},remote:remoteRow,status:"conflict",author:{uid:"qa"}}];
  await store.flush();
  assert.equal(uploaded.data.cells.A1.raw,"9");
  assert.equal(uploaded.data.heights[0],27);
  assert.equal(store.state.jobs.length,0);
  assert.equal(store.state.records[key].data.cells.A1.raw,"9");
  assert(store.state.history.some(x=>x.resolution==="auto-nonoverlap"));
});
