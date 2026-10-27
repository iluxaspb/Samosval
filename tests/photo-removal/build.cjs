// Run after tools/build-test.py. Old content-addressed releases may remain on disk,
// but the current TEST page and its offline cache must not load photo functionality.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const spec=JSON.parse(read('test-app/modules.json'));
const build=JSON.parse(read('test-app/build-manifest.json'));
const shell=read('test-app/src/shell.html');
const html=read('index-test.html');
const removed=new Set(['photo-files','object-photos-service','geo-photo-style','geo-photo-script','object-photos-style','object-photos-ui','local-photos-style','local-photos-ui']);
const names=new Set(spec.modules.map(m=>m.name));
for(const name of removed)assert(!names.has(name),`photo module still active: ${name}`);
for(const name of ['core','history-recorder','built-in-features','offline-feedback','timesheet-core','timesheet-app','work-report','trip-analytics','max-plate-notifications','game-coins-v2','road-arcade-core','road-arcade-runtime','road-arcade-ui']){
  assert(names.has(name),`unrelated feature missing: ${name}`);
}

// Match executable APIs and former controls, not historical release notes or
// old game_photo audit records, whose earned coin balances must still be read.
const photoRuntime=/\b(?:ObjectPhotos|PhotoFiles|openLocalPhotos|openObjectPhotos|__gamePhotoSaved|__attachArchivePhotos|photoStorageLimitBytes|hasObjectPhotos)\b|\bgetUserMedia\s*\(|\bImageCapture\s*\(|\bfirebase\s*\.\s*storage\s*\(/;
const photoControls=/\b(?:id|class|onclick|data-photo-object|data-photo-object-id)\s*=\s*["'][^"']*(?:admin-camera|geo-photo-|object-photos-|local-photos-|openObjectPhotos|openLocalPhotos)|\bdata-photo-object(?:-id)?\s*=|\baccept\s*=\s*["'][^"']*image\//i;
for(const [label,text] of [['shell',shell],['generated HTML',html]]){
  assert(!photoControls.test(text),`${label} still exposes photo controls`);
  assert(!/firebase-storage-compat/i.test(text),`${label} still imports Firebase Storage`);
  assert(!photoRuntime.test(text),`${label} still invokes photo code`);
}

const standalone=/^test-[0-9.]+-standalone/.test(build.channel || '');
const expectedBuildFiles=new Set(['pwa.js']);
const activeBuildPrefix=`./test-app/build/${build.version}/`;
if(!standalone) for(const m of spec.modules){
  const content=m.sources.map(p=>read('test-app/src/'+p)).join('');
  const filename=m.name+(m.kind==='style'?'.css':'.js');
  expectedBuildFiles.add(filename);
  assert(!photoRuntime.test(content),`${m.name} retains a live photo dependency`);
  assert.equal(read(`test-app/build/${build.version}/${filename}`),content,`stale generated module: ${m.name}`);
  assert(html.includes(activeBuildPrefix+filename),`current page does not load ${m.name}`);
}
for(const p of ['test-app/src/pwa.js','test-app/src/service-worker.js']){
  assert(!photoRuntime.test(read(p)),`${p} retains a live photo dependency`);
}

const assets=new Set(build.assets.map(a=>a.url));
for(const a of build.assets){
  assert(!/\/(?:photo-files|object-photos[^/]*|geo-photo[^/]*|local-photos[^/]*)\.(?:js|css)$/.test(a.url),`photo module remains in offline cache: ${a.url}`);
  assert(!/firebase-storage-compat/i.test(a.url),`Firebase Storage remains in offline cache: ${a.url}`);
  assert.equal(sha(fs.readFileSync(path.join(root,a.url))),a.sha256,`asset hash mismatch: ${a.url}`);
  if(a.url.startsWith('./test-app/build/')){
    assert(a.url.startsWith(activeBuildPrefix),`another release is precached: ${a.url}`);
    assert(expectedBuildFiles.has(a.url.slice(activeBuildPrefix.length)),`unexpected module is precached: ${a.url}`);
  }
}
if(!standalone) for(const filename of expectedBuildFiles)assert(assets.has(activeBuildPrefix+filename),`offline module missing: ${filename}`);
for(const vendor of ['firebase-app-compat-10.8.0.js','firebase-auth-compat-10.8.0.js','firebase-firestore-compat-10.8.0.js','html2pdf-0.10.1.bundle.min.js']){
  assert(assets.has('./test-app/vendor/'+vendor),`required vendor removed from offline cache: ${vendor}`);
}
if(standalone){
  const vm=require('node:vm');
  assert.equal(html.match(/<meta name="test-app-build" content="([^"]+)"/)[1],build.version,'page build differs from manifest');
  assert(assets.has('./index-test.html'),'standalone page missing from offline cache');
  assert(!html.includes('./test-app/build/'),'standalone page loads obsolete generated modules');
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=/.test(match[1]) || /application\/(json|ld\+json)/.test(match[1]))continue;
    new vm.Script(match[2]);
  }
  for(const id of ['game-coins-v2','road-shop-v1'])assert(html.includes('id="'+id+'"'),'standalone feature missing: '+id);
}
const worker=read('sw-test.js');
const precache=worker.match(/^const RECORDS = (.*);$/m);
assert(precache,'generated worker has no precache records');
assert.deepEqual(JSON.parse(precache[1]),build.assets,'worker cache does not match the current release');
assert(worker.includes(`const VERSION = '${build.version}';`),'worker release differs from the page');

console.log(`PASS photo-free TEST build ${build.version}: no camera controls, photo APIs, uploader or Storage SDK; business modules and exact offline cache retained`);
