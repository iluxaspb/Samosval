  const requestSyncStatus = {requests:false,users:false,errors:{}};
  function pendingRegistrationRequests() {
    const result=[];
    (state.requests||[]).forEach(r=>{
      if(r.status && r.status!=='pending') return;
      const user=(state.users||[]).find(u=>u.id===r.uid || (u.email&&u.email===r.email));
      if(user && user.status!=='pending') return;
      result.push({...r,uid:r.uid||user?.id||null});
    });
    (state.users||[]).filter(u=>u.status==='pending').forEach(u=>{
      if(!result.some(r=>r.uid===u.id || (r.email&&r.email===u.email))) result.push({id:u.id,uid:u.id,email:u.email,nickname:u.nickname,createdAt:u.createdAt||0});
    });
    return result.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  }
  function renderRegistrationRequests() {
    if(!canAdmin())return;
    const container=document.getElementById('requestsListContainer');if(!container)return;
    const list=pendingRegistrationRequests();
    const count=document.getElementById('pendingCount');if(count)count.textContent=list.length;
    const messages=Object.entries(requestSyncStatus.errors).map(([source,error])=>source+': '+error);
    container.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><strong>Заявки на регистрацию · '+list.length+'</strong><button class="btn btn-secondary btn-small" id="refreshRegistrationRequestsBtn">Обновить заявки</button></div>'
      +(messages.length?'<div style="padding:10px;margin-bottom:12px;color:var(--warning);font-size:12px">Не удалось полностью загрузить заявки: '+escapeHtml(messages.join('; '))+'</div>':'')
      +(list.length?list.map(r=>`<div class="user-row"><div class="user-row-top"><div><strong>${escapeHtml(r.email)}</strong><div style="font-size:12px;color:var(--muted)">${escapeHtml(r.nickname||'')}</div></div><div class="pending-badge">Ожидает</div></div><div class="user-row-bottom"><select id="req_role_${escapeHtml(r.id)}" class="form-control" style="padding:6px;font-size:12px">${Object.keys(ROLES).map(role=>`<option value="${role}" ${role==='viewer'?'selected':''}>${escapeHtml(ROLES[role].label)}</option>`).join('')}</select><button class="btn btn-quick btn-small" data-approve-request="${escapeHtml(r.id)}">Подтвердить</button><button class="btn btn-secondary btn-small" data-reject-request="${escapeHtml(r.id)}">Отклонить</button></div></div>`).join(''):'<div class="empty-state">'+(requestSyncStatus.requests&&requestSyncStatus.users&&!messages.length?'Нет заявок':messages.length?'Проверьте доступ к базе и нажмите «Обновить заявки»':'Загружаем заявки и ожидающие учётки…')+'</div>');
    container.querySelector('#refreshRegistrationRequestsBtn').onclick=()=>refreshRegistrationRequests();
    container.querySelectorAll('[data-approve-request]').forEach(b=>b.onclick=()=>approveRequest(b.dataset.approveRequest));
    container.querySelectorAll('[data-reject-request]').forEach(b=>b.onclick=()=>rejectRequest(b.dataset.rejectRequest));
    updateAdminBadge();
  }
  function acceptRegistrationSnapshot(source,snapshot) {
    if(!canAdmin())return;
    const records=snapshot.docs.map(d=>({...d.data(),id:d.id}));
    if(source==='users')state.users=records;else state.requests=records;
    markSync(source,!!snapshot.metadata?.fromCache,!!snapshot.metadata?.hasPendingWrites,records.length);
    if(!snapshot.metadata?.fromCache)requestSyncStatus[source]=true;
    delete requestSyncStatus.errors[source];
    renderRegistrationRequests();
    if(document.getElementById('tab-admin')?.classList.contains('active'))renderAdminPanel();
  }
  function registrationSyncError(source,error) {
    requestSyncStatus.errors[source]=(error.code||'unknown')+' · '+(error.message||String(error));
    reportSyncError(source,error);renderRegistrationRequests();
  }
  let refreshingRegistrationRequests=false;
  async function refreshRegistrationRequests() {
    if(!canAdmin()||refreshingRegistrationRequests)return;
    refreshingRegistrationRequests=true;
    const requestedUid=currentUid,epoch=registrationSyncEpoch;
    try {
      const sources=['requests','users'];
      const results=await Promise.allSettled([requestsRef.get({source:'server'}),usersRef.get({source:'server'})]);
      if(currentUid!==requestedUid||registrationSyncEpoch!==epoch||!canAdmin())return;
      results.forEach((result,index)=>{if(result.status==='fulfilled')acceptRegistrationSnapshot(sources[index],result.value);else registrationSyncError(sources[index],result.reason);});
    }finally{refreshingRegistrationRequests=false;}
  }
  let registrationSyncEpoch=0;
  function startAdminSync() {
    if(!canAdmin())return;
    const epoch=++registrationSyncEpoch,uid=currentUid;
    const current=()=>epoch===registrationSyncEpoch&&uid===currentUid&&canAdmin();
    if(reqsUnsubscriber)reqsUnsubscriber();
    if(usersUnsubscriber)usersUnsubscriber();
    requestSyncStatus.requests=false;requestSyncStatus.users=false;requestSyncStatus.errors={};
    // Sort on the client so legacy records without createdAt are also included.
    reqsUnsubscriber=requestsRef.onSnapshot({includeMetadataChanges:true},snapshot=>{if(current())acceptRegistrationSnapshot('requests',snapshot);},error=>{if(current())registrationSyncError('requests',error);});
    usersUnsubscriber=usersRef.onSnapshot({includeMetadataChanges:true},snapshot=>{if(current())acceptRegistrationSnapshot('users',snapshot);},error=>{if(current())registrationSyncError('users',error);});
    renderRegistrationRequests();
  }
  function updateAdminBadge() {
    const badge=document.getElementById('navAdminBadge');if(!badge)return;
    const count=pendingRegistrationRequests().length;
    badge.style.display=count?'block':'none';badge.textContent=count;
  }

