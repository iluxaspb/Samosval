import http from 'node:http';
import { Pool } from 'pg';

// Foundation only: no user data endpoints, no Firestore migration, no writes.
const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'];
for (const key of required) {
  if (!process.env[key] || process.env[key] === 'REPLACE_WITH_A_LONG_RANDOM_SECRET') {
    throw new Error(`Missing or unsafe configuration: ${key}`);
  }
}

const pool = new Pool({
  host: process.env.PGHOST ?? 'postgres',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 30000,
});

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  if (path === '/health/live') return send(res, 200, { status: 'ok' });
  if (path === '/health/ready') {
    try {
      await pool.query('SELECT 1');
      return send(res, 200, { status: 'ready', database: 'connected' });
    } catch {
      return send(res, 503, { status: 'unavailable' });
    }
  }
  return send(res, 404, { error: 'not_found' });
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, '0.0.0.0', () => {
  console.info(`Samosval API test bootstrap listening on port ${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
