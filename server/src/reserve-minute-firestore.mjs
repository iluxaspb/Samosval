// TEST Firestore Admin adapter for immutable minute packets only.
// Acknowledgement is external: the runner must verify readBack before
// advancing its durable PostgreSQL cursor. No browser access to this path.
import {canonicalReserve} from './reserve-checkpoint.mjs';
import {verifyMinuteReserveBatch} from './reserve-minute-replication.mjs';
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function createMinuteFirestoreStore({firestore}={}){
  if(firestore?.projectId!=='samosval-offline'||typeof firestore.doc!=='function')
    throw TypeError('test-firestore-required');
  const ref=id=>{
    if(!digest(id))throw TypeError('invalid-minute-batch-id');
    return firestore.doc('test_failover/main_workspace/minute_batches/'+id);
  };
  return Object.freeze({
    async putImmutable(batch){
      if(!verifyMinuteReserveBatch(batch))throw TypeError('invalid-minute-batch');
      const pointer=ref(batch.batchId);
      try{await pointer.create(batch.document);}catch(error){
        if(![6,'6','already-exists'].includes(error?.code))throw error;
        const found=await pointer.get();
        if(!found.exists||canonicalReserve(found.data())!==canonicalReserve(batch.document))
          throw Error('immutable-minute-batch-conflict');
      }
      return batch.batchId;
    },
    async readBack(id){
      const found=await ref(id).get();
      return found.exists?found.data():null;
    }
  });
}
