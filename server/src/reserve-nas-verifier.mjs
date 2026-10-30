import {captureReserveSnapshot,encodeReserveCheckpoint} from './reserve-checkpoint.mjs';

// Read-only verification of the PHYSICAL TEST PostgreSQL dataset.
// An archived Firestore checkpoint alone cannot certify a Synology replica.
// This deliberately does not verify Firebase: its real operational adapter
// must be implemented and independently inspected before failover is enabled.
export function createNasReplicaVerifier({pool,maxBytes=64*1024*1024,capture=captureReserveSnapshot}={}) {
  if(!pool || typeof pool.connect!=='function' || typeof capture!=='function' ||
     !Number.isSafeInteger(maxBytes) || maxBytes<1)throw TypeError('invalid-nas-replica-verifier');
  return async(provider,checkpoint)=>{
    if(provider!=='synology' || !Number.isSafeInteger(checkpoint?.sequence) ||
       checkpoint.sequence<0 || !/^[a-f0-9]{64}$/.test(checkpoint?.hash||''))return false;
    try{
      const snapshot=await capture(pool);
      const {manifest}=encodeReserveCheckpoint(snapshot,{maxBytes});
      return manifest.hash===checkpoint.hash;
    }catch{
      // Unreachable PostgreSQL, unexpected schema, oversize or divergent rows:
      // deny authority; never treat a health/ready response as replica proof.
      return false;
    }
  };
}
