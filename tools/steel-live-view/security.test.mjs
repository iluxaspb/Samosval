import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, allowedInput } from './server.mjs';
import { createHandoff } from './handoff.mjs';
test('handoff binds one chat and requires explicit login before resume', () => {
  const h = createHandoff(), a = '/server/local/session/ses_testA', b = '/server/local/session/ses_testB';
  assert.throws(() => h.change('show', '/settings'));
  assert.equal(h.change('show', a).phase, 'working');
  assert.throws(() => h.change('login', b));
  assert.throws(() => h.change('resume', a));
  assert.equal(h.change('login', a).phase, 'login');
  assert.throws(() => h.change('show', a));
  assert.equal(h.change('resume', a).phase, 'working');
  assert.equal(h.change('finish', a).phase, 'inactive');
  assert.equal(h.change('show', b).chat, b);
});
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
