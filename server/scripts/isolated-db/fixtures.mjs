const registry = new Map([
  ['import-schema', 10],
  ['identity-empty', 20],
  ['auth-schema-018', 30],
  ['authority-main-ubuntu', 40],
  ['authority-main-firebase', 50],
  ['replica-admin', 60],
  ['replica-empty-stream-cursors', 70],
]);

export const FIXTURE_IDS = Object.freeze([...registry.keys()]);

export async function applyFixtures(context, requested) {
  if (!context || Object.hasOwn(context, 'adminUrl') || Object.hasOwn(context, 'capability')
      || !context.fixtureClient || typeof context.fixtureClient.apply !== 'function'
      || typeof context.fixtureClient.verify !== 'function') throw new Error('fixture context is not approved');
  if (!Array.isArray(requested)) throw new Error('fixture list is not approved');
  const unique = new Set();
  for (const id of requested) {
    if (!registry.has(id)) throw new Error(`fixture is unavailable: ${id}`);
    if (unique.has(id)) throw new Error(`duplicate fixture: ${id}`);
    unique.add(id);
  }
  const ordered = [...unique].sort((left, right) => registry.get(left) - registry.get(right));
  const reports = [];
  for (const id of ordered) {
    await context.fixtureClient.apply(id);
    const postcondition = await context.fixtureClient.verify(id);
    if (!postcondition || postcondition.ok !== true) throw new Error(`fixture postcondition failed: ${id}`);
    reports.push(Object.freeze({ id, postcondition: Object.freeze({ ...postcondition }) }));
  }
  return reports;
}
