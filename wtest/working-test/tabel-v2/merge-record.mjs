// Reconcile independent Tabel edits against the latest server snapshot.
// Numeric values are protected; empty->value and cell formatting can merge
// without forcing the user to choose an entire sheet version.
const missing=Symbol("missing");
const object=x=>x!==missing&&x!==null&&typeof x==="object"&&!Array.isArray(x);
const own=(o,k)=>object(o)&&Object.hasOwn(o,k)?o[k]:missing;
const clone=x=>x===missing?missing:structuredClone(x);
function equal(a,b){
  if(a===missing||b===missing)return a===b;
  if(a===b)return true;
  if(typeof a!==typeof b||a===null||b===null)return false;
  if(Array.isArray(a)||Array.isArray(b))
    return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
  if(object(a)&&object(b)){
    const keys=new Set([...Object.keys(a),...Object.keys(b)]);
    return [...keys].every(k=>equal(own(a,k),own(b,k)));
  }
  return false;
}
const empty=x=>x===missing||x==null||x==="";
const dataField=path=>["raw","hours","crewHours","pumpHours","quantity"].includes(path.at(-1));
const structural=path=>path.at(-1)==="deleted"||path.at(-1)==="closed";
const meaningful=v=>!empty(v);
const isMetadata=path=>path.includes("style")||path.includes("widths")||
  path.includes("heights")||path.at(-1)==="numberFormat";
const identifiedArray=arr=>Array.isArray(arr)&&arr.every(e=>object(e)&&typeof e.id==="string"&&e.id);
export function mergeRecord(base,mine,server,key){
  // Access-control, shift registration and global directory modifications
  // are deliberately kept under their existing strict CAS checks.
  if(!/(?:\/day:\d{4}-\d\d-\d\d:(?:day|night)|\/sheet:[A-Za-z0-9_-]+)$/.test(key||""))
    return {merged:null,conflicts:["record-not-mergeable"]};
  const conflicts=[];
  function merge(b,m,s,path){
    if(equal(m,s))return clone(s);
    if(equal(m,b))return clone(s); // local field not edited
    if(structural(path)) {
      if(!equal(s,b)||meaningful(s)&&m!==s) {
        conflicts.push(path.join("."));
        return clone(s);
      }
      return clone(m);
    }
    if(isMetadata(path)) {
      // Cell fill, borders, sizes and number formats are presentation only.
      if(object(m)&&object(s)){
        const result={};
        for(const k of new Set([...Object.keys(s),...Object.keys(m),...Object.keys(object(b)?b:{})])){
          const x=merge(own(b,k),own(m,k),own(s,k),[...path,k]);
          if(x!==missing)result[k]=x;
        }
        return result;
      }
      return clone(m);
    }
    // Removing a whole cell/value object is also removal of its contained
    // numbers. Recurse down to raw/quantity instead of silently ignoring it.
    if(m===missing && object(s) && object(b)){
      const result={};
      for(const k of new Set([...Object.keys(s),...Object.keys(b)])){
        const x=merge(own(b,k),missing,own(s,k),[...path,k]);
        if(x!==missing)result[k]=x;
      }
      return result;
    }
    if(object(m)&&object(s)){
      const result={};
      for(const k of new Set([...Object.keys(s),...Object.keys(m),...Object.keys(object(b)?b:{})])){
        const x=merge(own(b,k),own(m,k),own(s,k),[...path,k]);
        if(x!==missing)result[k]=x;
      }
      return result;
    }
    if(Array.isArray(m)&&Array.isArray(s)){
      // A crew list can be edited per person. Preserve unrelated hours.
      if(identifiedArray(m)&&identifiedArray(s) && (b===missing||identifiedArray(b))){
        const bm=new Map((b===missing?[]:b).map(x=>[x.id,x]));
        const mm=new Map(m.map(x=>[x.id,x]));
        const sm=new Map(s.map(x=>[x.id,x]));
        const result=[];
        for(const id of new Set([...sm.keys(),...mm.keys()])){
          const x=merge(bm.has(id)?bm.get(id):missing,mm.has(id)?mm.get(id):missing,sm.has(id)?sm.get(id):missing,[...path,id]);
          if(x!==missing)result.push(x);
        }
        return result;
      }
      // Arrays describing composition, IDs, merge regions etc. must never
      // silently overwrite two divergent selections.
      if(equal(s,b))return clone(m);
      if(equal(m,b))return clone(s);
      conflicts.push(path.join("."));
      return clone(s);
    }
    if(dataField(path)){
      // A previously empty server cell can safely accept a first entry.
      if(empty(s)&&empty(b))return clone(m);
      // A server number/formula must not be replaced with a different value
      // or silently deleted, even if the revision changed for unrelated style.
      if(meaningful(s) && !equal(m,s)) {
        conflicts.push(path.join("."));
        return clone(s);
      }
      // A remote deletion of an existing value and a local rewrite must
      // require explicit choice rather than silently undoing that deletion.
      if(empty(s)&&meaningful(b)&&meaningful(m)){
        conflicts.push(path.join("."));
        return clone(s);
      }
      return clone(m);
    }
    // New entries for missing fields are safe, as are independent edits.
    if(equal(s,b)||empty(s))return clone(m);
    if(empty(m))return clone(s);
    // For nonnumeric fields (e.g. cosmetic labels), retain the local edit
    // when it really changed, without presenting numeric-value conflicts.
    return clone(m);
  }
  const result=merge(base===undefined?missing:base,
    mine===undefined?missing:mine,server===undefined?missing:server,[]);
  return {merged:result===missing?null:result,conflicts};
}
