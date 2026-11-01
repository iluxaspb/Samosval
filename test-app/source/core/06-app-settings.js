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

    const resBox = document.getElementById('adminAiTestResult');
    if (resBox && !resBox.textContent) {
      const lastRaw = localStorage.getItem('dt_ai_api_last_status') || localStorage.getItem('samosval_ai_api_last_status');
      const bridgeRaw = localStorage.getItem('samosval_opencode_bridge_last_status');
      let bridgeInfo = '';
      if (bridgeRaw) {
        try {
          const b = JSON.parse(bridgeRaw);
          bridgeInfo = ` | Мост OpenCode: ${b.connected ? '🟢 на связи (' + (b.latency || 0) + ' мс)' : '🔴 офлайн'}`;
        } catch(e) {}
      }
      if (lastRaw) {
        try {
          const last = JSON.parse(lastRaw);
          const rating = last.latencyRating || (last.elapsed < 400 ? '🟢 Отлично' : (last.elapsed < 1200 ? '🟡 Норма' : '🟠 Задержка'));
          resBox.style.color = last.ok ? '#34d399' : '#f87171';
          resBox.textContent = `Предыдущая проверка (${last.timeStr || ''}): ${last.message || last.status} · ${last.elapsed || 0} мс${bridgeInfo}`;
        } catch (e) {}
      } else if (bridgeInfo) {
        resBox.style.color = 'var(--muted)';
        resBox.textContent = 'Внешний API не проверен/офлайн. ' + bridgeInfo.slice(3);
      } else {
        resBox.textContent = 'Внешний API не проверен/офлайн';
      }
    }
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

  // Общая диагностика только по явному нажатию. Ответы провайдера не пишем в историю.
  window.aiApiDiagnosticError = function(error) {
    if (error?.name === 'AbortError') return { status: 'timeout', message: 'Таймаут API (15 секунд)' };
    if (navigator.onLine === false) return { status: 'offline', message: 'Внешний API не проверен/офлайн' };
    if (error instanceof TypeError) return { status: 'network_or_cors', message: 'Сеть или CORS: браузер не раскрывает причину. Проверьте endpoint и DevTools Network.' };
    return { status: 'network_error', message: 'Ошибка запроса API. Проверьте endpoint и параметры подключения.' };
  };
  window.aiApiUnchecked = function(element, status = 'not_checked') {
    const record = { ok: false, status, timestamp: Date.now(), message: 'Внешний API не проверен/офлайн' };
    try {
      localStorage.setItem('dt_ai_api_last_status', JSON.stringify(record));
      localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(record));
    } catch(e) {}
    if (element) element.textContent = record.message;
  };
  window.aiApiReadJsonWithDeadline = async function(resp, remainingMs, controller) {
    if (remainingMs <= 0 || controller?.signal?.aborted) {
      controller?.abort();
      const err = new Error('Таймаут API (15 секунд)');
      err.name = 'AbortError';
      throw err;
    }
    let timerId = null;
    const jsonPromise = resp.json();
    jsonPromise.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller?.abort();
        const err = new Error('Таймаут API (15 секунд)');
        err.name = 'AbortError';
        reject(err);
      }, remainingMs);
    });
    try {
      return await Promise.race([jsonPromise, timeoutPromise]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  };
  async function testAdminAiConnection() {
    const key = (document.getElementById('adminAiApiKey')?.value || '').trim();
    const ep = (document.getElementById('adminAiEndpoint')?.value || '').trim() || 'https://api.apimira.com/v1/chat/completions';
    const light = (document.getElementById('adminAiModelLight')?.value || '').trim() || 'deepseek/deepseek-chat';
    const resBox = document.getElementById('adminAiTestResult');
    const testBtn = document.getElementById('testAiConnectionBtn');

    if (navigator.onLine === false || !key) {
      window.aiApiUnchecked(resBox, navigator.onLine === false ? 'offline' : 'not_checked');
      if (resBox) {
        resBox.style.color = '#f59e0b';
        resBox.textContent = 'Внешний API не проверен/офлайн. Для явной проверки нужны сеть и API-ключ.';
      }
      return;
    }

    if (testBtn) testBtn.disabled = true;
    if (resBox) {
      resBox.style.color = 'var(--text)';
      resBox.textContent = '⏳ Проверка соединения с API (' + light + ')...';
    }

    const startTs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(ep, {
        signal: controller.signal,
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
      const latencyRating = elapsed < 400 ? '🟢 Отлично' : (elapsed < 1200 ? '🟡 Норма' : '🟠 Задержка выше нормы');

      const bridgeRaw = localStorage.getItem('samosval_opencode_bridge_last_status');
      let bridgeInfo = '';
      if (bridgeRaw) {
        try {
          const b = JSON.parse(bridgeRaw);
          bridgeInfo = ` | Мост: ${b.connected ? '🟢 OK (' + (b.latency || 0) + ' мс)' : '🔴 Офлайн'}`;
        } catch (e) {}
      }

      if (resp.ok) {
        const remaining = 15000 - (Date.now() - startTs);
        const data = await window.aiApiReadJsonWithDeadline(resp, remaining, controller);
        const fullElapsed = Date.now() - startTs;
        const finalRating = fullElapsed < 400 ? '🟢 Отлично' : (fullElapsed < 1200 ? '🟡 Норма' : '🟠 Задержка выше нормы');
        const reply = data?.choices?.[0]?.message?.content ? 'Ответ модели получен' : 'HTTP OK';
        if (resBox) {
          resBox.style.color = '#34d399';
          resBox.textContent = `🟢 Связь успешна! (${fullElapsed} мс [${finalRating}])${bridgeInfo} Модель "${light}" ответила: "${reply.trim()}"`;
        }
        const statusRecord = {
          ok: true,
          status: 200,
          elapsed: fullElapsed,
          latencyRating: finalRating,
          timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: Date.now(),
          model: light,
          message: reply.trim()
        };
        localStorage.setItem('dt_ai_api_last_status', JSON.stringify(statusRecord));
        localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
      } else {
        const errText = 'Проверьте endpoint, модель и права ключа (подробности в Network).';
        if (resBox) {
          resBox.style.color = '#f87171';
          resBox.textContent = `🔴 Ошибка HTTP ${resp.status} (${elapsed} мс [${latencyRating}])${bridgeInfo}: ${errText.slice(0, 100)}`;
        }
        const statusRecord = {
          ok: false,
          status: resp.status,
          elapsed,
          latencyRating,
          timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: Date.now(),
          model: light,
          message: `HTTP ${resp.status}: ${errText.slice(0, 80)}`
        };
        localStorage.setItem('dt_ai_api_last_status', JSON.stringify(statusRecord));
        localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
      }
    } catch (e) {
      const elapsed = Date.now() - startTs;
      const diagnostic = window.aiApiDiagnosticError(e);
      if (resBox) {
        resBox.style.color = '#f87171';
        resBox.textContent = `🔴 ${diagnostic.message} (${elapsed} мс)`;
      }
      const statusRecord = {
        ok: false,
        status: diagnostic.status,
        elapsed,
        latencyRating: '🔴 Нет связи',
        timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        timestamp: Date.now(),
        model: light,
        message: diagnostic.message
      };
      localStorage.setItem('dt_ai_api_last_status', JSON.stringify(statusRecord));
      localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
    } finally {
      clearTimeout(timer);
      if (testBtn) testBtn.disabled = false;
    }
  }

  window.selectAiProviderPreset = selectAiProviderPreset;
  window.toggleAiApiKeyVisibility = toggleAiApiKeyVisibility;
  window.onAiSettingsChanged = onAiSettingsChanged;
  window.renderAdminAiSettings = renderAdminAiSettings;
  window.saveAdminAiSettings = saveAdminAiSettings;
  window.testAdminAiConnection = testAdminAiConnection;
