import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReserveEnvironment} from '../scripts/reserve-copy-once.mjs';
const valid={RESERVE_UPLOAD_CONFIRMATION:'samosval-offline/main_workspace',FIREBASE_PROJECT_ID:'samosval-offline',POSTGRES_DB:'samosval_test',POSTGRES_USER:'test-user',POSTGRES_PASSWORD:'test-only',GOOGLE_APPLICATION_CREDENTIALS:'/run/secrets/test-reserve.json'};
test('real reserve requires exact TEST database, explicit opt-in and configured service identity',()=>{
  assert.doesNotThrow(()=>validateReserveEnvironment(valid));
  for(const patch of [{RESERVE_UPLOAD_CONFIRMATION:''},{POSTGRES_DB:'production'},{FIREBASE_PROJECT_ID:'production'},{WORKSPACE_ID:'other'},{GOOGLE_APPLICATION_CREDENTIALS:''},{POSTGRES_PASSWORD:''},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}])assert.throws(()=>validateReserveEnvironment({...valid,...patch}));
});
