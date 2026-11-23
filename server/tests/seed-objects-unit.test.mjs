import test from 'node:test';
import assert from 'node:assert/strict';
import {seedObjects} from '../scripts/seed-objects.mjs';

test('object seed requires an inspected TEST import before database access',async()=>{
  for(const options of [{},{sha256:'abc'},{workspaceId:'production',sha256:'a'.repeat(64)}])await assert.rejects(seedObjects(null,options),{code:'inspected-test-import-required'});
});
