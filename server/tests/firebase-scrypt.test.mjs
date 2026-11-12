import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFirebaseScrypt, firebaseScryptHash, FIREBASE_SCRYPT_ALGORITHM } from '../src/firebase-scrypt.mjs';

const testConfig = {
  algorithm: 'SCRYPT',
  signerKey: Buffer.alloc(64, 7).toString('base64'),
  saltSeparator: 'Bw==',
  rounds: 8,
  memoryCost: 14
};

test('verifyFirebaseScrypt: correct password returns true', async () => {
  const password = 'HermesTest2026!';
  const salt = 'dGVzdC1zYWx0LTEyMw==';
  const hash = await firebaseScryptHash(password, salt, testConfig);
  const credential = { hash, salt, algorithm: FIREBASE_SCRYPT_ALGORITHM };
  const result = await verifyFirebaseScrypt(password, credential, testConfig);
  assert.equal(result, true, 'correct password should verify');
});

test('verifyFirebaseScrypt: wrong password returns false', async () => {
  const password = 'HermesTest2026!';
  const salt = 'dGVzdC1zYWx0LTEyMw==';
  const hash = await firebaseScryptHash(password, salt, testConfig);
  const credential = { hash, salt, algorithm: FIREBASE_SCRYPT_ALGORITHM };
  const result = await verifyFirebaseScrypt('wrong-password', credential, testConfig);
  assert.equal(result, false, 'wrong password should not verify');
});

test('verifyFirebaseScrypt: empty inputs do not throw', async () => {
  const result1 = await verifyFirebaseScrypt('', { hash: 'x', salt: 'y', algorithm: 'firebase-scrypt' }, testConfig);
  assert.equal(result1, false);
  const result2 = await verifyFirebaseScrypt('pw', null, testConfig);
  assert.equal(result2, false);
});
