import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {hashPassword,verifyPassword,generateToken,signSession,verifySession,hashToken,assertSessionSecret} from '../src/auth-local.mjs';
const secret='ab'.repeat(32);
test('password hash verifies only the correct password',async()=>{
  const credential=await hashPassword('correct-password');
  assert.equal(await verifyPassword('correct-password',credential),true);
  assert.equal(await verifyPassword('wrong-password',credential),false);
});
test('signed session roundtrip preserves payload',async()=>{
  const token=await signSession({uid:'test-user',role:'viewer',sid:'session-id'},{secret,type:'access'});
  const payload=await verifySession(token,{secret,type:'access'});
  assert.equal(payload.uid,'test-user');assert.equal(payload.role,'viewer');assert.equal(payload.sid,'session-id');
  assert.ok(payload.exp>Date.now());
});
test('tampered signature is rejected',async()=>{
  const token=await signSession({uid:'test-user'},{secret,type:'access'});
  const [payload,signature]=token.split('.');
  const altered=(signature[0]==='A'?'B':'A')+signature.slice(1);
  assert.equal(await verifySession(payload+'.'+altered,{secret,type:'access'}),null);
});
test('expired signed payload is rejected',async()=>{
  const payload=Buffer.from(JSON.stringify({uid:'test-user',type:'access',iat:Date.now()-2000,exp:Date.now()-1000})).toString('base64url');
  const signature=createHmac('sha256',secret).update(payload).digest('base64url');
  assert.equal(await verifySession(payload+'.'+signature,{secret,type:'access'}),null);
});
test('token hashing is deterministic and does not expose the original token',async()=>{
  const token=await generateToken(),hash=await hashToken(token);
  assert.equal(hash,await hashToken(token));assert.notEqual(hash,token);assert.match(hash,/^[a-f0-9]{64}$/);
});
test('short session secret is rejected',async()=>{
  await assert.rejects(assertSessionSecret('short'),{code:'invalid-session-secret'});
  assert.equal(await assertSessionSecret(secret),secret);
});
