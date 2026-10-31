// TEST-only repair of a phone's lost Firestore ACK after the typed reserve
// history was safely replayed to PostgreSQL. The server stores a normalized
// operation for SQL business-rule replay; this verifier accepts only the
// EXACT original Firebase intent for that same UID and immutable operation ID.
// No command is applied and no receipt/history/outbox is inserted here.
import {createHash} from 'node:crypto';

const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const testDatabase=name=>name==='samosval_test'||/^sc_verify_[0-9]+$/.test(name||'');
export async function exactSparkReplayAlias(client,{uid,op,stored}={}){
 if(!client?.query||!op||typeof op.id!=='string'||
    typeof uid!=='string'||stored?.outcome!=='confirmed')
  return false;
 const db=(await client.query('SELECT current_database() AS name')).rows[0]?.name;
 // Never enable this compatibility behavior in a production PostgreSQL DB.
 if(!testDatabase(db))return false;
 let result;
 try{
  result=await client.query(
   "SELECT plan FROM reserve_spark_replay_checkpoint WHERE singleton=true AND workspace_id='main_workspace' AND state='applied'");
 }catch(error){
  // SQL 015 is still not installed on existing TEST 4.1.1 NAS. Preserve
  // normal 409 ID-reuse semantics until the verified schema is installed.
  if(error?.code==='42P01')return false;
  throw error;
 }
 const plan=result.rows[0]?.plan;
 if(plan?.format!=='spark-typed-pg-dry-run'||plan?.version!==1||
    !Array.isArray(plan.operations)||plan.operations.length!==plan.eventCount)
  return false;
 const matching=plan.operations.filter(s=>s.operationId===op.id&&s.uid===uid);
 if(matching.length!==1)return false;
 const event=matching[0];
 if(event.originalRequestHash!==hash(op)||event.pgReceipt?.outcome!=='confirmed'||
    event.pgReceipt?.status===undefined)
  return false;
 // The already-committed PostgreSQL receipt must match the saved plan, not
 // merely the ID; otherwise never report a false positive to the phone.
 return canonical(stored.status)===canonical(event.pgReceipt.status)&&
  canonical(stored.log||null)===canonical(event.pgReceipt.log||null);
}
