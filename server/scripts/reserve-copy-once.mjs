// Explicit one-shot bootstrap/verification. Never enables a writer or failover.
import {pathToFileURL} from 'node:url';
import {captureReserveSnapshot,encodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {createReserveCheckpointStore} from '../src/reserve-firestore.mjs';
import {createPostgresOutbox} from '../src/reserve-postgres-outbox.mjs';
export function validateReserveEnvironment(env){
  if(env.RESERVE_UPLOAD_CONFIRMATION!=='samosval-offline/main_workspace'||env.FIREBASE_PROJECT_ID!=='samosval-offline'||env.POSTGRES_DB!=='samosval_test'||env.WORKSPACE_ID&&env.WORKSPACE_ID!=='main_workspace')throw Error('explicit-test-reserve-configuration-required');
  if(!env.GOOGLE_APPLICATION_CREDENTIALS||!env.POSTGRES_USER||!env.POSTGRES_PASSWORD)throw Error('reserve-service-credentials-required');
  if(env.FIRESTORE_EMULATOR_HOST)throw Error('live-reserve-must-not-target-emulator');
}
export async function copyReserveOnce({pool,store,capture=captureReserveSnapshot,outbox=null}){
  // A Firestore read-back proves archive integrity, not that NAS remained
  // unchanged while chunks uploaded. Recheck the physical source separately.
  const first=await capture(pool,{withOutboxHead:true});
  if(!first?.snapshot||!Number.isSafeInteger(first.outboxSequence)||first.outboxSequence<0)
    throw Error('reserve-bootstrap-outbox-head-required');
  const {snapshot,outboxSequence}=first;
  const expectedHash=encodeReserveCheckpoint(snapshot).manifest.hash;
  const checkpoint=await store.put(snapshot);
  if(checkpoint?.hash!==expectedHash||!await store.verify(checkpoint))throw Error('reserve-readback-not-verified');
  const latest=await capture(pool,{withOutboxHead:true});
  if(!latest?.snapshot||!Number.isSafeInteger(latest.outboxSequence))
    throw Error('reserve-bootstrap-outbox-head-required');
  const latestHash=encodeReserveCheckpoint(latest.snapshot).manifest.hash;
  if(latestHash!==expectedHash||latest.outboxSequence!==outboxSequence)
    throw Error('reserve-source-changed-during-copy');
  // If another mutation commits now, initializeReceipt rejects the changed
  // cursor; the archive must never resume from an unrelated transaction.
  if(outbox)await outbox.initializeReceipt({sequence:outboxSequence,hash:checkpoint.hash});
  // A matching source only proves equality at verification time. It does NOT
  // certify a live Firebase business adapter or enable automatic failover.
  return {status:'checkpoint-verified',...checkpoint,outboxSequence,
    outboxInitialized:!!outbox,sourceUnchangedAtVerification:true,failoverEnabled:false};
}
async function main(){
  validateReserveEnvironment(process.env);
  const [{default:pg},{initializeApp,applicationDefault,deleteApp},{getFirestore}]=await Promise.all([import('pg'),import('firebase-admin/app'),import('firebase-admin/firestore')]);
  const app=initializeApp({projectId:'samosval-offline',credential:applicationDefault()},'samosval-test-reserve');
  const pool=new pg.Pool({host:process.env.PGHOST||'postgres',port:Number(process.env.PGPORT||5432),database:'samosval_test',user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,max:1,connectionTimeoutMillis:10000});
  try{
    const store=createReserveCheckpointStore({firestore:getFirestore(app)});
    const outbox=createPostgresOutbox({pool,verifyCheckpoint:checkpoint=>store.verify(checkpoint)});
    console.log(JSON.stringify(await copyReserveOnce({pool,store,outbox})));
  }
  finally{await pool.end();await deleteApp(app);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('reserve-copy-failed',error?.code||error?.name||'unknown');process.exitCode=1;});
