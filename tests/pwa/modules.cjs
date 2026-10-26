const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const spec=JSON.parse(fs.readFileSync('test-app/modules.json')),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const baseline=process.env.BASELINE_HTML?fs.readFileSync(process.env.BASELINE_HTML,'utf8'):cp.execFileSync('git',['show',spec.baseline_commit+':index-test.html'],{encoding:'utf8',maxBuffer:3e6});
const blocks=[...baseline.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
const changes=new Set(['core','built-in-features','base','release-history','history-recorder','game-coins-v2','summary-viewer']);let preserved=0,corePreserved=0;
// Reviewed changes since modularization: remove photo dependencies and freeze configurable rewards.
// Every other core source must still match the published pre-change revision.
const changedCore=new Set(['00-config.js','02-session-state.js','06-sync.js','09-auth.js','12-export-drawing.js','13-reports.js','14-archive.js','18-shifts.js','20-offline-journal.js']);
const coreBaseline=JSON.parse(fs.readFileSync('tests/pwa/core-baseline.json')).sha256;
for(const m of spec.modules){
 const content=m.sources.map(p=>fs.readFileSync('test-app/src/'+p,'utf8')).join('');
 if(!changes.has(m.name)){assert.equal(sha(content),m.original_sha256,m.name);preserved++;}
 if(m.kind!=='style')new vm.Script(content,{filename:m.name});
 if(m.name==='core'){
  for(const p of m.sources){
   const file='test-app/src/'+p;
   assert(coreBaseline[file],'baseline must explicitly cover '+file);
   if(!changedCore.has(p.split('/').at(-1))){assert.equal(sha(fs.readFileSync(file)),coreBaseline[file],file+' must remain unchanged');corePreserved++;}
  }
 }
 if(m.name==='built-in-features'){
  const original=[...blocks[m.block][3].matchAll(/try \{ \(0, eval\)\(("(?:[^"\\]|\\.)*")\); \}\s*catch \(e\) \{[^\n]*\}/g)];assert.equal(original.length,m.sources.length);
  m.sources.forEach((p,i)=>{
   const expected=original[i][0].replace('(0, eval)('+original[i][1]+')',()=>JSON.parse(original[i][1]))+'\n';
   const actual=fs.readFileSync('test-app/src/'+p,'utf8').replace('    if (window.TestPWA) html = await window.TestPWA.inlineHtml(html);\n\n','');assert.equal(actual,expected,p);
  });
 }
}
const html=fs.readFileSync('index-test.html','utf8'),hydrated=require('../../tools/read-test-html.cjs')();
let scripts=0;for(const m of hydrated.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){new vm.Script(m[1]);scripts++;}
assert(!/<script[^>]+src="https?:/.test(html));assert(!/fonts.googleapis.com/.test(html));
const manifest=JSON.parse(fs.readFileSync('manifest-test.webmanifest'));assert.equal(manifest.scope,'./index-test.html');assert.equal(manifest.start_url,'./index-test.html');assert.equal(manifest.id,'./index-test.html');assert(manifest.icons.some(i=>i.sizes==='192x192'));assert(manifest.icons.some(i=>i.sizes==='512x512'));
const files=JSON.parse(fs.readFileSync('test-app/build-manifest.json')).assets;for(const a of files)assert.equal(sha(fs.readFileSync(a.url)),a.sha256,a.url);
console.log('PASS '+preserved+' unchanged blocks; '+corePreserved+' untouched core files match the published baseline; 13 built-in features preserved; '+scripts+' runtime scripts compile; all precache hashes verified');

// Only active administrators may see the release label or open the changelog.
const testCss=fs.readFileSync('test-app/src/styles/base.css','utf8');
const testAuth=fs.readFileSync('test-app/src/core/09-auth.js','utf8');
const testHistory=fs.readFileSync('test-app/src/features/release-history.js','utf8');
assert.match(testCss,/body:not\(\[data-release-admin="1"\]\) \.version-text/);
assert.match(testAuth,/permissionsLoaded && canAdmin\(\)/);
assert.match(testAuth,/setAttribute\('data-release-admin', '1'\)/);
assert.match(testHistory,/!permissionsLoaded \|\| typeof canAdmin/);
assert.match(html,/Версия 3\.1\.20 · тест/);
