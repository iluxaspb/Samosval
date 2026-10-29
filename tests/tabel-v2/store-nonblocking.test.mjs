import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../test-app/tabel-v2/store.mjs";

const key = "site-a/day:2026-10-29:day";
function pendingRemote() {
  let started, resolve, reject;
  const began = new Promise(ok => { started = ok; });
  const commit = () => {
    started();
    return new Promise((ok, no) => { resolve = ok; reject = no; });
  };
  return {began, commit, complete: result => resolve(result), fail: error => reject(error)};
}
function fixture() {
  const remote = pendingRemote();
  const store = new Store("local-material-test", {commit: remote.commit}, () => ({uid:"qa",name:"QA"}));
  // Use the real serial queue but replace IndexedDB I/O with an in-memory
  // durable adapter. Tests must prove save is not stuck behind network.
  store.reloadQuiet = async () => {};
  store.persist = async () => {};
  const first = {revision:0, localId:"first-operation", data:{
    date:"2026-10-29", shift:"day", materialIds:["gravel"],
    values:{gravel:{quantity:5}}, equipment:[], people:[]
  }};
  store.state.records[key] = first;
  store.state.jobs = [{
    id:"first-operation",key,data:structuredClone(first.data),
    before:{revision:0,data:null},status:"queued",
    label:"Первый материал",author:{uid:"qa"},time:1
  }];
  return {store, remote};
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_,reject) => { timer = setTimeout(
        () => reject(Error("Local material save waited for Firebase")), 1200);
      })
    ]);
  } finally { clearTimeout(timer); }
}
test("new material saves locally while an older Firebase upload is pending", async () => {
  const {store,remote} = fixture();
  const uploading = store.flush();
  await promptly(remote.began);
  assert.equal(store.busy,true);
  const original = store.get(key);
  const updated = structuredClone(original.data);
  updated.materialIds.push("sand");
  updated.values.sand = {quantity:12,direction:"Склад"};
  const saved = await promptly(store.save(key,updated,original,"Материал за смену"));
  assert.equal(saved,true);
  assert.equal(store.get(key).data.values.sand.quantity,12);
  assert.equal(store.state.jobs.length,2,"Offline queue must keep both changes");
  remote.complete({revision:1,data:original.data});
  await promptly(uploading);
  assert.equal(store.state.jobs.length,1);
  assert.equal(store.state.records[key].data.values.sand.quantity,12);
  assert.equal(store.state.jobs[0].before.localId,"first-operation");
  assert.equal(store.state.history.length,1);
});
test("an upload failure never blocks or deletes a newly entered material", async () => {
  const {store,remote} = fixture();
  const uploading = store.flush();
  await promptly(remote.began);
  const before=store.get(key), updated=structuredClone(before.data);
  updated.values.gravel.quantity = 44;
  assert.equal(await promptly(store.save(key,updated,before,"Исправление объёма")),true);
  remote.fail(Error("network temporarily unavailable"));
  const prior=console.error;
  console.error=()=>{};
  try { await promptly(uploading); } finally { console.error=prior; }
  assert.equal(store.get(key).data.values.gravel.quantity,44);
  assert.equal(store.state.jobs.length,2);
  assert.match(store.uploadError,/network temporarily unavailable/);
  assert.equal(store.busy,false);
});
