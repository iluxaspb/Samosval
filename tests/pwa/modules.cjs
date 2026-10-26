// Verify the CURRENT modular application, rather than asserting it still matches a historical buggy monolith.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const spec=JSON.parse(fs.readFileSync('test-app/modules.json')),manifest=JSON.parse(fs.readFileSync('test-app/build-manifest.json'));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const html=fs.readFileSync('index-test.html','utf8'),names=new Set(),sources=new Set();
let previous=-1,compiled=0;
for(const m of spec.modules){
 assert(!names.has(m.name),'Duplicate module '+m.name);names.add(m.name);
 for(const source of m.sources){assert(!sources.has(source),'Duplicate source '+source);sources.add(source);assert(!source.includes('..'),'Unsafe source path');}
 const content=m.sources.map(p=>fs.readFileSync('test-app/src/'+p,'utf8')).join('');
 const ext=m.kind==='style'?'css':'js',url='./test-app/build/'+manifest.version+'/'+m.name+'.'+ext;
 assert.equal(fs.readFileSync(url,'utf8'),content,'Stale built module '+m.name);
 const at=html.indexOf(url);assert(at>previous,'Missing or out-of-order module '+m.name);assert.equal(html.lastIndexOf(url),at,'Duplicated runtime module');previous=at;
 if(m.kind!=='style'){new vm.Script(content,{filename:m.name});compiled++;}
}
assert.equal(fs.readFileSync('./test-app/build/'+manifest.version+'/pwa.js','utf8'),fs.readFileSync('test-app/src/pwa.js','utf8'));
assert(!html.includes('<!-- TEST-MODULE:'));assert(!html.includes('<!-- TEST-PWA -->'));
const hydrated=require('../../tools/read-test-html.cjs')();let scripts=0;
for(const m of hydrated.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){new vm.Script(m[1]);scripts++;}
assert(!/<script[^>]+src="https?:/.test(html));assert(!/fonts.googleapis.com/.test(html));
const install=JSON.parse(fs.readFileSync('manifest-test.webmanifest'));
for(const key of ['scope','start_url','id'])assert.equal(install[key],'./index-test.html');
assert(install.icons.some(i=>i.sizes==='192x192'));assert(install.icons.some(i=>i.sizes==='512x512'));
for(const a of manifest.assets)assert.equal(sha(fs.readFileSync(a.url)),a.sha256,a.url);
const release=fs.readFileSync('test-app/src/features/release-history.js','utf8'),version=release.match(/version:'([^']+)'/)[1];
assert(html.includes('Версия '+version),'Shell version differs from release history');assert(release.includes("button.textContent='Версия '+releases[0].version;"),'Version must use current release');
assert(/\.version-text\s*\{[^}]*#e11d48/i.test(fs.readFileSync('test-app/src/styles/base.css','utf8')),'Test label must be red');
assert(html.includes('retryAccountCheck()'),'Registration recovery control missing');assert(!/export(?:CurrentReport|Archive)PDF|sendActiveReportToMax|appConfigNotifyPdf/.test(html),'Obsolete report control');

// Preserve current release requirements, not the obsolete pre-modularization hashes.
const testCss=fs.readFileSync('test-app/src/styles/base.css','utf8');
const testAuth=fs.readFileSync('test-app/src/core/09-auth.js','utf8');
assert.match(testCss,/body:not\(\[data-release-admin="1"\]\) \.version-text/);
assert.match(testAuth,/permissionsLoaded && canAdmin\(\)/);
assert.match(testAuth,/setAttribute\('data-release-admin', '1'\)/);
assert.match(testAuth,/if \(!versionAllowed\) document.getElementById\('releaseHistoryDialog'\)\?\.close\(\)/);
assert.match(release,/!permissionsLoaded \|\| typeof canAdmin/);
for(const historical of ['3.1.21','3.1.20','3.1.19','3.1.18'])assert(release.includes("version:'"+historical+" · тест'"),'Released history must remain intact');
assert.equal(version,'3.1.22 · тест');
assert(!/onclick="(?:toggleDrawMode|clearDrawings)|id="draw-canvas/.test(html),'Removed manual drawing controls must not return');
assert.equal(manifest.assets.length,46,'Current photo-free offline bundle must retain exactly 46 assets');
require('../photo-removal/build.cjs');
console.log('PASS current build: '+names.size+' ordered modules, '+sources.size+' sources, '+compiled+' compiled modules, '+scripts+' runtime scripts; exact source/build match, admin-only version/color/history, photo/drawing removal, PWA isolation and all cache hashes');
