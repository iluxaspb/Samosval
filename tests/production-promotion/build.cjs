const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),cp=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8'),spec=JSON.parse(read('app/modules.json')),html=read('index.html'),manifest=JSON.parse(read('app/build-manifest.json'));
assert.equal(spec.release,'3.4.50');assert.equal(spec.channel,'production-with-timesheet');
assert(html.includes('nav-tabel-v2'));assert(!/test-app\/|index-test\.html|manifest-test|TEST-MODULE/.test(html));
const before=cp.execFileSync('git',['show',spec.source_commit+':app/src/core/00-config-state.js'],{encoding:'utf8'}),after=read('app/src/core/00-config-state.js');
const config=s=>s.match(/const firebaseConfig = \{[\s\S]*?\n  \};/)[0];assert.equal(config(after),config(before));
const journal=read('app/src/core/15-shifts.js'),oldJournal=cp.execFileSync('git',['show',spec.source_commit+':app/src/core/15-shifts.js'],{encoding:'utf8'});
assert.equal(journal.match(/const offlineJournalKey[^\n]+/)[0],oldJournal.match(/const offlineJournalKey[^\n]+/)[0]);
for(const m of spec.modules)new vm.Script(m.sources.map(p=>read('app/src/'+p)).join(''),{filename:m.name});
assert(read('app/src/pwa.js').includes("register('./sw.js',{scope:'./'"));assert(read('app/src/service-worker.js').includes("PREFIX = 'samosval-shell-'"));
for(const a of manifest.assets){assert(!a.url.includes('test-app/'));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(a.url)).digest('hex'),a.sha256,a.url);}
for(const name of fs.readdirSync('app/tabel-v2').filter(p=>p.endsWith('.mjs'))){const s=read('app/tabel-v2/'+name);assert(!s.includes('samosval-offline'),name);assert(manifest.assets.some(a=>a.url==='./app/tabel-v2/'+name),name);}
assert(read('app/src/features/release-history.js').includes("version:'3.4.50'"));assert(read('app/src/shell.html').includes('color: #22c55e !important'));
console.log('PASS production Firebase config and offline journal preserved; all scripts compile; timesheet runtime included; no test paths; all '+manifest.assets.length+' hashes verified');
