import {encodeReserveCheckpoint,decodeReserveCheckpoint,canonicalReserve} from './reserve-checkpoint.mjs';
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
// All bytes are private service data, never browser-readable documents. A ready
// manifest is created LAST; interrupted uploads cannot become an active reserve.
export function createReserveCheckpointStore({firestore,maxBytes=64*1024*1024}={}){
  if(firestore?.projectId!=='samosval-offline'||typeof firestore.doc!=='function')throw TypeError('test-firestore-required');
  const root='test_failover/main_workspace/checkpoints/';
  const manifestRef=id=>{if(!digest(id))throw TypeError('invalid-checkpoint-id');return firestore.doc(root+id);};
  const chunkRef=(id,index)=>firestore.doc(root+id+'/chunks/'+String(index).padStart(6,'0'));
  async function create(ref,value,equal){
    try{await ref.create(value);}catch(error){
      if(![6,'6','already-exists'].includes(error?.code))throw error;
      const old=await ref.get();if(!old.exists||!equal(old.data()))throw Error('immutable-checkpoint-conflict');
    }
  }
  async function read(id){
    const doc=await manifestRef(id).get();if(!doc.exists)throw Error('checkpoint-not-ready');
    const manifest=doc.data();if(manifest.hash!==id)throw Error('checkpoint-id-mismatch');
    // Validate the bounded manifest before following its chunk references.
    if(!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>Math.ceil((maxBytes+65536)/1024))throw Error('invalid-checkpoint-manifest');
    const chunks=[];
    for(let index=0;index<manifest.chunks.length;index++){
      const doc=await chunkRef(id,index).get();if(!doc.exists)throw Error('checkpoint-chunk-missing');chunks.push(doc.data());
    }
    return decodeReserveCheckpoint(manifest,chunks,{maxBytes});
  }
  return Object.freeze({
    read,
    async put(snapshot){
      const {manifest,chunks}=encodeReserveCheckpoint(snapshot,{maxBytes});
      for(const chunk of chunks)await create(chunkRef(manifest.hash,chunk.index),chunk,old=>old.index===chunk.index&&old.hash===chunk.hash&&Buffer.isBuffer(old.data)&&old.data.equals(chunk.data));
      await create(manifestRef(manifest.hash),manifest,old=>canonicalReserve(old)===canonicalReserve(manifest));
      const verified=await read(manifest.hash);
      if(canonicalReserve(verified)!==canonicalReserve(snapshot))throw Error('checkpoint-readback-mismatch');
      return {hash:manifest.hash,bytes:manifest.bytes,packedBytes:manifest.packedBytes,chunks:chunks.length,counts:manifest.counts};
    },
    async verify(checkpoint){
      if(!digest(checkpoint?.hash))return false;
      try{await read(checkpoint.hash);return true;}catch{return false;}
    },
  });
}
