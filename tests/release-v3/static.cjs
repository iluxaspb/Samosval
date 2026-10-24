const fs=require('fs'),vm=require('vm'),assert=require('assert'),crypto=require('crypto');
const html=fs.readFileSync('index.html','utf8'),old=fs.readFileSync('releases/3.0/index-before-release.html.txt','utf8'),test=fs.readFileSync('index-test.html','utf8');
const conf=s=>s.match(/const firebaseConfig = (\{[\s\S]*?\n  \});/)[1];
assert.equal(conf(html),conf(old));assert.notEqual(conf(html),conf(test));
assert(html.includes("PRODUCTION_FIREBASE_PROJECT_ID = 'samosval-test'"));assert(!html.includes('samosval-offline'));
assert(html.includes('Версия 3.0'));assert(!html.includes('Версия 3.0 · тест'));
for(const tag of ['<link rel="manifest" href="./manifest.json">','<link rel="icon" type="image/svg+xml" href="./icon.svg">','<meta name="theme-color" content="#0f172a">'])assert(html.includes(tag));
const refs=s=>s.slice(s.indexOf("const WORKSPACE_ID ="),s.indexOf('const TRASH_DAYS =')).replace(/\s+/g,' ');
assert.equal(refs(html),refs(old));
console.log('PASS exact production Firebase config, workspace, all collection paths, PWA metadata and version');
let parsed=0;for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){new vm.Script(m[1]);parsed++;}
for(const m of html.matchAll(/try \{ \(0, eval\)\(("(?:[^"\\]|\\.)*")\);/g))new vm.Script(JSON.parse(m[1]));
console.log('PASS syntax of '+parsed+' inline scripts and every embedded patch');
function fn(s,name){const start=s.indexOf('function '+name+'(');assert(start>=0,name);const end=s.indexOf('\n  function ',start+10);return s.slice(start,end);}
assert.equal(fn(html,'readLineState'),fn(old,'readLineState'));
console.log('PASS same active-shift validation as current production');
for(const project of ['samosval-test','samosval-offline']){
 const context={firebaseConfig:{projectId:project},WORKSPACE_ID:'main_workspace',currentUid:'same-user'};
 vm.createContext(context);vm.runInContext(html.match(/const offlineJournalKey=\(\)=>[^;]+;/)[0]+'result=offlineJournalKey()',context);
 if(project==='samosval-test')global.prodQueue=context.result;else assert.notEqual(context.result,global.prodQueue);
}
console.log('PASS offline queues isolated by Firebase project even with the same user and workspace');
const metadata=JSON.parse(fs.readFileSync('releases/3.0/release-manifest.json'));
assert.equal(crypto.createHash('sha256').update(html).digest('hex'),metadata.candidate_sha256);
console.log('PASS candidate checksum and rollback source recorded');
