import test from 'node:test';
import assert from 'node:assert/strict';
import {seedIdentity} from '../src/seed-identity.mjs';

test('identity seed requires explicit inspected checksum before database access',async()=>{
  await assert.rejects(seedIdentity(null,{}),{code:'inspected-test-import-required'});
});
