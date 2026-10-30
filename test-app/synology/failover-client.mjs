// Physical server selection is shared authority, never a local preference.
const modes=new Set(['auto','synology','firebase']);
const names={synology:'Synology',firebase:'Firebase'};
export function failoverAdminView(state,{activeAdmin=false,online=true,busy=false}={}) {
  if(!activeAdmin)return {visible:false,disabled:true};
  const valid=state?.format==='samosval-test-failover' && state.version===1 &&
    state.projectId==='samosval-offline' && state.workspaceId==='main_workspace' &&
    modes.has(state.mode) && Object.hasOwn(names,state.provider) && typeof state.enabled==='boolean' &&
    Number.isSafeInteger(state.revision) && state.revision>=0 && Number.isSafeInteger(state.epoch) && state.epoch>0 &&
    Number.isSafeInteger(state.sequence) && state.sequence>=0 &&
    (state.head===null || state.head?.sequence===state.sequence && typeof state.head.hash==='string' && /^[a-f0-9]{64}$/.test(state.head.hash));
  if(!valid)return {visible:true,disabled:true,mode:null,actual:'Подключение резерва не подтверждено',
    detail:'Переключение станет доступно после проверки синхронизации обеих баз.',targets:{synology:false,firebase:false}};
  const caughtUp=provider=>state.enabled===true && state.adapters?.[provider]===true &&
    state.head && state.replicas?.[provider]?.sequence===state.sequence &&
    state.replicas[provider].hash===state.head.hash;
  const targets={synology:!!caughtUp('synology'),firebase:!!caughtUp('firebase')};
  return {visible:true,disabled:busy||!online||!state.enabled,mode:state.mode,actual:names[state.provider]+' — сервер данных',targets,
    detail:!state.enabled?'Резерв ещё не готов к переключению.':!targets.firebase?'Резерв Firebase синхронизируется.':
      !targets.synology?'Firebase работает. Synology должен получить последние изменения перед возвратом.':
      state.mode==='auto'?'Автоматический режим. Обе копии данных проверены.':
      'Для всех операторов принудительно выбран '+names[state.provider]+'.'};
}
export function createNasFailureDetector({threshold=3,minimumGapMs=1000,now=Date.now}={}) {
  if(!Number.isSafeInteger(threshold)||threshold<2||!Number.isSafeInteger(minimumGapMs)||minimumGapMs<1||typeof now!=='function')
    throw TypeError('invalid-failure-detector');
  let count=0,last=null;
  return Object.freeze({
    reset(){count=0;last=null;},
    observe(error,{online=true,provider='synology'}={}){
      const code=String(error?.code||'');
      // Access errors, dataset changes and an offline phone are not NAS outages.
      const unreachable=['api-timeout','api-unreachable'].includes(code)||/^api-http-5\d\d$/.test(code);
      if(!online||provider!=='synology'||!unreachable){count=0;last=null;return {eligible:false,consecutiveFailures:0};}
      const time=now();
      if(!Number.isSafeInteger(time)||time<0)throw TypeError('invalid-probe-time');
      if(last!==null&&time<last){count=0;last=null;}
      if(last===null||time-last>=minimumGapMs){count++;last=time;}
      return {eligible:count>=threshold,consecutiveFailures:count};
    }
  });
}
export function createFailoverAdminController({getSession,read,setMode,confirm,notify=()=>{}}={}) {
  if(![getSession,read,setMode,confirm,notify].every(fn=>typeof fn==='function'))throw TypeError('invalid-admin-controller');
  let busy=false;
  const guard=owner=>{
    const current=getSession();
    if(!current||!owner||current.uid!==owner.uid||current.generation!==owner.generation||current.status!=='active'||current.role!=='admin')
      throw Error('Сеанс администратора изменился');
  };
  return Object.freeze({
    get busy(){return busy;},
    async change(mode){
      if(!modes.has(mode))throw Error('Неизвестный режим сервера');
      if(busy)throw Error('Переключение уже выполняется');
      const owner=getSession();guard(owner);busy=true;
      try{
        const before=await read();guard(owner);
        const view=failoverAdminView(before,{activeAdmin:true});
        if(view.disabled)throw Error('Резерв ещё не готов к переключению');
        if(mode!=='auto'&&!view.targets[mode])throw Error('Выбранный сервер ещё не получил последние изменения');
        const name=mode==='auto'?'автоматическое переключение':names[mode];
        if(!await confirm('Включить '+name+' для всех операторов TEST? Незавершённые действия сохранятся в очереди.'))return null;
        guard(owner);
        const result=await setMode({mode,expectedRevision:before.revision});guard(owner);
        notify('Режим сервера сохранён для всех операторов');return result;
      }finally{busy=false;}
    }
  });
}
