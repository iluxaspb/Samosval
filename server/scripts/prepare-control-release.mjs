// Run from repo root only after committing tested source. Produces immutable source hashes.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {digest} from '../updater/release.mjs';
const root=new URL('../../',import.meta.url),server=new URL('server/',root),pkg=JSON.parse(readFileSync(new URL('package.json',server)));
const dependenciesSha256=digest(JSON.stringify({dependencies:pkg.dependencies,engines:pkg.engines}));
const sqlFiles=readdirSync(new URL('sql/',server)).filter(x=>x.endsWith('.sql')).sort();
const schemaDigest=names=>digest(names.map(x=>x+'\n'+readFileSync(new URL('sql/'+x,server))).join('\n'));
const schemaSha256=schemaDigest(sqlFiles);
const baseline={dependenciesSha256,schemaSha256};
if(process.argv.includes('--baseline')){process.stdout.write(JSON.stringify(baseline,null,2)+'\n');}
else{
 if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('Commit source before preparing a release');
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),version=process.argv[2];
 if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version||''))throw Error('Release version required');
 const files=readdirSync(new URL('src/',server)).filter(x=>x.endsWith('.mjs')).sort().map(x=>{const b=readFileSync(new URL('src/'+x,server));return {path:'src/'+x,sha256:digest(b),bytes:b.length};});
 // Explicit opt-in: only the first additive TEST outbox schema release
 // carries SQL. Later API-only releases do not re-run migration 014.
 const migrationOptIn=process.argv.includes('--with-outbox-migration');
 const previousSchemaSha256=migrationOptIn?schemaDigest(sqlFiles.filter(x=>x!=='014_reserve_outbox.sql')):undefined;
 if(migrationOptIn&&!sqlFiles.includes('014_reserve_outbox.sql'))throw Error('outbox-migration-source-missing');
 const migrationBytes=migrationOptIn?readFileSync(new URL('sql/014_reserve_outbox.sql',server)):null;
 const migrations=migrationOptIn?[{path:'sql/014_reserve_outbox.sql',sha256:digest(migrationBytes),bytes:migrationBytes.length}]:[];
 writeFileSync(new URL('releases/nas-test.json',root),JSON.stringify({
   format:'samosval-api-release',protocol:1,channel:'test',version,commit,...baseline,
   ...(migrationOptIn?{previousSchemaSha256}:{}),migrations,
   notes:migrationOptIn?'TEST: проверенная SQL-миграция журнала без включения Firebase failover':'Проверенное обновление серверного кода TEST',files
 },null,2)+'\n');
}
