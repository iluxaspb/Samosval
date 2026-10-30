import {fail,map,parseKey} from './tabel-access.mjs';
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
export function presenceTarget(input){
  if(!map(input)||!validId(input.objectId)||input.objectId.startsWith('_')||!validId(input.sheetId))throw fail('invalid-presence-target');
  parseKey(input.objectId+'/sheet:'+input.sheetId);return {objectId:input.objectId,sheetId:input.sheetId};
}
export function presenceIntent(input){
  if(!map(input)||!validId(input.sessionId)||!Number.isSafeInteger(input.sequence)||input.sequence<1||!['write','remove'].includes(input.type))throw fail('invalid-presence-intent');
  const op={type:input.type,sessionId:input.sessionId,sequence:input.sequence};if(op.type==='remove')return op;
  Object.assign(op,presenceTarget(input));
  const selected=input.selection;
  if(selected===null)return {...op,selection:null};
  const cell=x=>typeof x==='string'&&/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(x);
  if(!map(selected)||!cell(selected.a)||!cell(selected.b))throw fail('invalid-selection');
  op.selection={a:selected.a,b:selected.b};
  if(selected.rowKeys!==undefined||selected.colKeys!==undefined){
    const keys=x=>Array.isArray(x)&&x.length<=1000&&x.every(v=>typeof v==='string'&&v.length>0&&v.length<=160);
    if(!keys(selected.rowKeys)||!keys(selected.colKeys))throw fail('invalid-selection');
    op.selection.rowKeys=[...new Set(selected.rowKeys)];op.selection.colKeys=[...new Set(selected.colKeys)];
  }
  if(Buffer.byteLength(JSON.stringify(op.selection))>16000)throw fail('selection-too-large',413);
  return op;
}
// Ephemeral, single API process state. No business record, audit or offline outbox.
export function createPresenceService({authorize,workspaceId='main_workspace',now=Date.now,ttlMs=120000,maxEntries=256,maxPerUser=8}={}){
  if(typeof authorize!=='function'||typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000||!Number.isSafeInteger(maxEntries)||maxEntries<1||!Number.isSafeInteger(maxPerUser)||maxPerUser<1)throw TypeError('invalid-presence-options');
  const rows=new Map(),key=(uid,id)=>JSON.stringify([uid,id]);
  const base=()=>({format:'samosval-tabel-presence',version:1,source:'synology',workspaceId});
  const prune=()=>{for(const [id,row] of rows)if(now()-row.seen>=ttlMs)rows.delete(id);};
  const access=async(uid,target)=>{const actor=await authorize(uid,target);if(actor?.uid!==uid||actor?.workspaceId!==workspaceId||typeof actor.name!=='string')throw fail('forbidden',403);return actor;};
  function room(uid){
    if([...rows.values()].filter(r=>r.uid===uid&&!r.removed).length>=maxPerUser)throw fail('presence-limit',429);
    if(rows.size>=maxEntries){const old=[...rows].find(([,r])=>r.removed);if(old)rows.delete(old[0]);else throw fail('presence-limit',429);}
  }
  return Object.freeze({
    async write(uid,input){
      if(typeof uid!=='string'||!uid)throw fail('unauthorized',401);
      const op=presenceIntent(input),started=now(),id=key(uid,op.sessionId);prune();
      if(op.type==='remove'){
        const previous=rows.get(id);if(previous&&previous.sequence>=op.sequence)return {...base(),ignored:true};
        if(!previous&&rows.size>=maxEntries)return {...base(),removed:true};
        rows.set(id,{uid,sessionId:op.sessionId,sequence:op.sequence,seen:now(),removed:true});return {...base(),removed:true};
      }
      const actor=await access(uid,op);prune();
      if(now()-started>=ttlMs)throw fail('presence-expired',409);
      const previous=rows.get(id);if(previous&&previous.sequence>=op.sequence)return {...base(),ignored:true};
      if(!previous||previous.removed)room(uid);
      const row={id:uid.length+':'+uid+':'+op.sessionId,uid,sessionId:op.sessionId,objectId:op.objectId,sheetId:op.sheetId,sequence:op.sequence,selection:op.selection,name:actor.name.slice(0,160),seen:now()};
      rows.set(id,row);return {...base(),record:structuredClone(row)};
    },
    async list(uid,input){
      if(typeof uid!=='string'||!uid)throw fail('unauthorized',401);
      const target=presenceTarget(input);await access(uid,target);prune();const peers=[],checks=new Map();
      for(const [id,row] of [...rows]){
        if(row.removed||row.uid===uid||row.objectId!==target.objectId||row.sheetId!==target.sheetId)continue;
        if(!checks.has(row.uid))checks.set(row.uid,access(row.uid,target));
        try{const actor=await checks.get(row.uid);if(rows.get(id)!==row||now()-row.seen>=ttlMs)continue;peers.push({...structuredClone(row),name:actor.name.slice(0,160)});}
        catch(error){if(error.status===403){if(rows.get(id)===row)rows.delete(id);}else throw error;}
      }
      // Access may have been revoked while checking peers; check the reader again.
      await access(uid,target);return {...base(),peers};
    }
  });
}
