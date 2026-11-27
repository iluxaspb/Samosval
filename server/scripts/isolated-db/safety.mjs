export const GENERATED_DATABASE_PREFIX = 'samosval_parallel_shifts_test_';
export const BOOTSTRAP_MARKER = 'samosval-isolated-db-bootstrap:v1';

// A template is sealed or dropped only while no client session is attached to it.
// The rule names the only backend type a client can own: an autovacuum worker
// that happens to reach a freshly migrated template is neither a reader nor a
// writer of the sealed content, and PostgreSQL's own database-exclusivity check
// ignores such backends. Counting every `pg_stat_activity` row turned a real
// autovacuum worker into a false closed error inside `freezeTemplate` (see
// `docs/opyt-oshibok.md`), so the filter lives here as one source of truth.
export const CLIENT_BACKEND_FILTER = "backend_type='client backend'";

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
export const MAX_RUNID_LENGTH = 63 - Buffer.byteLength(GENERATED_DATABASE_PREFIX) - 1 - 12;
const RUNID = new RegExp(`^[a-f0-9]{12,${MAX_RUNID_LENGTH}}$`);
const HASH = /^[a-f0-9]{12}$/;
const RESERVED = new Set([
  'postgres', 'template0', 'template1', 'samosval_test',
  'samosval_working_test_reserve', 'samosval_parallel_shifts_test',
]);

function reject(label) { throw new Error(`${label} is not approved`); }

export function validateAdminUrl(input) {
  let url;
  try { url = new URL(input); } catch { reject('admin URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) reject('admin URL');
  if (!['127.0.0.1', 'localhost', '[::1]', 'postgres'].includes(url.hostname)) reject('admin URL');
  const approvedPort = url.hostname === 'postgres' ? '5432' : '55432';
  if (url.port !== approvedPort || url.pathname !== '/postgres' || url.search || url.hash || !url.username || !url.password) reject('admin URL');
  return url;
}

export function validateGeneratedIdentifier(value, options = {}) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || Buffer.byteLength(value, 'utf8') > 63 || RESERVED.has(value)) reject('generated identifier');
  if (options.runid !== undefined) {
    const { runid, kind } = options;
    if (!RUNID.test(runid)) reject('generated identifier');
    if (kind === 'target') {
      const suffix = value.slice(`${GENERATED_DATABASE_PREFIX}${runid}_`.length);
      if (!value.startsWith(`${GENERATED_DATABASE_PREFIX}${runid}_`) || !HASH.test(suffix)) reject('generated identifier');
    } else if (kind === 'template') {
      if (value !== `${GENERATED_DATABASE_PREFIX}${runid}_tpl_empty`
          && value !== `${GENERATED_DATABASE_PREFIX}${runid}_tpl_s24`
          && value !== `${GENERATED_DATABASE_PREFIX}${runid}_tpl_s25`
          && value !== `${GENERATED_DATABASE_PREFIX}${runid}_tpl_s26`) reject('generated identifier');
    } else reject('generated identifier');
  }
  return value;
}

export function quoteIdentifier(value) {
  validateGeneratedIdentifier(value);
  return `"${value.replaceAll('"', '""')}"`;
}
