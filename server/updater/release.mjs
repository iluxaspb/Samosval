import {createHash} from 'node:crypto';
export const REPO='iluxaspb/Samosval';
export const MANIFEST_URL=`https://raw.githubusercontent.com/${REPO}/root/releases/nas-test.json`;
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function normalizeRelease(value){
 if(!value||value.format!=='samosval-api-release'||value.protocol!==1||value.channel!=='test'||!/^[a-f0-9]{40}$/.test(value.commit||'')||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version||'')||!hex(value.dependenciesSha256)||!hex(value.schemaSha256))throw Error('invalid-release');
 if(!Array.isArray(value.files)||!value.files.length||value.files.length>200)throw Error('invalid-release-files');
 const paths=new Set();let bytes=0;
 const files=value.files.map(f=>{
  if(!f||!/^src\/[a-z0-9-]+\.mjs$/.test(f.path)||paths.has(f.path)||!hex(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>1500000)throw Error('invalid-release-file');
  paths.add(f.path);bytes+=f.bytes;return {path:f.path,sha256:f.sha256,bytes:f.bytes};
 });
 if(bytes>12000000||!paths.has('src/index.mjs')||!paths.has('src/server-control.mjs'))throw Error('incomplete-release');
 // Only the audited TEST outbox migration is permitted. Never accept arbitrary
 // SQL or script paths, even from a legitimate-looking release manifest.
 const migrations=value.migrations??[];
 if(!Array.isArray(migrations)||migrations.length>1)throw Error('invalid-release-migrations');
 const migration=migrations[0];
 if(migration&&(
   migration.path!=='sql/014_reserve_outbox.sql'||!hex(migration.sha256)||
   !Number.isSafeInteger(migration.bytes)||migration.bytes<1||migration.bytes>150000))
   throw Error('invalid-release-migration');
 const previousSchemaSha256=migration?value.previousSchemaSha256:null;
 if(migration&&(!hex(previousSchemaSha256)||previousSchemaSha256===value.schemaSha256))
   throw Error('invalid-release-schema-transition');
 if(!migration&&value.previousSchemaSha256!=null)throw Error('unexpected-schema-transition');
 return {format:value.format,protocol:1,channel:'test',commit:value.commit,version:value.version,
   dependenciesSha256:value.dependenciesSha256,schemaSha256:value.schemaSha256,
   previousSchemaSha256,
   migrations:migration?[{path:migration.path,sha256:migration.sha256,bytes:migration.bytes}]:[],
   notes:String(value.notes||'').slice(0,2000),files};
}
export async function download(url,{limit=1500000,fetchImpl=fetch}={}){
 const r=await fetchImpl(url,{signal:AbortSignal.timeout(30000),redirect:'error',headers:{Accept:'application/json','User-Agent':'Samosval-Test-Updater/1'}});
 if(!r.ok)throw Error('download-http-'+r.status);
 const chunks=[];let length=0;
 for await(const chunk of r.body){length+=chunk.length;if(length>limit)throw Error('download-too-large');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export async function verifiedRelease({fetchImpl=fetch}={}){
 const manifest=normalizeRelease(JSON.parse(await download(MANIFEST_URL,{fetchImpl})));
 const data=JSON.parse(await download(`https://api.github.com/repos/${REPO}/actions/workflows/synology-server-tests.yml/runs?head_sha=${manifest.commit}&per_page=30`,{fetchImpl}));
 if(!Array.isArray(data.workflow_runs)||!data.workflow_runs.some(r=>r.head_sha===manifest.commit&&r.status==='completed'&&r.conclusion==='success'&&r.path==='.github/workflows/synology-server-tests.yml'))throw Error('release-ci-not-successful');
 return manifest;
}
export async function sourceBytes(release,file,fetchImpl=fetch){
 const bytes=await download(`https://raw.githubusercontent.com/${REPO}/${release.commit}/server/${file.path}`,{fetchImpl});
 if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error('source-checksum-mismatch');return bytes;
}

// The installed TEST worker must be bootstrapped to support migration plans.
// Existing workers fail closed on schema change; no generic SQL execution path.
export function planTestSchemaUpgrade(release,baseline){
 if(!baseline||!hex(baseline.schemaSha256)||!hex(baseline.dependenciesSha256)||
    release?.dependenciesSha256!==baseline.dependenciesSha256)
   throw Error('release-requires-bootstrap');
 if(release.schemaSha256===baseline.schemaSha256){
   if(release.migrations?.length)throw Error('unexpected-migration-for-current-schema');
   return null;
 }
 if(release.migrations?.length!==1||
    release.previousSchemaSha256!==baseline.schemaSha256||
    release.migrations[0].path!=='sql/014_reserve_outbox.sql')
   throw Error('release-requires-bootstrap');
 return release.migrations[0];
}
