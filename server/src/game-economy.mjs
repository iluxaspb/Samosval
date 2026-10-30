// Pure reward rules mirrored from TEST; parity is checked against the UI source.

  const levels=[{at:0,name:'🦺 Новичок на линии'},{at:25,name:'👀 Зоркий учётчик'},{at:100,name:'📋 Мастер отметок'},{at:500,name:'⚙️ Знаток фрезы'},{at:1000,name:'🏗️ Опора бригады'},{at:5000,name:'👑 Легенда фрезеровки'}];
  const rank=n=>levels.filter(x=>n>=x.at).at(-1)||levels[0];
  const key=s=>String(s||'').trim().toLowerCase();
  const objectKey=s=>s?.objectId?'id:'+s.objectId:s?.objectName?'name:'+s.objectName:'';
  function scopedRecords(rows){
    const shifts=new Map(),seen=new Set();
    return rows.slice().sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)||String(a.id).localeCompare(String(b.id))).filter(e=>{if(!e.id||seen.has(e.id))return false;seen.add(e.id);return true;}).map(e=>{
      const ops=e.history?.operations||[];
      for(const o of ops)if(o.collection==='shift'&&o.before?.id)shifts.set(o.before.id,o.before);
      const shiftId=e.shiftId||ops.map(o=>o.after?.shiftId||o.before?.shiftId).find(Boolean)||'';
      const known=shifts.get(shiftId)||{};
      const scope={shiftId,objectId:e.objectId||known.objectId||'',objectName:e.objectName||known.objectName||''};
      if(e.eventType==='game_penalty'&&e.scope)Object.assign(scope,e.scope);
      for(const o of ops)if(o.collection==='shift'&&o.after?.id&&!e.history?.undone)shifts.set(o.after.id,o.after);
      return {...e,scope};
    });
  }
  function scopeFor(e){return scopedRecords([...records.filter(x=>x.id!==e.id),{...e,id:e.id||e.history?.id||'scope'}]).find(x=>x.id===(e.id||e.history?.id||'scope'))?.scope||{};}
  function objectOptions(rows){
    const options=new Map();
    for(const e of scopedRecords(rows)){const k=objectKey(e.scope);if(k)options.set(k,{key:k,name:e.scope.objectName||e.scope.objectId});}
    for(const o of state.objects||[])options.set('id:'+o.id,{key:'id:'+o.id,name:o.name});
    return [...options.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  }
  const rewardDefaults=Object.freeze({load:1,arrive:2,ttn:0}),rewardLimit=10000;
  const rewardValue=(n,fallback)=>Number.isInteger(n)&&n>=0&&n<=rewardLimit?n:fallback;
  function rewardSchedule(policy={}){
    return (Array.isArray(policy.gameRewardSchedule)?policy.gameRewardSchedule:[])
      .filter(r=>r&&Number.isFinite(r.effectiveAt)&&r.effectiveAt>0&&['load','arrive','ttn'].every(k=>rewardValue(r[k],null)!==null))
      .slice().sort((a,b)=>a.effectiveAt-b.effectiveAt);
  }
  function rewardsAt(policy={},at=Date.now()){
    let rates=rewardDefaults;
    for(const r of rewardSchedule(policy)){if(r.effectiveAt>at)break;rates=r;}
    return {load:rates.load,arrive:rates.arrive,ttn:rates.ttn};
  }
  function rewardSnapshot(policy,action,recordedAt){
    const at=Number.isFinite(action?.at)&&action.at>0?action.at:recordedAt;
    return {version:1,actionAt:at,actionId:String(action?.id||''),kind:String(action?.type||''),...rewardsAt(policy,at)};
  }
  function recordedRewards(e){
    const r=e.history?.gameRewards;
    // No snapshot means an older release: keep its original 1 / 2 / 0 economics.
    return r?.version===1?{load:rewardValue(r.load,1),arrive:rewardValue(r.arrive,2),ttn:rewardValue(r.ttn,0)}:rewardDefaults;
  }

  // Rebuild rewards globally before filtering: later undo/delete affects the original scope.
  function calculate(records,filter={}){
    const entries=scopedRecords(records),origins=new Map(),rewards=new Map(),penalties=[],activeTtn=new Map(),cancelled=new Map(),archivedLoads=new Map();
    const slot=(o,e)=>(o.id+':'+(o.after?.shiftId||o.before?.shiftId||e.scope.shiftId||''));
    const ttnId=(o,e)=>'ttn:'+slot(o,e)+':'+(Number.isFinite(o.after?.ttnRevision)?'rev:'+o.after.ttnRevision:'event:'+(e.history?.gameRewards?.actionId||e.id));
    function candidates(e){
      const ops=e.history?.operations||[],rates=recordedRewards(e),user=key(e.userEmail||e.history?.userEmail),name=e.userName||e.history?.user||user,at=e.history?.gameRewards?.actionAt||e.timestamp||0;
      const loading=ops.some(o=>o.collection==='logs'&&!o.before&&o.after),archiving=ops.some(o=>o.collection==='archive'&&o.after),out=[];
      for(const o of ops){const b=o.before||{},a=o.after||{};
        if(o.collection==='logs'&&!o.before&&o.after&&a.clientOperationId)out.push(['load:'+o.id,{user:key(a.createdByEmail)||user,name:a.createdBy||name,coins:rates.load,kind:'load',scope:e.scope,at,eventId:e.id}]);
        if(o.collection==='truckStatus'){
          if(a.arriveTimestamp&&a.arriveTimestamp!==b.arriveTimestamp&&b.lastLoadTimestamp&&a.arriveTimestamp>b.lastLoadTimestamp)out.push(['arrive:'+o.id+':'+(a.shiftId||'')+':'+a.arriveTimestamp,{user,name,coins:rates.arrive,kind:'arrive',scope:e.scope,at,eventId:e.id}]);
          if(o.before&&o.after&&!b.ttnStatus&&a.ttnStatus&&!loading&&!archiving)out.push([ttnId(o,e),{user,name,coins:rates.ttn,kind:'ttn',scope:e.scope,slot:slot(o,e),at,eventId:e.id}]);
        }
      }
      return out;
    }
    const remove=(id,e,description)=>{const r=rewards.get(id)||origins.get(id);if(r&&!cancelled.has(id))cancelled.set(id,{...r,at:e.timestamp||Date.now(),description});rewards.delete(id);};
    for(const e of entries)if(e.history)for(const [id,r] of candidates(e))if(!origins.has(id))origins.set(id,r);
    for(const e of entries){
      if(e.eventType==='game_penalty'){if(e.amount===-3&&e.targetEmail)penalties.push(e);continue;}
      if(!e.history)continue;
      if(e.history.undone){for(const [id,r] of candidates(e))if(origins.has(id))cancelled.set(id,{...r,at:e.timestamp||r.at,description:'Отменено начисление за действие'});continue;}
      const ops=e.history.operations||[];
      for(const op of ops)if(op.collection==='archive'&&op.after?.sourceShiftId)for(const log of op.after.logs||[])archivedLoads.set(op.after.sourceShiftId+':'+log.id,log);
      const loading=ops.some(o=>o.collection==='logs'&&!o.before&&o.after),archiving=ops.some(o=>o.collection==='archive'&&o.after);
      for(const o of ops){const b=o.before||{},a=o.after||{};
        if(o.collection==='logs'&&!o.after){
          const saved=archivedLoads.get(b.shiftId+':'+o.id);
          const archived=!!saved&&saved.truckId===b.truckId&&saved.timestamp===b.timestamp&&saved.createdByEmail===b.createdByEmail;
          if(!archived)remove('load:'+o.id,e,'Отменено начисление за погрузку');
        }
        if(o.collection==='truckStatus'){
          if(b.arriveTimestamp&&o.after&&!a.arriveTimestamp&&!loading&&!archiving&&a.shiftId===b.shiftId&&a.lastResetOperationId===b.lastResetOperationId&&a.lastLoadTimestamp===b.lastLoadTimestamp)remove('arrive:'+o.id+':'+(b.shiftId||'')+':'+b.arriveTimestamp,e,'Отменено начисление за возвращение');
          if(o.after&&b.ttnStatus&&!a.ttnStatus&&!loading&&!archiving){const k=slot(o,e),id=activeTtn.get(k);if(id)remove(id,e,'Отменено начисление за ТТН');activeTtn.delete(k);}
        }
      }
      for(const [id] of candidates(e)){const r=origins.get(id);if(r.kind==='ttn')activeTtn.set(r.slot,id);rewards.set(id,r);cancelled.delete(id);}
    }
    const users=new Map(),matches=s=>(!filter.shiftId||s.shiftId===filter.shiftId)&&(!filter.objectKey||objectKey(s)===filter.objectKey);
    function row(user,name){if(!users.has(user))users.set(user,{user,name,coins:0,loads:0,arrivals:0,ttns:0,penalties:0});return users.get(user);}
    for(const r of rewards.values()){if(!r.user||!matches(r.scope))continue;const u=row(r.user,r.name);u.coins+=r.coins;u[r.kind==='load'?'loads':r.kind==='ttn'?'ttns':'arrivals']++;}
    for(const e of penalties){if(!matches(e.scope))continue;const u=row(key(e.targetEmail),e.targetName||e.targetEmail);u.coins-=3;u.penalties++;}
    const result=[...users.values()].sort((a,b)=>b.coins-a.coins||a.name.localeCompare(b.name,'ru'));
    result.movements=[];
    for(const [id,r] of origins){if(!r.user||!r.coins||!matches(r.scope))continue;
      result.movements.push({id:'earned:'+id,user:r.user,name:r.name,amount:r.coins,at:r.at,description:({load:'Погрузка',arrive:'Возвращение после погрузки',ttn:'Забрал ТТН'}[r.kind]||'Начисление'),scope:r.scope});
      if(!rewards.has(id)){const c=cancelled.get(id);if(c)result.movements.push({id:'reversed:'+id,user:r.user,name:r.name,amount:-r.coins,at:c.at,description:c.description,scope:r.scope});}
    }
    for(const e of penalties){if(!matches(e.scope))continue;result.movements.push({id:'penalty:'+e.id,user:key(e.targetEmail),name:e.targetName||e.targetEmail,amount:-3,at:e.timestamp||0,description:e.description||'Штраф за отмену действия',scope:e.scope});}
    return result;
  }
  export {calculate,rewardsAt,rewardSnapshot};

