// Explicit one-shot bootstrap/verification. Never enables a writer or failover.
import {pathToFileURL} from 'node:url';
import {captureReserveSnapshot} from '../src/reserve-checkpoint.mjs';
import {createReserveCheckpointStore} from '../src/reserve-firestore.mjs';
export function validateReserveEnvironment(env){
  if(env.RESERVE_UPLOAD_CONFIRMATION!=='samosval-offline/main_workspace'||env.FIREBASE_PROJECT_ID!=='samosval-offline'||env.POSTGRES_DB!=='samosval_test'||env.WORKSPACE_ID&&env.WORKSPACE_ID!=='main_workspace')throw Error('explicit-test-reserve-configuration-required');
  if(!env.GOOGLE_APPLICATION_CREDENTIALS||!env.POSTGRES_USER||!env.POSTGRES_PASSWORD)throw Error('reserve-service-credentials-required');
  if(env.FIRESTORE_EMULATOR_HOST)throw Error('live-reserve-must-not-target-emulator');
}
export async function copyReserveOnce({pool,store}){
  const snapshot=await captureReserveSnapshot(pool);
  const checkpoint=await store.put(snapshot);
  if(!await store.verify(checkpoint))throw Error('reserve-readback-not-verified');
  return {status:'checkpoint-verified',...checkpoint,failoverEnabled:false};
}
async function main(){
  validateReserveEnvironment(process.env);
  const [{default:pg},{initializeApp,applicationDefault,deleteApp},{getFirestore}]=await Promise.all([import('pg'),import('firebase-admin/app'),import('firebase-admin/firestore')]);
  const app=initializeApp({projectId:'samosval-offline',credential:applicationDefault()},'samosval-test-reserve');
  const pool=new pg.Pool({host:process.env.PGHOST||'postgres',port:Number(process.env.PGPORT||5432),database:'samosval_test',user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,max:1,connectionTimeoutMillis:10000});
  try{console.log(JSON.stringify(await copyReserveOnce({pool,store:createReserveCheckpointStore({firestore:getFirestore(app)})})));}
  finally{await pool.end();await deleteApp(app);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('reserve-copy-failed',error?.code||error?.name||'unknown');process.exitCode=1;});
