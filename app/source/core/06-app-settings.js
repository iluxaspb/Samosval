  function renderAppSettingsIfActive() {
    if (!document.getElementById('tab-admin')?.classList.contains('active')) return;
    if (!document.getElementById('admin-sub-appsettings')?.classList.contains('active')) return;
    const cycle=document.getElementById('adminCycleMinutes');if(cycle&&!cycle.disabled&&document.activeElement!==cycle)cycle.value=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES);
    ['MaxEnabled','NotifyStart','NotifyArrive','NotifyLoad','NotifyTtn','NotifyLineStart','NotifyLineEnd'].forEach(k => { let el = document.getElementById('appConfig' + k); if (el) { let configKey = k.charAt(0).toLowerCase() + k.slice(1); el.checked = !!appConfig[configKey]; } });
    if (document.getElementById('appConfigMaxUrl')) document.getElementById('appConfigMaxUrl').value = appConfig.maxUrl;
    if (document.getElementById('appConfigMaxToken')) document.getElementById('appConfigMaxToken').value = appConfig.maxToken;
    if (document.getElementById('appConfigMaxChatId')) document.getElementById('appConfigMaxChatId').value = appConfig.maxChatId;
  }
  async function saveAdminCycleMinutes(input) {
    if(!canAdmin())return;
    input.disabled=true;
    try{await updateCycleMinutes(input.value);}finally{input.disabled=false;input.value=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES);}
  }
  async function saveAppConfig() {
    if (!canAdmin()) return;
    let data = {
      maxEnabled: !!document.getElementById('appConfigMaxEnabled')?.checked,
      maxUrl: (document.getElementById('appConfigMaxUrl')?.value || '').trim(),
      maxToken: (document.getElementById('appConfigMaxToken')?.value || '').trim(),
      maxChatId: (document.getElementById('appConfigMaxChatId')?.value || '').trim(),
      notifyStart: !!document.getElementById('appConfigNotifyStart')?.checked,
      notifyArrive: !!document.getElementById('appConfigNotifyArrive')?.checked,
      notifyLoad: !!document.getElementById('appConfigNotifyLoad')?.checked,
      notifyTtn: !!document.getElementById('appConfigNotifyTtn')?.checked,
      notifyLineStart: !!document.getElementById('appConfigNotifyLineStart')?.checked,
      notifyLineEnd: !!document.getElementById('appConfigNotifyLineEnd')?.checked
    };
    try { await tfAwait(appConfigRef.set(data, { merge: true })); appConfig = Object.assign({}, appConfig, data); showToastEl('Настройки сохранены', false); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } catch(e) { showError(e.message); }
  }

  // === MAX QUEUE ===
  const MAX_QUEUE_KEY = 'dt_max_queue'; const MAX_QUEUE_MAX = 100; const MAX_TRIES = 5;
  let maxQueue = []; let maxSenderRunning = false; let maxSeq = 0; let maxLastError = '';
