import {readFile} from 'fs/promises';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

export async function getVersion() {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  return pkg.version;
}

export function healthPayload(now = new Date()) {
  return {status: 'ok', timestamp: now.toISOString()};
}

export function handleHealthRequest(req, res) {
  if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://localhost').pathname !== '/health') return false;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(healthPayload()));
  return true;
}
