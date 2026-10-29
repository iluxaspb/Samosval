import test from "node:test";
import assert from "node:assert/strict";
import { preferredObjectId, lastClosedKey } from "../../test-app/tabel-v2/object-default.mjs";

const objects = [{ id: "a" }, { id: "b" }, { id: "c" }];
const archive = [{objectId:"a",closedAt:100}, {objectId:"b",closedAt:200}];

test("active Line address overrides remembered and latest closed shift", () => {
  assert.equal(preferredObjectId({objects,shift:{id:"shift",objectId:"c",isActive:true},archive,lastObject:"a"}),"c");
});
test("closed shift does not override the latest archived address", () => {
  assert.equal(preferredObjectId({objects,shift:{objectId:"c",isActive:false},archive,lastObject:"c"}),"b");
});
test("last closed archive wins regardless of collection ordering", () => {
  assert.equal(preferredObjectId({objects,archive:[archive[1],archive[0]],lastObject:"c"}),"b");
  assert.equal(preferredObjectId({objects,archive:[{objectId:"a",date:"21.10.2026"},{objectId:"b",date:"29.10.2026"}]}),"b");
});
test("latest locally closed zero-trip shift wins over older archived shift", () => {
  assert.equal(preferredObjectId({objects,archive,recentlyClosed:{objectId:"c",closedAt:300},lastObject:"a"}),"c");
});
test("explicit request overrides; missing/deleted objects never selected", () => {
  assert.equal(preferredObjectId({objects,requestObjectId:"a",shift:{objectId:"c",isActive:true},archive}),"a");
  assert.equal(preferredObjectId({objects:[objects[0]],shift:{objectId:"c",isActive:true},archive,lastObject:"b"}),"a");
  assert.equal(preferredObjectId({objects:[]}),null);
});
test("fallback and storage keys remain isolated by project", () => {
  assert.equal(preferredObjectId({objects,lastObject:"b"}),"b");
  assert.equal(lastClosedKey("test","workspace"),"tabel-v2-last-closed:test:workspace");
});
