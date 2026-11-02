import test from 'node:test';
import assert from 'node:assert/strict';
import {presence} from '../../test-app/tabel-v2/presence.mjs';

test('local-only grid initializes and disposes presence without accessing Firebase', () => {
  const names=['document','MutationObserver','addEventListener','removeEventListener','setInterval','clearInterval'];
  const previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let disconnected=false, cleared=false, listenerCount=0;
  const listeners=new Map();
  const add=(name,fn)=>{listeners.set(name,fn);listenerCount++;};
  const remove=(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);listenerCount--;};
  try {
    Object.assign(globalThis,{
      document:{hidden:false,addEventListener:add,removeEventListener:remove},
      MutationObserver:class {observe(){} disconnect(){disconnected=true;}},
      addEventListener:add,removeEventListener:remove,
      setInterval:()=>42,clearInterval:id=>{assert.equal(id,42);cleared=true;},
    });
    for (const remote of [false,undefined]) {
      const updates=[];
      const state={remote,object:{id:'local'},root:{hidden:false,isConnected:true},
        host:{session:()=>({uid:'local-user'}),get workspace(){throw Error('Local grid must not access Firebase');}}};
      const controller=presence(state,(peers,message)=>updates.push({peers,message}));
      controller.update('linked','A1','A1',true);
      assert.deepEqual(updates[0].peers,[]);
      assert.match(updates[0].message,/после подключения Firebase/);
      controller.dispose();
      assert.equal(listenerCount,0);
    }
    assert.equal(disconnected,true);
    assert.equal(cleared,true);
  } finally {
    for (const [name,descriptor] of previous) {
      if(descriptor) Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  }
});
