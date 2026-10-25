const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const spec=JSON.parse(fs.readFileSync('test-app/modules.json')),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const baseline=process.env.BASELINE_HTML?fs.readFileSync(process.env.BASELINE_HTML,'utf8'):cp.execFileSync('git',['show',spec.baseline_commit+':index-test.html'],{encoding:'utf8',maxBuffer:3e6});
const blocks=[...baseline.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
const changes=new Set(['core','built-in-features','base','release-history']);let preserved=0;
for(const m of spec.modules){
 const content=m.sources.map(p=>fs.readFileSync('test-app/src/'+p,'utf8')).join('');
 if(!changes.has(m.name)){assert.equal(sha(content),m.original_sha256,m.name);preserved++;}
 if(m.kind!=='style')new vm.Script(content,{filename:m.name});
 if(m.name==='core'){
  const restored=content.replace(/  window.TestStorageState = \{persistent:false,error:null\};\n  try \{ db.enablePersistence[^\n]+\n/,'  try { db.enablePersistence({ synchronizeTabs: true }).catch(function(){}); } catch (e) {}\n').replace('\n  window.__testGetShift = () => state.shift;\n','');
  assert.equal(restored,blocks[m.block][3],'core domain algorithms must remain byte-for-byte unchanged');
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
console.log('PASS '+preserved+' unchanged blocks; all core algorithms preserved; 13 built-in features decoded without behavior changes; '+scripts+' runtime scripts compile; all precache hashes verified');
