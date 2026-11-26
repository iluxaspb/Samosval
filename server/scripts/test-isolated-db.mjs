#!/usr/bin/env node

import { readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { applyMigrations } from './apply-migrations.mjs';
import { transformLegacyMigrationGuard } from './isolated-db/legacy-guards.mjs';
import {
  adminPreflight,
  createTemplateBroker,
} from './isolated-db/admin.mjs';
import {
  cleanupTarget,
  leakCheck,
  makeRunIdentity,
  makeTargetName,
  provisionTarget,
  recoverPartialTarget,
  targetUrl,
} from './isolated-db/database.mjs';
import { prepareTemplates } from './isolated-db/templates.mjs';
import manifest from '../tests/db-test-manifest.mjs';
import { loadManifest } from './isolated-db/manifest.mjs';
import { discoverTests } from './isolated-db/discovery.mjs';
import { buildDbEnv, buildHarnessEnv, buildUnitEnv, HARNESS_ENV_REGISTRY } from './isolated-db/env.mjs';
import { runProcessGroup } from './isolated-db/process.mjs';
import { parseNodeEvents } from './isolated-db/reporter.mjs';
import { writeAtomicReport } from './isolated-db/report.mjs';
import { scheduleManifestJobs } from './isolated-db/scheduler.mjs';

const { Client, Pool } = pg;
const serverDirectory = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const testsDirectory = realpathSync(join(serverDirectory, 'tests'));
const requested = process.argv.slice(2);



function redact(text) {
  return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1');
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function approvedTestPath(input) {
  if (typeof input !== 'string' || input.startsWith('-') || !input.endsWith('.test.mjs')) {
    throw new Error('test path is not approved');
  }
  let canonical;
  try {
    canonical = realpathSync(isAbsolute(input) ? input : resolve(serverDirectory, input));
  } catch {
    throw new Error('test path is not approved');
  }
  const inside = relative(testsDirectory, canonical);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('test path is not approved');
  }
  return canonical;
}

function urlWithCredentials(base, database, username, password) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.search = '';
  url.hash = '';
  url.username = username;
  url.password = password;
  return url.href;
}

function envValues(source, generatedTarget) {
  const values = Object.fromEntries(Object.entries(HARNESS_ENV_REGISTRY)
    .filter(([, variable]) => source[variable] !== undefined)
    .map(([name, variable]) => [name, source[variable]]));
  if (generatedTarget) values['target-url'] = generatedTarget;
  if (generatedTarget) values['isolated-marker'] = '1';
  return values;
}

async function makeRunContext(source) {
  const adminUrl = source.SAMOSVAL_TEST_ADMIN_URL ?? source.SAMOSVAL_TEST_BOOTSTRAP_URL;
  const bootstrapUrl = source.SAMOSVAL_TEST_BOOTSTRAP_URL ?? adminUrl;
  if (!adminUrl || !bootstrapUrl) fail('privileged isolated database URL is required', 1);
  if (!source.SAMOSVAL_TEST_APP_PASSWORD) fail('SAMOSVAL_TEST_APP_PASSWORD is required', 1);

  const identity = makeRunIdentity();
  const preflight = new Client({ connectionString: adminUrl, application_name: 'samosval_i5_preflight' });
  const bootstrap = new Client({ connectionString: bootstrapUrl, application_name: 'samosval_i5_runner' });
  const createdTemplates = [];
  try {
    await preflight.connect();
    const endpoint = await preflight.query('SELECT inet_server_addr()::text AS address');
    await adminPreflight(preflight, adminUrl, { expectedServerAddress: endpoint.rows[0]?.address });
    await bootstrap.connect();
    const templateBroker = createTemplateBroker({
      bootstrapClient: bootstrap,
      runid: identity.runid,
      capability: identity.capability,
    });
    const templateUrl = database => urlWithCredentials(
      bootstrapUrl,
      database,
      new URL(bootstrapUrl).username,
      new URL(bootstrapUrl).password,
    );
    const templates = await prepareTemplates({
      runid: identity.runid,
      templateOperation: async request => {
        const result = await templateBroker.run({ ...request, capability: identity.capability });
        if (request.operation === 'createTemplate') createdTemplates.push(request.database);
        return result;
      },
      async migrateTemplate({ database, through }) {
        const pool = new Pool({ connectionString: templateUrl(database), max: 1 });
        try {
          await applyMigrations(pool, {
            through,
            transformSource: (sql, file) => transformLegacyMigrationGuard(sql, file, database),
          });
          await pool.query('ALTER SCHEMA public OWNER TO samosval_test_prepared_owner');
          await pool.query(`DO $own$ DECLARE item record; BEGIN
            FOR item IN SELECT c.relkind,c.relname FROM pg_class c
              JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP
              EXECUTE format('ALTER TABLE public.%I OWNER TO samosval_test_prepared_owner', item.relname);
            END LOOP;
          END $own$`);
          await pool.query(`DO $fn$ DECLARE item record; BEGIN
            FOR item IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) args
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.prokind='f' LOOP
              EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO samosval_test_prepared_owner', item.proname, item.args);
            END LOOP;
          END $fn$`);
        } finally {
          await pool.end();
        }
      },
      async queryTemplate(database, text, values) {
        const client = new Client({ connectionString: templateUrl(database) });
        await client.connect();
        try { return await client.query(text, values); } finally { await client.end(); }
      },
      async queryCatalog(text, values) { return bootstrap.query(text, values); },
    });
    return {
      identity,
      admin: preflight,
      bootstrap,
      adminUrl,
      bootstrapUrl,
      templateBroker,
      lifecycle: {
        bootstrapClient: bootstrap,
        runid: identity.runid,
        capability: identity.capability,
        templates,
      },
      host: new URL(adminUrl).hostname,
      port: Number(new URL(adminUrl).port || (new URL(adminUrl).hostname === 'postgres' ? 5432 : 55432)),
      tracked: [],
    };
  } catch (error) {
    for (const database of [...createdTemplates].reverse()) {
      await bootstrap.query({ text: `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, queryMode: 'simple' }).catch(() => {});
    }
    await preflight.end().catch(() => {});
    await bootstrap.end().catch(() => {});
    throw error;
  }
}

async function dropTemplates(context) {
  const names = ['S25', 'S24', 'empty'];
  for (const kind of names) {
    const template = context.lifecycle.templates.get(kind);
    if (!template) continue;
    await context.templateBroker.run({
      operation: 'dropTemplate',
      database: template.database,
      capability: context.lifecycle.capability,
    });
  }
}

async function grantTargetAccess(context, database) {
  const client = new Client({
    connectionString: urlWithCredentials(
      context.bootstrapUrl,
      database,
      new URL(context.bootstrapUrl).username,
      new URL(context.bootstrapUrl).password,
    ),
  });
  await client.connect();
  try {
    await client.query('GRANT USAGE ON SCHEMA public TO samosval_test_app, samosval_test_runtime');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO samosval_test_app');
    await client.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO samosval_test_app');
    await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO samosval_test_runtime');
  } finally {
    await client.end();
  }
}

async function main() {
  if (requested.length === 1 && requested[0] === '--list') {
    const discovery = await discoverTests(serverDirectory, { harnessFixtures: manifest.harnessFixtures });
    await loadManifest(manifest, { serverDirectory, discovered: discovery.roots });
    for (const entry of manifest.entries) console.log(`${entry.kind}\t${entry.discovery}\t${entry.file}`);
    console.log(`discovered=${discovery.roots.length} manifest=${manifest.entries.length} fixtures=${manifest.harnessFixtures.length}`);
    return 0;
  }

  if (process.env.SAMOSVAL_ISOLATED_TEST !== '1') {
    fail('SAMOSVAL_ISOLATED_TEST=1 is required', 1);
  }
  if (process.env.TEST_DATABASE_URL !== undefined) {
    fail('TEST_DATABASE_URL is runner-generated and must not be supplied', 1);
  }

  const discovery = await discoverTests(serverDirectory, { harnessFixtures: manifest.harnessFixtures });
  await loadManifest(manifest, { serverDirectory, discovered: discovery.roots });
  let testFiles;
  try {
    testFiles = requested.length
      ? requested.map(approvedTestPath)
      : readdirSync(testsDirectory).filter(name => name.endsWith('.test.mjs')).sort().map(name => approvedTestPath(join(testsDirectory, name)));
  } catch (error) {
    fail(error.message, 1);
  }

  const { createSignalController } = await import('./isolated-db/process.mjs');
  const signalController = createSignalController();
  const manifestByPath = new Map(manifest.entries.map(entry => [realpathSync(join(serverDirectory, entry.file)), entry]));
  const selected = testFiles.map(file => manifestByPath.get(file)).filter(Boolean);
  const needsTarget = selected.some(entry => entry.kind === 'db' || entry.file === 'tests/isolated-db-integration.test.mjs');
  const needsPrivileged = selected.some(entry => entry.kind !== 'unit');
  if (needsPrivileged && !process.env.SAMOSVAL_TEST_ADMIN_URL && !process.env.SAMOSVAL_TEST_BOOTSTRAP_URL) {
    fail('privileged isolated database URL is required for non-unit selection', 1);
  }

  let context;
  let setupFailure = null;
  if (needsTarget) {
    try { context = await makeRunContext(process.env); }
    catch (error) { setupFailure = error; }
  }

  let provisioningStopped = Boolean(setupFailure);
  let interrupted = null;
  const entries = testFiles.map((file, index) => {
    const metadata = manifestByPath.get(file);
    return {
      file: `${index}:${file}`,
      manifestFile: metadata?.file,
      testFile: file,
      metadata,
      timeoutMs: metadata?.timeoutMs ?? 60_000,
    };
  });

  const results = await scheduleManifestJobs({
    entries,
    jobs: 1,
    runJob: async entry => {
      if ((await signalController.wait()).signal) throw Object.assign(new Error('run interrupted'), { code: 'EINTERRUPTED' });
      if (provisioningStopped && (entry.metadata?.kind === 'db' || entry.metadata?.file === 'tests/isolated-db-integration.test.mjs')) {
        throw setupFailure ?? new Error('provisioning stopped');
      }
      let record;
      let receipt;
      let childTarget;
      let phase = 'setup';
      try {
        if (entry.metadata?.kind === 'db' || entry.metadata?.file === 'tests/isolated-db-integration.test.mjs') {
          const baseline = entry.metadata.baseline ?? 'S24';
          context.lifecycle.onState = state => {
            receipt = { database: makeTargetName(context.lifecycle.runid, entry.metadata.file), runid: context.lifecycle.runid, state };
          };
          record = await provisionTarget(context.lifecycle, { file: entry.metadata.file, baseline });
          context.tracked.push(record);
          await grantTargetAccess(context, record.database);
          childTarget = urlWithCredentials(
            targetUrl(record, { host: context.host, port: context.port }),
            record.database,
            'samosval_test_app',
            process.env.SAMOSVAL_TEST_APP_PASSWORD,
          );
          phase = 'running';
        }
        const childEnv = entry.metadata?.kind === 'db'
          ? buildDbEnv(process.env, { targetUrl: childTarget })
          : entry.metadata?.kind === 'harness-contract'
            ? buildHarnessEnv(process.env, {
                env: (entry.metadata?.env ?? [])
                  .filter(name => name === 'target-url' ? childTarget !== undefined : process.env[HARNESS_ENV_REGISTRY[name]] !== undefined),
                values: envValues(process.env, childTarget),
              })
            : buildUnitEnv(process.env);
        const result = await runProcessGroup({
          command: process.execPath,
          args: ['--test', '--experimental-test-isolation=none', entry.testFile],
          cwd: serverDirectory,
          env: childEnv,
          timeoutMs: entry.timeoutMs,
          forwardSignals: !signalController,
          signalController,
          redact,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        const parsed = parseNodeEvents(result.stdout, {
          allowedSkips: entry.metadata?.allowedSkips ?? [],
          secrets: context ? [context.lifecycle.capability] : [],
        });
        if (result.timedOut || result.exitCode !== 0 || !parsed.ok) {
          throw new Error(`test process failed: ${entry.metadata?.file ?? entry.testFile}`);
        }
        phase = 'assertion';
        if (record && context) {
          const cleaned = await cleanupTarget(context.lifecycle, record, { phase });
          context.tracked = context.tracked.filter(item => item.database !== record.database);
          return { status: 'passed', pid: result.pid, parsed, database: record.database, cleanup: cleaned.dropped ? 'complete' : 'already-absent' };
        }
        return { status: 'passed', pid: result.pid, parsed, database: null, cleanup: 'not-required' };
      } catch (error) {
        if (record) error.database = record.database;
        if (!record && entry.metadata?.kind !== 'db' && entry.metadata?.file !== 'tests/isolated-db-integration.test.mjs') {
          error.cleanup = 'not-required';
        }
        if (error?.code === 'ESAFETY') throw error;
        if (!record && context && receipt && ['creating', 'created'].includes(receipt.state)) {
          try {
            const recovery = await recoverPartialTarget(context.lifecycle, { database: receipt.database, runid: receipt.runid });
            error.database = recovery.recovered;
            error.recovery = recovery.recovered ? 'recovered' : null;
          }
          catch (recoveryError) { error.recovery = recoveryError.message; error.leak = true; }
        }
        if (record && context) {
          try {
            const cleaned = await cleanupTarget(context.lifecycle, record, { phase });
            context.tracked = context.tracked.filter(item => item.database !== record.database);
            error.cleanup = cleaned.dropped ? 'complete' : 'already-absent';
          } catch (cleanupError) {
            if (cleanupError?.code === 'ESAFETY') {
              error.leak = true;
            } else {
              provisioningStopped = true;
              error.cleanup = cleanupError.message;
              error.cleanupCode = cleanupError.code;
            }
          }
        }
        if (error.code === 'CLOSED_ERROR' || error.code === 'ESAFETY') provisioningStopped = true;
        throw error;
      }
    },
  });

  if (setupFailure) {
    for (const entry of entries) {
      if (!results.find(result => result.file === entry.file)) {
        results[entries.indexOf(entry)] = { file: entry.file, status: 'failed', error: setupFailure.message };
      }
    }
  }

  interrupted = interrupted ?? (await signalController.wait()).signal;
  let leak = { clean: true, leaks: [] };
  let cleanupFailure = null;
  if (context) {
    try { await dropTemplates(context); }
    catch (error) { cleanupFailure = error; }
    try { leak = await leakCheck(context.lifecycle, { tracked: context.tracked }); }
    catch (error) { cleanupFailure ??= error; }
    await context.bootstrap.end().catch(error => { cleanupFailure ??= error; });
    await context.admin.end().catch(error => { cleanupFailure ??= error; });
  }

  const reportPath = process.env.SAMOSVAL_ISOLATED_REPORT ?? process.env.ISOLATED_DB_REPORT;
  if (reportPath) {
    await writeAtomicReport(reportPath, {
      runid: context?.lifecycle.runid ?? null,
      selection: requested.length ? 'filtered' : 'full',
      files: results.map(result => ({
        file: result.file,
        status: result.status,
        error: result.error,
        cleanup: result.result?.cleanup ?? result.cleanup ?? null,
        database: result.result?.database ?? result.database ?? null,
        leak: result.result?.leak ?? result.leak ?? result.code === 'ESAFETY',
        recovery: result.result?.recovery ?? result.recovery ?? null,
      })),
      cleanup: cleanupFailure ? 'failed' : 'complete',
      leaks: leak.leaks,
      interrupted: Boolean(interrupted),
      originalSignal: interrupted,
    });
  }
  signalController.close();
  if (interrupted) {
    process.removeAllListeners(interrupted);
    process.kill(process.pid, interrupted);
  }
  const unconfirmedFileCleanup = results.some(result => result.status === 'failed'
    && result.cleanup !== 'complete'
    && result.cleanup !== 'already-absent'
    && result.code !== 'ESAFETY'
    && result.leak !== true);
  return setupFailure || cleanupFailure || !leak.clean || unconfirmedFileCleanup || results.some(result => result.status !== 'passed') ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = error.exitCode ?? 1;
}
