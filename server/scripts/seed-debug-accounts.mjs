#!/usr/bin/env node
// Тестовые учётки ролей для отладочной смены аккаунта (только тестовая линия).
//
// Создаёт по одной активной учётке на роль (старший прораб, прораб, мастер,
// лопатер, наблюдатель) и копирует им пароль администратора: в таблице
// user_credentials лежат только хеш, соль и алгоритм, поэтому пароль нигде не
// хранится и в репозиторий не попадает. Повторный запуск безопасен: профили
// обновляются, пароль синхронизируется с админским.
//
// Строка подключения: TEST_DATABASE_URL или POSTGRES_* (как у API).
// Администратор: --admin <email>, иначе владелец из identity_state, иначе
// первый активный администратор.
//
// Защита от рабочей базы: скрипт отказывается работать, если имя базы входит
// в список production-имён, без явного --force.
import pg from 'pg';
import { fileURLToPath } from 'node:url';

// Адреса обязаны совпадать с working-test/source/features/debug-accounts.js.
export const DEBUG_ACCOUNTS = Object.freeze([
  { uid: 'debug_senior_foreman', role: 'senior_foreman', email: 'debug-senior@debug.samosval.test', name: 'Тест: Старший прораб' },
  { uid: 'debug_foreman', role: 'foreman', email: 'debug-foreman@debug.samosval.test', name: 'Тест: Прораб' },
  { uid: 'debug_master', role: 'master', email: 'debug-master@debug.samosval.test', name: 'Тест: Мастер' },
  { uid: 'debug_lopater', role: 'lopater', email: 'debug-lopater@debug.samosval.test', name: 'Тест: Лопатер' },
  { uid: 'debug_viewer', role: 'viewer', email: 'debug-viewer@debug.samosval.test', name: 'Тест: Наблюдатель' },
]);

const PRODUCTION_DATABASES = new Set(['samosval', 'samosval_prod', 'samosval_production', 'samosval_main']);

export function buildPool(env = process.env) {
  if (env.TEST_DATABASE_URL) return new pg.Pool({ connectionString: env.TEST_DATABASE_URL, max: 2 });
  return new pg.Pool({
    host: env.PGHOST || 'postgres',
    port: Number(env.PGPORT || 5432),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    max: 2,
  });
}

function parseArgs(argv) {
  const options = { admin: '', force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--admin') options.admin = String(argv[++index] || '');
    else throw new Error('неизвестный параметр: ' + arg);
  }
  return options;
}

export async function resolveAdmin(client, email) {
  const columns = 'SELECT uid,email,role,status,profile FROM app_users WHERE role=\'admin\' AND status=\'active\' AND profile->>\'deleted\' IS DISTINCT FROM \'true\'';
  if (email) {
    const row = (await client.query(columns + ' AND LOWER(email)=LOWER($1)', [email])).rows[0];
    if (!row) throw new Error('администратор не найден: ' + email);
    return row;
  }
  const owner = (await client.query('SELECT owner_uid FROM identity_state WHERE id=1')).rows[0]?.owner_uid;
  if (owner) {
    const row = (await client.query(columns + ' AND uid=$1', [owner])).rows[0];
    if (row) return row;
  }
  const any = (await client.query(columns + ' ORDER BY uid LIMIT 1')).rows[0];
  if (!any) throw new Error('в базе нет активного администратора');
  return any;
}

// Создание/обновление тестовых учёток. Возвращает сводку без секретов.
export async function seedDebugAccounts(pool, options = {}) {
  const client = await pool.connect();
  try {
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    if (PRODUCTION_DATABASES.has(database) && !options.force) {
      throw new Error('база ' + database + ' похожа на рабочую; запуск остановлен (нужен --force)');
    }
    const admin = await resolveAdmin(client, options.admin);
    // Копировать целиком: рабочая тестовая база может содержать Firebase
    // SCRYPT credentials (password_hash/salt/algorithm/password_reset_required),
    // а не только локальные scrypt-sha256 записи.
    const credential = (await client.query('SELECT password_hash,salt,algorithm,password_reset_required FROM user_credentials WHERE uid=$1', [admin.uid])).rows[0];
    if (!credential) throw new Error('у администратора нет пароля: ' + admin.email);

    const summary = { database, admin: admin.email, dryRun: !!options.dryRun, accounts: [] };
    if (options.dryRun) {
      summary.accounts = DEBUG_ACCOUNTS.map(account => ({ ...account, action: 'would-upsert' }));
      return summary;
    }

    await client.query('BEGIN');
    try {
      for (const account of DEBUG_ACCOUNTS) {
        const existing = (await client.query('SELECT uid,role FROM app_users WHERE uid=$1 OR LOWER(email)=LOWER($2)', [account.uid, account.email])).rows[0];
        if (existing && existing.uid !== account.uid) throw new Error('адрес уже занят другой учёткой: ' + account.email);
        await client.query(
          `INSERT INTO app_users(uid,email,display_name,status,role,profile)
           VALUES ($1,$2,$3,'active',$4,$5)
           ON CONFLICT (uid) DO UPDATE
             SET email=EXCLUDED.email, display_name=EXCLUDED.display_name,
                 status='active', role=EXCLUDED.role,
                 profile=app_users.profile || EXCLUDED.profile,
                 revision=app_users.revision+1`,
          [account.uid, account.email, account.name, account.role, { debugAccount: true, createdAt: Date.now() }],
        );
        await client.query(
          `INSERT INTO user_credentials(uid,password_hash,salt,algorithm,password_reset_required)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (uid) DO UPDATE
             SET password_hash=EXCLUDED.password_hash, salt=EXCLUDED.salt,
                 algorithm=EXCLUDED.algorithm,
                 password_reset_required=EXCLUDED.password_reset_required,
                 changed_at=now()`,
          [account.uid, credential.password_hash, credential.salt, credential.algorithm, !!credential.password_reset_required],
        );
        summary.accounts.push({ uid: account.uid, role: account.role, email: account.email, action: existing ? 'updated' : 'created' });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    return summary;
  } finally {
    client.release();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const pool = buildPool();
  try {
    const summary = await seedDebugAccounts(pool, options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('ошибка: ' + (error.message || error));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
