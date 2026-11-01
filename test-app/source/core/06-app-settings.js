  function renderAppSettingsIfActive() {
    renderTestBackendControls();
    if (!document.getElementById('tab-admin')?.classList.contains('active')) return;
    if (!document.getElementById('admin-sub-appsettings')?.classList.contains('active')) return;
    renderAdminAiSettings();
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
    try { if(isNasRuntime()){await nasSaveSettings(data);showToastEl('Настройки сохранены на Synology',false);return;} await tfAwait(appConfigRef.set(data, { merge: true })); appConfig = Object.assign({}, appConfig, data); showToastEl('Настройки сохранены', false); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } catch(e) { showError(e.message); }
  }

  // === MAX QUEUE ===
  const MAX_QUEUE_KEY = 'dt_max_queue_test347'; const MAX_QUEUE_MAX = 100; const MAX_TRIES = 5;
  let maxQueue = []; let maxSenderRunning = false; let maxSeq = 0; let maxLastError = '';

  // === AI API SETTINGS & PROVIDER SELECTION ===
  const AI_PRESETS = {
    apimira: {
      endpoint: 'https://api.apimira.com/v1/chat/completions',
      modelLight: 'deepseek/deepseek-chat',
      modelHeavy: 'deepseek/deepseek-reasoner'
    },
    deepseek: {
      endpoint: 'https://api.deepseek.com/chat/completions',
      modelLight: 'deepseek-chat',
      modelHeavy: 'deepseek-reasoner'
    },
    openai: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      modelLight: 'gpt-4o-mini',
      modelHeavy: 'gpt-4o'
    },
    custom: {
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      modelLight: 'qwen2.5:7b',
      modelHeavy: 'deepseek-r1:14b'
    }
  };

  function selectAiProviderPreset(presetKey) {
    const preset = AI_PRESETS[presetKey];
    if (!preset) return;
    const epInput = document.getElementById('adminAiEndpoint');
    const lightInput = document.getElementById('adminAiModelLight');
    const heavyInput = document.getElementById('adminAiModelHeavy');

    if (epInput) epInput.value = preset.endpoint;
    if (lightInput) lightInput.value = preset.modelLight;
    if (heavyInput) heavyInput.value = preset.modelHeavy;

    localStorage.setItem('dt_ai_provider_preset', presetKey);
    updateAiPresetButtons(presetKey);
    onAiSettingsChanged();
  }

  function updateAiPresetButtons(activeKey) {
    ['apimira', 'deepseek', 'openai', 'custom'].forEach(k => {
      const btn = document.getElementById('presetBtn' + k.charAt(0).toUpperCase() + k.slice(1));
      if (btn) {
        if (k === activeKey) {
          btn.style.background = 'var(--primary, #38bdf8)';
          btn.style.color = '#000';
          btn.style.fontWeight = '700';
        } else {
          btn.style.background = '';
          btn.style.color = '';
          btn.style.fontWeight = '';
        }
      }
    });
  }

  function toggleAiApiKeyVisibility() {
    const keyInput = document.getElementById('adminAiApiKey');
    if (!keyInput) return;
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  }

  function onAiSettingsChanged() {
    const resBox = document.getElementById('adminAiTestResult');
    if (resBox) resBox.textContent = '';
  }

  function renderAdminAiSettings() {
    const keyInput = document.getElementById('adminAiApiKey');
    const epInput = document.getElementById('adminAiEndpoint');
    const lightInput = document.getElementById('adminAiModelLight');
    const heavyInput = document.getElementById('adminAiModelHeavy');

    if (!keyInput) return;

    const savedKey = localStorage.getItem('dt_ai_api_key') || localStorage.getItem('dt_deepseek_api_key') || '';
    const savedEp = localStorage.getItem('dt_ai_api_endpoint') || 'https://api.apimira.com/v1/chat/completions';
    const savedLight = localStorage.getItem('dt_ai_model_light') || localStorage.getItem('dt_ai_api_model') || 'deepseek/deepseek-chat';
    const savedHeavy = localStorage.getItem('dt_ai_model_heavy') || 'deepseek/deepseek-reasoner';
    const savedPreset = localStorage.getItem('dt_ai_provider_preset') || 'apimira';

    if (document.activeElement !== keyInput) keyInput.value = savedKey;
    if (document.activeElement !== epInput) epInput.value = savedEp;
    if (document.activeElement !== lightInput) lightInput.value = savedLight;
    if (document.activeElement !== heavyInput) heavyInput.value = savedHeavy;

    updateAiPresetButtons(savedPreset);
  }

  function saveAdminAiSettings() {
    const key = (document.getElementById('adminAiApiKey')?.value || '').trim();
    const ep = (document.getElementById('adminAiEndpoint')?.value || '').trim() || 'https://api.apimira.com/v1/chat/completions';
    const light = (document.getElementById('adminAiModelLight')?.value || '').trim() || 'deepseek/deepseek-chat';
    const heavy = (document.getElementById('adminAiModelHeavy')?.value || '').trim() || 'deepseek/deepseek-reasoner';

    localStorage.setItem('dt_ai_api_key', key);
    localStorage.setItem('dt_deepseek_api_key', key);
    localStorage.setItem('dt_ai_api_endpoint', ep);
    localStorage.setItem('dt_ai_model_light', light);
    localStorage.setItem('dt_ai_api_model', light);
    localStorage.setItem('dt_ai_model_heavy', heavy);

    if (typeof showToastEl === 'function') showToastEl('✅ Настройки ИИ-провайдера сохранены', false);
    const resBox = document.getElementById('adminAiTestResult');
    if (resBox) {
      resBox.style.color = '#34d399';
      resBox.textContent = '✅ Настройки сохранены. Лёгкая модель: ' + light + ' | Тяжёлая модель: ' + heavy;
    }
  }

  async function testAdminAiConnection() {
    const key = (document.getElementById('adminAiApiKey')?.value || '').trim();
    const ep = (document.getElementById('adminAiEndpoint')?.value || '').trim() || 'https://api.apimira.com/v1/chat/completions';
    const light = (document.getElementById('adminAiModelLight')?.value || '').trim() || 'deepseek/deepseek-chat';
    const resBox = document.getElementById('adminAiTestResult');
    const testBtn = document.getElementById('testAiConnectionBtn');

    if (!key) {
      if (resBox) {
        resBox.style.color = '#f59e0b';
        resBox.textContent = '⚠️ Ключ API не введён. ИИ работает на встроенной математической модели (Offline-First).';
      }
      return;
    }

    if (testBtn) testBtn.disabled = true;
    if (resBox) {
      resBox.style.color = 'var(--text)';
      resBox.textContent = '⏳ Проверка соединения с API (' + light + ')...';
    }

    const startTs = Date.now();
    try {
      const resp = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: light,
          messages: [{ role: 'user', content: 'Ответь одним словом "OK"' }],
          max_tokens: 5,
          temperature: 0.1
        })
      });

      const elapsed = Date.now() - startTs;
      if (resp.ok) {
        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content || 'OK';
        if (resBox) {
          resBox.style.color = '#34d399';
          resBox.textContent = `🟢 Связь успешна! (${elapsed} мс) Модель "${light}" ответила: "${reply.trim()}"`;
        }
      } else {
        const errText = await resp.text().catch(() => '');
        if (resBox) {
          resBox.style.color = '#f87171';
          resBox.textContent = `🔴 Ошибка HTTP ${resp.status}: ${errText.slice(0, 100)}`;
        }
      }
    } catch (e) {
      if (resBox) {
        resBox.style.color = '#f87171';
        resBox.textContent = '🔴 Ошибка соединения: ' + (e.message || 'сеть недоступна или CORS');
      }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
  }

  window.selectAiProviderPreset = selectAiProviderPreset;
  window.toggleAiApiKeyVisibility = toggleAiApiKeyVisibility;
  window.onAiSettingsChanged = onAiSettingsChanged;
  window.renderAdminAiSettings = renderAdminAiSettings;
  window.saveAdminAiSettings = saveAdminAiSettings;
  window.testAdminAiConnection = testAdminAiConnection;
