// Импорт пользователей из экспорта Firebase Auth в samosval_working_test_reserve.
// Читает /secrets/firebase-auth-export.json и /secrets/firebase-hash-config.json
// (или пути из FIREBASE_EXPORT_PATH / FIREBASE_HASH_CONFIG_PATH).
// Пропускает дубликаты по uid/email в app_users; credentials upsert с algorithm='firebase-scrypt'.
// Секреты не логируются.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const FIREBASE_SCRYPT_ALGORITHM = 'firebase-scrypt';

function defaultNickname(email) {
  const name = String(email || '').split('@')[0].slice(0, 80);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Пользователь';
}

function option(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const exportPath = option('export', process.env.FIREBASE_EXPORT_PATH || '/secrets/firebase-auth-export.json');
const hashConfigPath = option('hash-config', process.env.FIREBASE_HASH_CONFIG_PATH || '/secrets/firebase-hash-config.json');
const dbName = option('db', process.env.POSTGRES_DB || 'samosval_working_test_reserve');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const [exportRaw, configRaw] = await Promise.all([
    readFile(exportPath, 'utf8'),
    readFile(hashConfigPath, 'utf8')
  ]);
  const exportData = JSON.parse(exportRaw);
  const hashConfig = JSON.parse(configRaw);
  const users = Array.isArray(exportData.users) ? exportData.users : [];

  // Проверка наличия ключевых полей конфига (без вывода значений)
  const cfgOk = hashConfig && typeof hashConfig.algorithm === 'string'
    && typeof hashConfig.signerKey === 'string' && hashConfig.signerKey.length > 0
    && typeof hashConfig.saltSeparator === 'string' && hashConfig.saltSeparator.length > 0
    && Number.isSafeInteger(hashConfig.rounds) && Number.isSafeInteger(hashConfig.memoryCost);
  if (!cfgOk) throw new Error('invalid-firebase-hash-config: missing required fields');
  console.log(`[import] config: algorithm=${hashConfig.algorithm} rounds=${hashConfig.rounds} memoryCost=${hashConfig.memoryCost} signerKeyLen=${hashConfig.signerKey.length} saltSeparatorLen=${hashConfig.saltSeparator.length}`);
  console.log(`[import] export: ${users.length} users from projectId=${exportData.projectId || '?'} exportedAt=${exportData.exportedAt || '?'}`);

  const client = new pg.Client({
    host: process.env.PGHOST || 'samosval-postgres-ubuntu',
    port: Number(process.env.PGPORT || 5432),
    database: dbName,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    let createdUsers = 0, existingUid = 0, existingEmail = 0, credUpserted = 0, skippedNoHash = 0, skippedInvalid = 0;
    const actions = [];
    for (const u of users) {
      const uid = String(u.localId || '').trim();
      const email = String(u.email || '').trim().toLowerCase();
      if (!uid || !email) { skippedInvalid++; continue; }
      if (!u.passwordHash || !u.salt) {
        skippedNoHash++;
        actions.push(`${email} skip:no-password-hash`);
        continue;
      }
      const uidRow = (await client.query('SELECT uid FROM app_users WHERE uid=$1', [uid])).rows[0];
      const emailRow = (await client.query('SELECT uid, email, protected, role FROM app_users WHERE LOWER(email)=LOWER($1)', [email])).rows[0];
      if (uidRow) {
        existingUid++;
        actions.push(`${email} exists:uid-match`);
      } else if (emailRow) {
        existingEmail++;
        actions.push(`${email} exists:email-match (uid=${emailRow.uid})`);
        // credential upsert ниже привязан к uid из экспорта; если uid отличается —
        // не создаём запись с чужим uid, чтобы не нарушить FK. Пропуск.
        continue;
      } else {
        await client.query(
          `INSERT INTO app_users(uid,email,display_name,role,status,profile)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uid, email, defaultNickname(email), 'viewer', 'active', { importedFromFirebase: true, importedAt: Date.now() }]
        );
        createdUsers++;
        actions.push(`${email} created`);
      }
      // credentials: upsert по uid (из экспорта). Если пользователь уже существует
      // под тем же uid — обновляем хеш на firebase-scrypt (пароль из Firebase).
      await client.query(
        `INSERT INTO user_credentials(uid,password_hash,salt,algorithm)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (uid) DO UPDATE SET
           password_hash=EXCLUDED.password_hash,
           salt=EXCLUDED.salt,
           algorithm=EXCLUDED.algorithm,
           changed_at=now()`,
        [uid, String(u.passwordHash), String(u.salt), FIREBASE_SCRYPT_ALGORITHM]
      );
      credUpserted++;
    }
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('[import] DRY-RUN — изменения откачены');
    } else {
      await client.query('COMMIT');
      console.log('[import] COMMIT OK');
    }
    console.log(`[import] итог: total=${users.length} created=${createdUsers} existingUid=${existingUid} existingEmail=${existingEmail} credentialsUpserted=${credUpserted} skippedNoHash=${skippedNoHash} skippedInvalid=${skippedInvalid}`);
    for (const a of actions) console.log('  -', a);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[import] FAILED:', e?.message || e); process.exit(1); });
