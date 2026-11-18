/* This realm only: every Storage API key is scoped before any SDK runs.
 * Other windows keep their native Storage prototype and cannot share our keys.
 * IndexedDB names are scoped too, including transitive table modules and SDKs.
 * No existing key is read, copied, migrated, cleared or removed.
 */
(() => {
  'use strict';
  const prefix = 'wt_' + encodeURIComponent(location.pathname) + ':';
  const proto = Storage.prototype;
  const native = Object.fromEntries(['getItem','setItem','removeItem','key','clear'].map(k=>[k,proto[k]]));
  const length = Object.getOwnPropertyDescriptor(proto,'length').get;
  const keys = storage => Array.from({length:length.call(storage)},(_,i)=>native.key.call(storage,i)).filter(k=>k?.startsWith(prefix));
  proto.getItem = function(k){return native.getItem.call(this,prefix+String(k));};
  proto.setItem = function(k,v){return native.setItem.call(this,prefix+String(k),v);};
  proto.removeItem = function(k){return native.removeItem.call(this,prefix+String(k));};
  proto.key = function(i){const key=keys(this)[i];return key===undefined?null:key.slice(prefix.length);};
  proto.clear = function(){for(const k of keys(this))native.removeItem.call(this,k);};
  Object.defineProperty(proto,'length',{configurable:true,get(){return keys(this).length;}});
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name,...args){return open.call(this,prefix+String(name),...args);};
  const remove = IDBFactory.prototype.deleteDatabase;
  IDBFactory.prototype.deleteDatabase = function(name){return remove.call(this,prefix+String(name));};
  // Logical keys can retain their module-specific formats; physical names can
  // never overlap production, TEST, or a different pathname.
  window.WorkingTestStorage = Object.freeze({prefix});
})();
