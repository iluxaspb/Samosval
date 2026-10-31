import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, allowedInput } from './server.mjs';
test('authentication fails closed', () => {
  assert.equal(authorized(undefined, 'example'), false);
  assert.equal(authorized('Basic ' + Buffer.from('opencode:wrong').toString('base64'), 'example'), false);
  assert.equal(authorized('Basic ' + Buffer.from('opencode:example').toString('base64'), 'example'), true);
  assert.equal(authorized('Basic ', ''), false);
});
test('view mode blocks all control; manual mode has narrow allowlist', () => {
  for (const type of ['mouseEvent', 'keyEvent', 'navigation', 'closeTab']) assert.equal(allowedInput({ type }, 'view'), false);
  assert.equal(allowedInput({ type: 'mouseEvent' }, 'manual'), true);
  assert.equal(allowedInput({ type: 'keyEvent' }, 'manual'), true);
  assert.equal(allowedInput({ type: 'navigation' }, 'manual'), false);
  assert.equal(allowedInput({ type: 'closeTab' }, 'manual'), false);
});
