// Stable, redacted, atomic JSON report writer.
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function refuse(message) { throw new Error(`report path is not approved: ${message}`); }

function redactText(text) {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1')
    .replace(/\b[a-f0-9]{64}\b/g, '[redacted]');
}

function stable(value) {
  if (Array.isArray(value)) {
    const items = value.map(stable);
    if (items.every(item => item && typeof item === 'object' && typeof item.file === 'string')) {
      items.sort((a, b) => a.file.localeCompare(b.file));
    }
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

export async function writeAtomicReport(path, report) {
  if (typeof path !== 'string' || path.length === 0 || !report || typeof report !== 'object' || Array.isArray(report)) refuse('path and report object are required');
  const destination = resolve(path);
  const directory = dirname(destination);
  let parent;
  try { parent = lstatSync(directory); } catch { refuse('report directory must exist'); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) refuse('report directory must be a real directory');
  try {
    const target = lstatSync(destination);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) refuse('existing report must be a single-link regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const safeReport = stable(report);
  const payload = `${JSON.stringify(safeReport, null, 2)}\n`;
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, payload, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    const directoryFd = openSync(directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return destination;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
