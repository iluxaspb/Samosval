import test from "node:test";
import assert from "node:assert/strict";
import {firestoreRemote,recordIdFor} from "../../test-app/tabel-v2/store.mjs";
const key="road-13/sheet:linked";
function fakeFirebase(row) {
  const tables={tabelNextRecords:new Map(),tabelNextOperations:new Map()};
  if(row)tables.tabelNextRecords.set(recordIdFor(key),structuredClone(row));
  const host={
    session:()=>({uid:"qa",name:"QA",role:"admin",active:true,view:true,edit:true}),
    workspace:{collection:(table)=>({
      doc:id=>({table,id}),
      where:()=>({get:async()=>({docs:[]})})
    })},
    transaction:async work=>{
      const changes=[];
      const tx={
        get:async ref=>{
          const data=tables[ref.table].get(ref.id);
          return {exists:data!==undefined,data:()=>structuredClone(data)};
        },
        set:(ref,data)=>changes.push({ref,data:structuredClone(data)})
      };
      const result=await work(tx);
      for(const {ref,data} of changes)tables[ref.table].set(ref.id,data);
      return result;
    }
  };
  return {host,tables,remote:firestoreRemote(host,()=>{})};
}
test("a live Firebase transaction auto-merges first numbers and cell styling",async()=>{
  const before={cells:{A1:{raw:""}},heights:{}};
  const current={revision:1,data:{cells:{A1:{raw:""},B1:{raw:"7"}},heights:{0:26}}};
  const {remote,tables}=fakeFirebase(current);
  const first={id:"device1",key,before:{revision:0,data:before},
    data:{cells:{A1:{raw:"12",style:{background:"#fff"}}},heights:{0:27}},
    label:"Первое число"};
  const saved=await remote.commit(first);
  assert.equal(saved.conflict,undefined);
  assert.equal(saved.revision,2);
  assert.equal(saved.data.cells.A1.raw,"12");
  assert.equal(saved.data.cells.B1.raw,"7");
  assert.equal(saved.data.heights[0],27);
  assert.equal(tables.tabelNextOperations.get("device1").before.revision,1);
  assert.deepEqual(await remote.commit(first),saved,"Retry by same operation ID must be idempotent");
});
test("live transaction keeps true numeric edits or deleting occupied cells as conflicts",async()=>{
  const before={cells:{A1:{raw:"8"}},heights:{}};
  const current={revision:2,data:{cells:{A1:{raw:"8"}},heights:{0:32}}};
  const {remote,tables}=fakeFirebase(current);
  const edit={id:"device2",key,before:{revision:1,data:before},
    data:{cells:{A1:{raw:"9"}},heights:{}},label:"Число"};
  const result=await remote.commit(edit);
  assert.equal(result.conflict,true);
  assert(result.fields.includes("cells.A1.raw"));
  assert.equal(tables.tabelNextRecords.get(recordIdFor(key)).revision,2);
  assert.equal(tables.tabelNextOperations.size,0);
  const deleted={...edit,id:"device3",data:{cells:{A1:{raw:""}},heights:{}}};
  assert.equal((await remote.commit(deleted)).conflict,true);
});
