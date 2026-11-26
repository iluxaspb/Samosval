// Child environment construction for the isolated database suite (I5).
//
// Every child environment is built from a positive allowlist (spec 3.5): the
// parent environment is never copied and filtered. Anything that is not on
// the list below cannot reach a child process, no matter how it is spelled.
// Database credentials, admin URLs and node startup flags are only ever set
// through the closed harness registry below, for files that declared the
// dependency in the manifest.

/** Environment a unit child may inherit: tooling, locale, harness markers. */
export const UNIT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'ISOLATED_DB_SENTINEL',
  'ISOLATED_DB_SIGNAL_FIXTURE',
  'ISOLATED_DB_HTTP_FORCED_FAILURE',
  'ISOLATED_DB_PROCESS_LOG',
];

/**
 * Closed registry of run-scoped harness dependencies a manifest entry may
 * declare. The key is the manifest name; the value is the child variable.
 */
export const HARNESS_ENV_REGISTRY = {
  'admin-url': 'SAMOSVAL_TEST_ADMIN_URL',
  'bootstrap-url': 'SAMOSVAL_TEST_BOOTSTRAP_URL',
  'app-password': 'SAMOSVAL_TEST_APP_PASSWORD',
  'runtime-password': 'SAMOSVAL_TEST_RUNTIME_PASSWORD',
  'maintenance-password': 'SAMOSVAL_TEST_MAINTENANCE_PASSWORD',
  'target-url': 'TEST_DATABASE_URL',
  'isolated-marker': 'SAMOSVAL_ISOLATED_TEST',
};

function requireEnvSource(source) {
  if (source === null || typeof source !== 'object') {
    throw new Error('environment source is not approved');
  }
  return source;
}

function copyAllowlisted(source) {
  const child = {};
  for (const name of UNIT_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined) {
      child[name] = source[name];
    }
  }
  return child;
}

/** Environment for a unit child: exactly the allowlist, nothing else. */
export function buildUnitEnv(source) {
  requireEnvSource(source);
  return copyAllowlisted(source);
}

function requireApprovedTargetUrl(targetUrl) {
  if (typeof targetUrl !== 'string' || !targetUrl.startsWith('postgresql://')) {
    throw new Error('the target URL is not approved for a database child');
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('the target URL is not approved for a database child');
  }
  if (!parsed.hostname || parsed.pathname === '' || parsed.pathname === '/') {
    throw new Error('the target URL is not approved for a database child');
  }
  return targetUrl;
}

/**
 * Environment for a db child: the unit allowlist, exactly one generated target
 * URL, the isolated marker and only the harness dependencies the manifest
 * entry declared (spec 3.10: schema setup runs on a privileged bootstrap
 * connection while the assertions run as the unprivileged app role). No
 * orchestration/admin URL is ever implied here; it must be declared by name.
 */
export function buildDbEnv(source, { targetUrl, env = [], values = {} } = {}) {
  const child = buildUnitEnv(source);
  child.TEST_DATABASE_URL = requireApprovedTargetUrl(targetUrl);
  child.SAMOSVAL_ISOLATED_TEST = '1';
  if (!Array.isArray(env)) {
    throw new Error(`environment dependency list is not approved: ${typeof env}`);
  }
  for (const name of env) {
    // `target-url` and `isolated-marker` are always set above; declaring them
    // again is harmless and resolves to the same values.
    if (name === 'target-url' || name === 'isolated-marker') continue;
    const variable = HARNESS_ENV_REGISTRY[name];
    if (variable === undefined) {
      throw new Error(`environment dependency is not approved: ${String(name)}`);
    }
    if (!values || !Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`no run value: ${name}`);
    }
    child[variable] = values[name];
  }
  return child;
}

/**
 * Environment for a harness-contract child: the unit allowlist plus exactly
 * the dependencies the manifest entry declared, from the closed registry.
 */
export function buildHarnessEnv(source, { env, values }) {
  requireEnvSource(source);
  if (!Array.isArray(env)) {
    throw new Error(`environment dependency list is not approved: ${typeof env}`);
  }
  const child = copyAllowlisted(source);
  for (const name of env) {
    const variable = HARNESS_ENV_REGISTRY[name];
    if (variable === undefined) {
      throw new Error(`environment dependency is not approved: ${String(name)}`);
    }
    if (!values || !Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`no run value: ${name}`);
    }
    child[variable] = values[name];
  }
  return child;
}
