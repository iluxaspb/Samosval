const {spawnSync}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'../..'),env={...process.env,NODE_PATH:path.join(root,'tests/timesheet/node_modules')},results=[];
const steps=[
 ['domain',['node','tests/tabel/domain.mjs']],
 ['new-ui',['node','tests/tabel/ui.cjs']],
 ['legacy-core',['node','tests/timesheet/core.cjs']],
 ['legacy-ui',['node','tests/timesheet/ui.cjs']],
 ['legacy-compact',['node','tests/timesheet/compact-ui.cjs']],
 ['legacy-crew',['node','tests/timesheet/crew-ui.cjs']],
 ['legacy-lifecycle',['node','tests/timesheet/lifecycle.cjs']],
 ['coins',['node','tests/coins/standalone.cjs']],
 ['proposals',['python3','test-app/tabel/prepare-protected-diffs.py']],
 ['proposed-pwa-not-applied',['node','tests/tabel/proposed-pwa.cjs']],
];
if(process.argv.includes('--emulator'))steps.push(['legacy-emulator',['node','tests/timesheet/emulator.cjs']],['sandbox-emulator',['node','tests/tabel/emulator.cjs']],['integrated-rule-proposal-not-applied',['node','tests/tabel/emulator.cjs'],{TABEL_RULES_PATH:'test-app/tabel/proposals/firestore.integrated-emulator.rules'}]);
if(process.argv.includes('--browser'))steps.push(['chromium-mobile',['node','tests/tabel/browser.cjs']]);
steps.push(['protected-paths',['python3','tests/tabel/guard.py']]);
for(const [name,[cmd,...args],extra]of steps){const start=Date.now();console.log('\nRUN '+name);const r=spawnSync(cmd,args,{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:180000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');results.push({name,status:r.status===0?'passed':'failed',durationMs:Date.now()-start});if(r.status!==0){process.exitCode=1;break;}}
fs.writeFileSync(path.join(root,'test-app/tabel/test-results.json'),JSON.stringify({moduleVersion:'1.0.0-test.1',environment:'Local synthetic data; Chromium mobile emulation, not a physical Android device',results,blocked:['Live test Firebase rules were not changed or read from deployed service','Installed PWA release retains old manifest until separate approval','Native Android share and keyboard geometry are not device-verified']},null,2)+'\n');
