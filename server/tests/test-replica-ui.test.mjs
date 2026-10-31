import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
test('control-center local navigation does not inherit the fixed global bottom nav',()=>{
 const s=readFileSync(new URL('test-app/source/core/22-server-control.js',root),'utf8');
 const css=readFileSync(new URL('test-app/source/styles/style-04.css',root),'utf8');
 assert.match(css,/nav\s*\{\s*position:\s*fixed/);
 assert.match(s,/<div class="sc-nav" role="group"/);
 assert.doesNotMatch(s,/<nav class="sc-nav"/);
 assert.match(s,/data-sc-section/);
 assert.match(s,/serverControlSection==='replication'/);
 assert.match(s,/readyForFailover/);
});
test('TEST client refuses silent auto-failover until business adapters are fenced',()=>{
 const s=readFileSync(new URL('test-app/source/core/20-backend-mode.js',root),'utf8');
 assert.match(s,/if\(isNasRuntime\(\)\)return 'synology'/);
 assert.match(s,/select\.disabled = !allowed \|\| isNasRuntime\(\)/);
 assert.match(s,/mode === 'synology'/);
});

test('isolated auto candidate requires explicit shell meta; normal TEST stays on Firebase',()=>{
 const mode=readFileSync(new URL('test-app/source/core/20-backend-mode.js',root),'utf8');
 const runtime=readFileSync(new URL('test-app/source/core/21-nas-runtime.js',root),'utf8');
 const shell=readFileSync(new URL('test-app/source/shell.html',root),'utf8');
 assert.match(runtime,/synology-auto-candidate/);
 // The isolated candidate talks directly to free Firestore Spark.
 // No Cloud Run/HTTPS reserve proxy is permitted to silently reappear.
 assert.match(runtime,/spark-typed-line-reader\.mjs/);
 assert.match(runtime,/spark-line-writer\.mjs/);
 assert.match(runtime,/createSparkAutoLineClient/);
 assert.doesNotMatch(runtime,/test-reserve-api-url|createTestAutoLineClient/);
 assert.match(mode,/isTestAutoNasRuntime\(\)/);
 assert.match(mode,/остальные операции временно недоступны/);
 assert.doesNotMatch(shell,/test-data-provider[^>]*synology-auto-candidate/);
});
