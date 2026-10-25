const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const read = p => fs.readFileSync(p, 'utf8');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const spec = JSON.parse(read('app/modules.json'));
const html = read('index.html');
assert.equal(spec.release, '4.0');
assert(!/TEST-MODULE|TEST-PWA|tab-timesheet|nav-timesheet|test-app\//.test(html));
assert(html.includes('Версия 4.0'));
assert(html.includes('./manifest.json'));
assert(!/<script[^>]+src="https?:/.test(html));
assert(!spec.modules.some(m => /timesheet|review-config|test-review-core|work-report/.test(m.name)));
const original = read('releases/4.0/index-before-release.html.txt');
const config = s => s.match(/const firebaseConfig = (\{[\s\S]*?\n  \});/)[1];
assert.equal(config(read('app/src/core/00-config.js')), config(original));
assert(read('app/src/core/02-session-state.js').includes("PRODUCTION_FIREBASE_PROJECT_ID = 'samosval-test'"));
const journal = read('app/src/core/20-offline-journal.js');
const keyDefinition = journal.match(/const offlineJournalKey=[^\n]+/)[0];
assert(original.includes(keyDefinition), 'existing production journal key must remain stable');
const savedOperation = {id:'old-pending', shiftId:'shift-1', truckId:'truck-1', status:'pending', type:'load', expectedRevision:7, arrivalTimestamp:123, dependencyId:'old-arrival'};
const storage = new Map([['samosval_offline_v1_samosval-test_main_workspace_user-1', JSON.stringify([savedOperation])]]);
const ctx = {firebaseConfig:{projectId:'samosval-test'}, WORKSPACE_ID:'main_workspace', currentUid:'user-1', localStorage:{getItem:k=>storage.get(k), setItem:(k,v)=>storage.set(k,v)}, updateSyncUI(){}, console};
vm.createContext(ctx);
vm.runInContext(journal.slice(journal.indexOf('  const offlineJournalKey='), journal.indexOf('  function offlinePendingOps')), ctx);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.offlineJournalRead())), [savedOperation]);
assert(!/timesheet/.test(read('app/src/core/02-session-state.js')));
const changedSources = new Set(['core/00-config.js', 'core/02-session-state.js', 'features/html-export.js', 'features/release-history.js', 'styles/base.css']);
let preserved = 0;
for (const module of spec.modules) {
  const code = module.sources.map(p => read('app/src/' + p)).join('');
  for (const p of module.sources) {
    if (!changedSources.has(p)) { assert.equal(read('app/src/' + p), read('test-app/src/' + p), p); preserved++; }
  }
  if (module.kind !== 'style') new vm.Script(code, {filename: module.name});
}
const assets = JSON.parse(read('app/build-manifest.json')).assets;
for (const item of assets) {
  assert.equal(sha(fs.readFileSync(item.url)), item.sha256, item.url);
  assert(!/test-app|timesheet|index-test|manifest-test/.test(item.url));
}
let scripts = 0;
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  const src = m[1].match(/src="([^"]+)"/);
  new vm.Script(src ? read(src[1]) : m[2]); scripts++;
}
for (const m of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(\.\/[^"#]+)"/g)) assert(fs.existsSync(m[1]), m[1]);
assert(/\.version-text\s*\{[^}]*color:\s*#22c55e/.test(read('app/src/styles/base.css')));
assert(/\.version-text\s*\{[^}]*color:\s*#e11d48/.test(read('test-app/src/styles/base.css')));
assert(read('app/src/features/release-history.js').includes('color:#22c55e'));
const testBadgeRule = read('test-app/src/features/release-history.js').match(/\.version-text\{([^}]+)\}/)[1];
assert(!/(^|;)\s*color\s*:/.test(testBadgeRule), 'test history button keeps the red base style');
const historyMatch = read('app/src/features/release-history.js').match(/const releases\s*=\s*(\[[\s\S]*?\n  \]);/);
assert(historyMatch, 'release history is available');
const releases = vm.runInNewContext('(' + historyMatch[1] + ')');
assert.equal(releases[0].version, '4.0');
assert(read('docs/versioning.md').includes('зелён'));
console.log(`PASS production Firebase and existing offline journal; ${preserved} unchanged sources; no timesheet runtime; ${scripts} scripts compile; ${assets.length} asset hashes; green production/red test versions`);
