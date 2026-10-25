// Use the modular builder; never replace the generated page with stale assets copies.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const result=spawnSync('python3',['tools/build-test.py'],{cwd:path.resolve(__dirname,'../..'),stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
