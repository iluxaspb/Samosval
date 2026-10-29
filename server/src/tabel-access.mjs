import { isDeepStrictEqual } from 'node:util';
export const fail = (code, status = 400) => Object.assign(new Error(code), {code, status});
export const map = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseKey(key) {
  if (typeof key !== 'string' || key.length > 250 || !/^[A-Za-z0-9_-]+\/(?:config|day:\d{4}-\d{2}-\d{2}:(?:day|night)|sheet:[A-Za-z0-9_-]+)$/.test(key)) throw fail('invalid-record-key');
  const [objectId, part] = key.split('/');
  return {objectId, recordId:key.replace(/[/:]/g,'~'), part};
}
export const manager = actor => actor.status === 'active' && ['admin','foreman'].includes(actor.role);
export function canView(actor) {
  return actor.status === 'active' && (manager(actor) || actor.permissions.includes('tab_timesheet'));
}
function grant(actor, config, id) {
  const acl = config?.sheetAccess?.[id];
  return acl?.users?.[actor.uid] === true || acl?.roles?.[actor.role] === true;
}
export function canRead(actor, key, config) {
  if (!canView(actor)) return false;
  const {part} = parseKey(key);
  return manager(actor) || part === 'config' || grant(actor, config, part.startsWith('day:') ? 'linked' : part.slice(6));
}
export function canWrite(actor, key, data, old, config) {
  if (!canView(actor) || !(actor.role === 'admin' || actor.permissions.includes('timesheet_edit'))) return false;
  if (manager(actor)) return true;
  const {part} = parseKey(key);
  if (part === 'config') return !!old && isDeepStrictEqual(data.sheetAccess ?? {}, old.sheetAccess ?? {});
  return canRead(actor,key,config) && (!old || ['name','deleted'].every(k => Object.hasOwn(data,k) === Object.hasOwn(old,k) && isDeepStrictEqual(data[k],old[k])));
}
export function validateJob(job) {
  if (!map(job)) throw fail('invalid-operation');
  parseKey(job.key);
  if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(job.id)) throw fail('invalid-operation-id');
  if (!map(job.data) || !map(job.before) || !Number.isSafeInteger(job.before.revision) || job.before.revision < 0 || !(job.before.data === null || map(job.before.data))) throw fail('invalid-record');
  if (job.before.revision === 0 && job.before.data !== null) throw fail('invalid-base');
  if (job.label !== undefined && (typeof job.label !== 'string' || job.label.length > 500)) throw fail('invalid-label');
  for (const data of [job.data, job.before.data]) if (Buffer.byteLength(JSON.stringify(data)) > 350000) throw fail('record-too-large',413);
}
