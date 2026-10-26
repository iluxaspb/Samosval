const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'results');fs.mkdirSync(out,{recursive:true});
const tests=[
 'tests/pwa/modules.cjs','tests/pwa/service-worker.cjs','tests/pwa/client-state.cjs','tests/pwa/release-version.cjs','tests/pwa/build-determinism.py',
 ...['auth','auth-confirmation','shift-regression','shift-ui','offline-regression','offline-ownership','offline-receipts-regression','receipt-history-integration','reward-receipts-integration','archive-coins-integration','permissions-core','permissions-ui','undo-freeze','reports-png','reports-max','reports-snapshot','reports-edit','reports-effective','reports-data','reports-summary','notification-rendering','backup-roundtrip','backup-safety','backup-files','backup-history','browser-support.test'].map(n=>'tests/full-audit/'+n+'.cjs'),
 ...['undo','status','transactions','ui','jokes','seasons','themes','regression'].map(n=>'tests/modular/'+n+'.cjs'),
 ...['core','ui','compact-ui','crew-ui','lifecycle'].map(n=>'tests/timesheet/'+n+'.cjs')
];
tests.push('tests/selector-reset/builtin.cjs','tests/selector-reset/dom.cjs','tests/coins/admin-settings.cjs','tests/coins/test-parity.cjs','tests/photo-removal/build.cjs','tests/photo-removal/core.cjs');
const results=[];
for(const file of tests){
 const start=Date.now(),r=cp.spawnSync(file.endsWith('.py')?'python3':process.execPath,[file],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4e6});
 const result={file,status:r.status===0&&!r.error?'passed':'failed',exit:r.status,durationMs:Date.now()-start,error:r.error?.message||null};
 fs.writeFileSync(path.join(out,file.replaceAll('/','_')+'.log'),(r.stdout||'')+(r.stderr||'')+(result.error||''));
 results.push(result);console.log(result.status.toUpperCase(),file,result.durationMs+'ms');
 if(result.status==='failed')console.log((r.stdout||'')+(r.stderr||'')+(result.error||''));
}
fs.writeFileSync(path.join(out,'regressions.json'),JSON.stringify({createdAt:new Date().toISOString(),tests:results},null,2)+'\n');
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
