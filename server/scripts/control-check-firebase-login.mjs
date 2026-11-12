// Контрольная проверка входа с firebase-scrypt паролем.
// Запуск: cd server && node scripts/control-check-firebase-login.mjs
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import admin from 'firebase-admin';
import { firebaseScryptHash, FIREBASE_SCRYPT_ALGORITHM } from '../src/firebase-scrypt.mjs';

const SA_PATH = process.env.SA_PATH || '/home/iluxa/samosval-secrets/firebase-samosval-test-sa.json';
const HASH_CONFIG_PATH = process.env.HASH_CONFIG_PATH || '/home/iluxa/samosval-secrets/firebase-hash-config.json';
const API_URL = process.env.API_URL || 'http://127.0.0.1:18091/api/v1/auth/login';
const PASSWORD = 'HermesControlCheck2026!Valid';

async function main() {
  const ts = Date.now();
  const uid = `hermes-control-check-${ts}`;
  const email = `hermes-control-check-${ts}@example.com`;
  let created = false;
  let dbInserted = false;

  const [saRaw, cfgRaw] = await Promise.all([readFile(SA_PATH, 'utf8'), readFile(HASH_CONFIG_PATH, 'utf8')]);
  const sa = JSON.parse(saRaw);
  const cfg = JSON.parse(cfgRaw);
  console.log(`[check] firebase config: algorithm=${cfg.algorithm} rounds=${cfg.rounds} memoryCost=${cfg.memoryCost} signerKeyLen=${(cfg.signerKey||'').length}`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }

  const client = new pg.Client({
    host: process.env.PGHOST || 'samosval-postgres-ubuntu',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.POSTGRES_DB || 'samosval_working_test_reserve',
    user: process.env.POSTGRES_USER || 'samosval_test',
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000
  });

  async function cleanup() {
    try { if (created) await admin.auth().deleteUser(uid).catch(() => {}); } catch {}
    try { if (dbInserted) {
      await client.query('DELETE FROM user_credentials WHERE uid=$1', [uid]);
      await client.query('DELETE FROM app_users WHERE uid=$1', [uid]);
    }} catch {}
  }

  try {
    await client.connect();
    console.log('[check] creating Firebase user:', email);
    await admin.auth().createUser({ uid, email, password: PASSWORD, emailVerified: true });
    created = true;

    const salt = randomBytes(16).toString('base64');
    const hash = await firebaseScryptHash(PASSWORD, salt, cfg);
    console.log(`[check] hash computed (saltLen=${salt.length}, hashLen=${hash.length})`);

    await client.query(`INSERT INTO app_users(uid,email,display_name,role,status,profile) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid, email, 'Hermes Control Check', 'viewer', 'active', { controlCheck: true }]);
    await client.query(`INSERT INTO user_credentials(uid,password_hash,salt,algorithm) VALUES ($1,$2,$3,$4)`,
      [uid, hash, salt, FIREBASE_SCRYPT_ALGORITHM]);
    dbInserted = true;
    console.log('[check] DB records inserted');

    // 1. Верный пароль
    const r1 = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: PASSWORD }) });
    const j1 = await r1.json().catch(() => ({}));
    const pass1 = r1.status === 200 && j1.accessToken && j1.refreshToken;
    console.log(`[check] login(correct): HTTP ${r1.status}, hasTokens=${pass1} ${pass1 ? 'PASS' : 'FAIL'}`);
    if (!pass1) throw new Error('correct-password login failed: ' + JSON.stringify({ status: r1.status, body: j1 }));

    // 2. Неверный пароль
    const r2 = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: 'wrong-wrong-wrong' }) });
    const j2 = await r2.json().catch(() => ({}));
    const pass2 = r2.status === 401 && j2.error === 'invalid-credentials';
    console.log(`[check] login(wrong): HTTP ${r2.status}, error=${j2.error} ${pass2 ? 'PASS' : 'FAIL'}`);
    if (!pass2) throw new Error('wrong-password should be 401 invalid-credentials');

    // 3. Удаление
    await admin.auth().deleteUser(uid);
    created = false;
    await client.query('DELETE FROM user_credentials WHERE uid=$1', [uid]);
    await client.query('DELETE FROM app_users WHERE uid=$1', [uid]);
    dbInserted = false;
    console.log('[check] user deleted from Firebase and DB');

    // 4. Вход после удаления
    const r3 = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: PASSWORD }) });
    const j3 = await r3.json().catch(() => ({}));
    const pass3 = r3.status === 401;
    console.log(`[check] login(after-delete): HTTP ${r3.status} ${pass3 ? 'PASS' : 'FAIL'}`);
    if (!pass3) throw new Error('deleted user should not login');

    console.log('[check] ИТОГ: ALL PASS');
  } catch (e) {
    console.error('[check] FAILED:', e?.message || e);
    await cleanup();
    await client.end().catch(() => {});
    process.exit(1);
  }
  await client.end();
}
main();
