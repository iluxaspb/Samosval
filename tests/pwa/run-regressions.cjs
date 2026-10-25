const {spawnSync}=require('node:child_process');
for(const name of ['undo','status','transactions','ui','jokes','seasons','themes','regression']){
 const r=spawnSync(process.execPath,['tests/modular/'+name+'.cjs'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
}
