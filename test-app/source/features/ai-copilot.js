/**
 * AI Copilot, Shift Simulator & Feedback/Prompt Generator (Test Mode)
 * - Local Statistical Model (Offline-First auto-suggest)
 * - Virtual Shift Simulator for testing fleet & ML adaptation
 * - Voice Input Engine (Web Speech API + DeepSeek API integration hook)
 * - Safe Human-In-The-Loop confirmation
 * - Bug & UI Feedback Collector -> Developer Prompt Generator for OpenCode / LLMs
 */
(function aiCopilotModule() {
  'use strict';

  const STORAGE_KEY_STATS = 'samosval_ai_learner_v1';
  const STORAGE_KEY_CONFIG = 'samosval_ai_config_v1';
  const STORAGE_KEY_DEEPSEEK = 'dt_deepseek_api_key';
  const STORAGE_KEY_API_KEY = 'dt_ai_api_key';
  const STORAGE_KEY_API_ENDPOINT = 'dt_ai_api_endpoint';
  const STORAGE_KEY_API_MODEL = 'dt_ai_api_model';
  const STORAGE_KEY_API_MODEL_LIGHT = 'dt_ai_model_light';
  const STORAGE_KEY_API_MODEL_HEAVY = 'dt_ai_model_heavy';
  const STORAGE_KEY_API_PRESET = 'dt_ai_provider_preset';
  const STORAGE_KEY_FEEDBACK = 'samosval_ai_feedback_v1';
  const STORAGE_KEY_UX = 'samosval_ai_ux_v1';
  const STORAGE_KEY_ROUTE = 'samosval_ai_route_v1';
  const STORAGE_KEY_PHOTO = 'samosval_ai_photo_v1';
  const STORAGE_KEY_CAD = 'samosval_ai_cad_v1';
  const STORAGE_KEY_API_STATUS = 'dt_ai_api_last_status';
  const STORAGE_KEY_BRIDGE_STATUS = 'samosval_opencode_bridge_last_status';

  // ==========================================================
  // 1. ЛОКАЛЬНАЯ МАТЕМАТИЧЕСКАЯ МОДЕЛЬ (On-Device Statistical ML)
  // ==========================================================
  const AiLocalLearner = {
    data: {
      truckProfiles: {}, // truckId -> { volumes: {}, materials: {}, totalLoads: 0, tripDurationsMs: [], avgTripMs: 0 }
      objectCycles: {},   // objectId -> { avgTripMs: 0, count: 0 }
      shiftEndPatterns: {
        typicalEndHour: 16.5,     // 16:30 по умолчанию
        typicalTtnStartHour: 16.0, // 16:00 по умолчанию
        history: []
      },
      lastTrainedAt: 0,
      totalPredictions: 0,
      correctPredictions: 0
    },

    init() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_STATS);
        if (saved) {
          this.data = JSON.parse(saved);
          if (!this.data.shiftEndPatterns) {
            this.data.shiftEndPatterns = { typicalEndHour: 16.5, typicalTtnStartHour: 16.0, history: [] };
          }
        }
      } catch (e) {
        console.warn('[AI Learner] Ошибка чтения статистики:', e);
      }
      this.bootstrapFromStateLogs();
    },

    save() {
      try {
        this.data.lastTrainedAt = Date.now();
        localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(this.data));
      } catch (e) {}
    },

    getTrafficFactor(date = new Date()) {
      const day = date.getDay(); // 0: вс, 1: пн, ..., 5: пт, 6: сб
      const hours = date.getHours() + date.getMinutes() / 60;

      // Пятница (5): загородные дачные пробки и вечерний час пик
      if (day === 5) {
        if (hours >= 14.5 && hours <= 20.0) {
          return { factor: 1.4, reason: 'Пятничные заторы (+40% времени)', dayName: 'Пятница' };
        }
        if (hours >= 12.0 && hours < 14.5) {
          return { factor: 1.2, reason: 'Пятничный дневной трафик (+20%)', dayName: 'Пятница' };
        }
      }

      // Воскресенье (0): вечерний въездной поток в город
      if (day === 0) {
        if (hours >= 16.0 && hours <= 21.0) {
          return { factor: 1.35, reason: 'Воскресный въездной поток (+35%)', dayName: 'Воскресенье' };
        }
      }

      // Будни (1-4): утренний и вечерний час пик
      if (day >= 1 && day <= 4) {
        if ((hours >= 7.5 && hours <= 9.5) || (hours >= 16.5 && hours <= 19.0)) {
          return { factor: 1.25, reason: 'Час пик буднего дня (+25%)', dayName: ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][day] };
        }
      }

      return { factor: 1.0, reason: 'Штатный дорожный трафик', dayName: ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][day] };
    },

    recordShiftActivity(type, timestamp = Date.now()) {
      if (!this.data.shiftEndPatterns) {
        this.data.shiftEndPatterns = { typicalEndHour: 16.5, typicalTtnStartHour: 16.0, history: [] };
      }
      const date = new Date(timestamp);
      const hour = date.getHours() + date.getMinutes() / 60;
      
      if (type === 'ttn' && hour >= 14.5 && hour <= 20.0) {
        this.data.shiftEndPatterns.history.push({ type, hour, ts: timestamp });
        if (this.data.shiftEndPatterns.history.length > 30) this.data.shiftEndPatterns.history.shift();

        const ttnHours = this.data.shiftEndPatterns.history.filter(h => h.type === 'ttn').map(h => h.hour);
        if (ttnHours.length >= 3) {
          const avgH = ttnHours.reduce((a, b) => a + b, 0) / ttnHours.length;
          this.data.shiftEndPatterns.typicalTtnStartHour = Math.round(avgH * 10) / 10;
        }
      } else if (type === 'close_shift') {
        this.data.shiftEndPatterns.typicalEndHour = Math.round(hour * 10) / 10;
      }
      this.save();
    },

    checkLastRoundFeasibility(truckId, currentTime = new Date()) {
      const truck = (window.state?.trucks || []).find(t => t.id === truckId);
      const prediction = this.predict(truckId);
      const traffic = this.getTrafficFactor(currentTime);
      const baseMins = prediction.predictedMins || 35;
      const trafficMins = Math.round(baseMins * traffic.factor);

      const currentHour = currentTime.getHours() + currentTime.getMinutes() / 60;
      const patterns = this.data.shiftEndPatterns || { typicalEndHour: 16.5, typicalTtnStartHour: 16.0 };
      const typicalEndH = patterns.typicalEndHour || 16.5;

      const expectedEndMs = new Date(currentTime).setHours(Math.floor(typicalEndH), Math.round((typicalEndH % 1) * 60), 0, 0);
      const returnMs = currentTime.getTime() + (trafficMins * 60000);
      const returnTimeStr = new Date(returnMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const shiftEndTimeStr = new Date(expectedEndMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      // Если текущее время близко к началу сбора ТТН (после 15:15) и возврат будет позже завершения смены
      const isNearShiftEnd = currentHour >= (patterns.typicalTtnStartHour - 0.75) || currentHour >= 15.25;
      const willReturnLate = returnMs > (expectedEndMs + 5 * 60000);

      if (isNearShiftEnd && willReturnLate) {
        const diffMins = Math.round((returnMs - expectedEndMs) / 60000);
        return {
          feasible: false,
          warning: true,
          truckName: truck ? `${truck.brand} ${truck.number}` : truckId,
          trafficMins,
          baseMins,
          returnTimeStr,
          shiftEndTimeStr,
          diffMins,
          traffic,
          message: `Время ${currentTime.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}. ${traffic.dayName} (${traffic.reason}). Плечо ~${trafficMins} мин. Самосвал вернётся только к ${returnTimeStr} (позже смены ${shiftEndTimeStr}). Рекомендуется забрать ТТН и отпустить в парк, не отправляя на завод.`
        };
      }

      return {
        feasible: true,
        warning: false,
        trafficMins,
        baseMins,
        returnTimeStr,
        traffic
      };
    },

    bootstrapFromStateLogs() {
      if (!window.state || !Array.isArray(state.logs) || !state.logs.length) return;
      const logs = state.logs.slice().sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      
      const lastLoadByTruck = {};
      logs.forEach(log => {
        if (!log.truckId) return;
        const vol = Number(log.volume || 0);
        const mat = log.material || 'Асфальт';
        const truckId = log.truckId;
        const ts = Number(log.timestamp || 0);

        if (!this.data.truckProfiles[truckId]) {
          this.data.truckProfiles[truckId] = {
            volumes: {},
            materials: {},
            totalLoads: 0,
            tripDurationsMs: [],
            avgTripMs: 0
          };
        }
        const prof = this.data.truckProfiles[truckId];
        if (vol > 0) {
          prof.volumes[vol] = (prof.volumes[vol] || 0) + 1;
        }
        if (mat) {
          prof.materials[mat] = (prof.materials[mat] || 0) + 1;
        }
        prof.totalLoads++;

        if (lastLoadByTruck[truckId] && log.arrivalTimestamp) {
          const tripMs = Number(log.arrivalTimestamp) - lastLoadByTruck[truckId];
          if (tripMs >= 5 * 60000 && tripMs <= 240 * 60000) {
            prof.tripDurationsMs.push(tripMs);
            if (prof.tripDurationsMs.length > 25) prof.tripDurationsMs.shift();
            prof.avgTripMs = Math.round(prof.tripDurationsMs.reduce((a, b) => a + b, 0) / prof.tripDurationsMs.length);
          }
        }
        lastLoadByTruck[truckId] = ts;
      });
      this.save();
    },

    recordLoad(truckId, volume, material, durationMs) {
      if (!truckId) return;
      if (!this.data.truckProfiles[truckId]) {
        this.data.truckProfiles[truckId] = {
          volumes: {},
          materials: {},
          totalLoads: 0,
          tripDurationsMs: [],
          avgTripMs: 0
        };
      }
      const p = this.data.truckProfiles[truckId];
      const volKey = String(volume);
      p.volumes[volKey] = (p.volumes[volKey] || 0) + 1;
      if (material) p.materials[material] = (p.materials[material] || 0) + 1;
      p.totalLoads++;

      if (durationMs && durationMs >= 5 * 60000 && durationMs <= 240 * 60000) {
        p.tripDurationsMs.push(durationMs);
        if (p.tripDurationsMs.length > 25) p.tripDurationsMs.shift();
        p.avgTripMs = Math.round(p.tripDurationsMs.reduce((a, b) => a + b, 0) / p.tripDurationsMs.length);
      }
      this.save();
    },

    predict(truckId) {
      const truck = (window.state?.trucks || []).find(t => t.id === truckId);
      const prof = this.data.truckProfiles[truckId];
      
      let predictedVol = truck ? (truck.defaultVol || 20) : 20;
      let predictedMaterial = 'Асфальт';
      let confidence = 75;
      let predictedMins = Math.round((prof?.avgTripMs || 35 * 60000) / 60000);
      let anomaly = null;

      if (prof && prof.totalLoads > 0) {
        let maxVCount = 0;
        for (const [vol, count] of Object.entries(prof.volumes)) {
          if (count > maxVCount) {
            maxVCount = count;
            predictedVol = Number(vol);
          }
        }
        confidence = Math.min(98, Math.round((maxVCount / prof.totalLoads) * 100));

        let maxMCount = 0;
        for (const [mat, count] of Object.entries(prof.materials)) {
          if (count > maxMCount) {
            maxMCount = count;
            predictedMaterial = mat;
          }
        }
        if (prof.avgTripMs > 0) {
          predictedMins = Math.round(prof.avgTripMs / 60000);
        }
      }

      const status = window.state?.truckStatus?.[truckId];
      if (status && status.lastLoadTimestamp && prof?.avgTripMs) {
        const now = Date.now();
        const elapsed = now - Number(status.lastLoadTimestamp);
        if (status.arriveStatus && elapsed < prof.avgTripMs * 0.45 && elapsed > 60000) {
          const diffMins = Math.round((prof.avgTripMs - elapsed) / 60000);
          anomaly = { type: 'fast', text: `Ранний возврат (на ${diffMins} мин быстрее нормы)` };
        } else if (!status.arriveStatus && elapsed > prof.avgTripMs * 2.2) {
          const diffMins = Math.round((elapsed - prof.avgTripMs) / 60000);
          anomaly = { type: 'slow', text: `Задержка рейса (+${diffMins} мин к норме)` };
        }
      }

      return {
        truckId,
        predictedVol,
        predictedMaterial,
        predictedMins: Math.max(10, predictedMins),
        confidence,
        anomaly,
        totalTrained: prof ? prof.totalLoads : 0
      };
    },

    getOverallMetrics() {
      const keys = Object.keys(this.data.truckProfiles);
      let totalLoads = 0;
      let totalTrips = 0;
      keys.forEach(k => {
        totalLoads += this.data.truckProfiles[k].totalLoads || 0;
        totalTrips += (this.data.truckProfiles[k].tripDurationsMs || []).length;
      });
      return {
        profiledTrucks: keys.length,
        totalLoads,
        totalTrips,
        lastTrainedAt: this.data.lastTrainedAt
      };
    },

    exportPayloadForNas() {
      return {
        uid: window.currentUid || 'anonymous',
        email: window.currentEmail || '',
        updatedAt: Date.now(),
        truckProfiles: this.data.truckProfiles,
        totalPredictions: this.data.totalPredictions,
        correctPredictions: this.data.correctPredictions
      };
    },

    importAggregatedWeights(serverData) {
      if (!serverData?.truckProfiles) return;
      for (const [truckId, remoteProf] of Object.entries(serverData.truckProfiles)) {
        if (!this.data.truckProfiles[truckId]) {
          this.data.truckProfiles[truckId] = remoteProf;
        } else {
          const local = this.data.truckProfiles[truckId];
          for (const [vol, count] of Object.entries(remoteProf.volumes || {})) {
            local.volumes[vol] = (local.volumes[vol] || 0) + count;
          }
          for (const [mat, count] of Object.entries(remoteProf.materials || {})) {
            local.materials[mat] = (local.materials[mat] || 0) + count;
          }
          local.totalLoads = (local.totalLoads || 0) + (remoteProf.totalLoads || 0);
          if (remoteProf.avgTripMs > 0) {
            local.avgTripMs = local.avgTripMs ? Math.round((local.avgTripMs + remoteProf.avgTripMs) / 2) : remoteProf.avgTripMs;
          }
        }
      }
      this.save();
    }
  };

  // ==========================================================
  // 2. ИИ-СИМУЛЯТОР СМЕНЫ (Виртуальный парк для тестирования)
  // ==========================================================
  const AiShiftSimulator = {
    running: false,
    timer: null,
    speedFactor: 15,
    logs: [],
    roundCount: 0,
    totalSimulatedLoads: 0,

    start() {
      if (!window.state?.shift) {
        if (typeof showToastEl === 'function') {
          showToastEl('⚠️ Сначала откройте тестовую смену', true);
        }
        return false;
      }
      this.running = true;
      this.addLog('▶️ Симулятор смены запущен (Скорость ' + this.speedFactor + 'x)');
      this.scheduleNextTick();
      AiCopilotUI.updateSimulatorUI();
      return true;
    },

    pause() {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.addLog('⏸ Симулятор приостановлен');
      AiCopilotUI.updateSimulatorUI();
    },

    setSpeed(speed) {
      this.speedFactor = speed;
      this.addLog('⚙️ Скорость симулятора: ' + speed + 'x');
      AiCopilotUI.updateSimulatorUI();
    },

    scheduleNextTick() {
      if (!this.running) return;
      const interval = Math.max(600, Math.round(3000 / (this.speedFactor / 5)));
      this.timer = setTimeout(() => {
        this.tick();
        this.scheduleNextTick();
      }, interval);
    },

    tick() {
      if (!this.running || !window.state?.shift) return;
      const onlineTrucks = (window.state?.trucks || []).filter(t => window.state?.truckStatus?.[t.id]?.onLine);
      if (!onlineTrucks.length) {
        this.addLog('⚠️ Нет самосвалов на линии. Добавьте машины на линию.');
        this.pause();
        return;
      }

      const now = Date.now();
      for (const truck of onlineTrucks) {
        const id = truck.id;
        const st = window.state?.truckStatus?.[id] || {};
        const prediction = AiLocalLearner.predict(id);
        const lastL = Number(st.lastLoadTimestamp || 0);

        if (!st.arriveStatus && lastL > 0) {
          const tripDurationReal = prediction.predictedMins * 60000;
          const tripDurationSim = tripDurationReal / this.speedFactor;
          if (now - lastL >= Math.min(tripDurationSim, 8000)) {
            this.simulateArrival(truck);
            return;
          }
        }

        if (!st.arriveStatus && !lastL) {
          this.simulateArrival(truck);
          return;
        }

        if (st.arriveStatus && !st.loadedAfterArrive) {
          this.simulateLoad(truck, prediction);
          return;
        }

        if (st.loadedAfterArrive && !st.ttnStatus) {
          this.simulateTtn(truck);
          return;
        }
      }
    },

    stepOneCycle() {
      if (!window.state?.shift) {
        if (typeof showToastEl === 'function') showToastEl('⚠️ Сначала откройте тестовую смену', true);
        return;
      }
      const onlineTrucks = (window.state?.trucks || []).filter(t => window.state?.truckStatus?.[t.id]?.onLine);
      if (!onlineTrucks.length) {
        if (typeof showToastEl === 'function') showToastEl('⚠️ Нет машин на линии', true);
        return;
      }

      let actionsCount = 0;
      onlineTrucks.slice(0, 4).forEach(truck => {
        const id = truck.id;
        const st = window.state?.truckStatus?.[id] || {};
        const prediction = AiLocalLearner.predict(id);
        if (!st.arriveStatus) {
          this.simulateArrival(truck);
          actionsCount++;
        } else if (!st.loadedAfterArrive) {
          this.simulateLoad(truck, prediction);
          actionsCount++;
        } else if (!st.ttnStatus) {
          this.simulateTtn(truck);
          actionsCount++;
        }
      });
      this.roundCount++;
      this.addLog(`⚡ Экспресс-шаг: выполнено ${actionsCount} действий`);
      AiCopilotUI.updateSimulatorUI();
    },

    simulateArrival(truck) {
      if (typeof toggleArrive === 'function') {
        toggleArrive(truck.id);
        this.addLog(`🚛 <b>${truck.brand} ${truck.number}</b>: Прибыл на погрузку`, 'arrive');
      }
    },

    simulateLoad(truck, prediction) {
      if (typeof performLoad === 'function') {
        performLoad(truck.id);
        this.totalSimulatedLoads++;
        AiLocalLearner.recordLoad(truck.id, prediction.predictedVol, prediction.predictedMaterial, prediction.predictedMins * 60000);
        this.addLog(`⚡ <b>${truck.brand} ${truck.number}</b>: Погрузка ${prediction.predictedVol} м³ (${prediction.predictedMaterial})`, 'load');
      }
    },

    simulateTtn(truck) {
      if (typeof toggleTtn === 'function') {
        toggleTtn(truck.id);
        this.addLog(`📄 <b>${truck.brand} ${truck.number}</b>: ТТН оформлена, отправлен в рейс`);
      }
    },

    addLog(msg, type = '') {
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.logs.unshift({ time, msg, type });
      if (this.logs.length > 60) this.logs.pop();
      AiCopilotUI.renderSimulatorLogs();
    },

    reset() {
      this.pause();
      this.logs = [];
      this.roundCount = 0;
      this.totalSimulatedLoads = 0;
      this.addLog('🔄 Логи симуляции сброшены');
      AiCopilotUI.renderSimulatorLogs();
      AiCopilotUI.updateSimulatorUI();
    }
  };

  // ==========================================================
  // 3. ГОЛОСОВОЙ ВВОД (Web Speech API + DeepSeek API Bridge)
  // ==========================================================
  const AiVoiceEngine = {
    recognition: null,
    listening: false,
    lastTranscript: '',

    init() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        console.warn('[AI Voice] Web Speech API не поддерживается данным браузером');
        return;
      }
      this.recognition = new SpeechRecognition();
      this.recognition.lang = 'ru-RU';
      this.recognition.continuous = false;
      this.recognition.interimResults = true;

      this.recognition.onstart = () => {
        this.listening = true;
        AiCopilotUI.updateVoiceUI();
      };

      this.recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }
        this.lastTranscript = transcript;
        AiCopilotUI.showVoiceTranscript(transcript);
      };

      this.recognition.onerror = (event) => {
        console.warn('[AI Voice] Ошибка распознавания:', event.error);
        this.listening = false;
        AiCopilotUI.updateVoiceUI();
      };

      this.recognition.onend = () => {
        this.listening = false;
        AiCopilotUI.updateVoiceUI();
        if (this.lastTranscript.trim()) {
          this.processVoiceCommand(this.lastTranscript);
        }
      };
    },

    toggleListen() {
      if (window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission('voice_input')) {
        if (typeof showToastEl === 'function') {
          showToastEl('🔒 Голосовой ввод отключен для вашей роли', true);
        }
        return;
      }
      if (!this.recognition) {
        this.init();
      }
      if (!this.recognition) {
        if (typeof showToastEl === 'function') {
          showToastEl('Голосовой ввод не поддерживается в этом браузере', true);
        }
        return;
      }
      if (this.listening) {
        this.recognition.stop();
      } else {
        this.lastTranscript = '';
        AiCopilotUI.showVoiceTranscript('Слушаю команду...');
        try {
          this.recognition.start();
        } catch (e) {
          console.warn('[AI Voice] Не удалось запустить распознавание:', e);
        }
      }
    },

    async processVoiceCommand(text) {
      AiCopilotUI.showVoiceTranscript('Обработка: "' + text + '"...');
      
      const apiKey = localStorage.getItem(STORAGE_KEY_API_KEY) || localStorage.getItem(STORAGE_KEY_DEEPSEEK);
      const model = this.getAiModel('light');
      let apiError = null;

      if (apiKey && navigator.onLine) {
        try {
          const parsed = await this.queryExternalAiApi(text, apiKey);
          if (parsed) {
            parsed.sourceBadge = {
              type: 'api',
              label: `🌐 Внешний ИИ: Apimira / ${model}`,
              details: 'Распознано через шлюз API Apimira'
            };
            AiCopilotUI.showParsedPreview(parsed);
            return;
          }
        } catch (e) {
          console.warn('[AI API] Ошибка внешнего API (Apimira), переключаюсь на локальный парсер:', e);
          apiError = e.message || 'Сбой вызова API';
        }
      } else if (!apiKey) {
        apiError = 'API-ключ не задан в настройках';
      } else if (!navigator.onLine) {
        apiError = 'Устройство оффлайн';
      }

      const localResult = this.parseLocally(text);
      localResult.sourceBadge = {
        type: 'local',
        label: '⚡ Локальный интеллект',
        details: apiError ? `${apiError} ➔ Переключено на локальный парсер` : 'Автономный режим'
      };
      AiCopilotUI.showParsedPreview(localResult);
    },

    parseLocally(text) {
      const lower = text.toLowerCase();
      const result = {
        sourceText: text,
        type: 'unknown',
        truckActions: [],
        tabelRows: []
      };

      // 1. Команда мгновенной отправки доработок в OpenCode
      if ((lower.includes('доработк') || lower.includes('разработчик') || lower.includes('opencode')) &&
          (lower.includes('отправ') || lower.includes('пошли') || lower.includes('скинь') || lower.includes('всё') || lower.includes('все'))) {
        result.type = 'dispatch_opencode';
        result.message = '🚀 Отправка всех доработок в OpenCode';
        return result;
      }

      // 2. Команда быстрого фотоконтроля
      if (lower.includes('фото') || lower.includes('сфоткай') || lower.includes('камер')) {
        result.type = 'take_photo';
        result.message = '📸 Регламент фотоконтроля (5 фото)';
        return result;
      }

      // 3. Команда открытия маршрута Яндекс Карт
      if (lower.includes('маршрут') || lower.includes('яндекс') || lower.includes('пробк')) {
        result.type = 'open_route';
        result.message = '🗺️ Яндекс Маршрут и пробки';
        return result;
      }

      // 4. Определение рейса перемещения на другой объект
      let isTransfer = false;
      let transferDest = '';
      if (lower.includes('перемещен') || lower.includes('переброс')) {
        isTransfer = true;
        const destMatch = text.match(/(?:перемещение|переброска)\s+на\s+([А-Яа-яA-Za-z0-9\s\-]+?)(?:\s+(?:погрузка|\d+|$))/i) ||
                          text.match(/на\s+([А-Яа-яA-Za-z0-9\s\-]+?)\s+перемещение/i);
        if (destMatch && destMatch[1]) {
          transferDest = destMatch[1].trim();
        } else {
          transferDest = 'База Север';
        }
      }

      const hoursMatch = lower.match(/(\d{1,2})\s*(?:час|ч)/);
      const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : null;

      ['фреза', 'щетка', 'щётка', 'погрузчик', 'каток', 'поливомойка'].forEach(machine => {
        if (lower.includes(machine)) {
          result.tabelRows.push({
            name: machine.charAt(0).toUpperCase() + machine.slice(1),
            role: 'equipment',
            hours: hours || 10
          });
        }
      });

      const words = text.split(/\s+/);
      words.forEach(w => {
        if (w.length > 3 && /^[А-ЯЁ][а-яё]+/.test(w) && !['Смена', 'Табель', 'Линия', 'Фреза'].includes(w)) {
          result.tabelRows.push({
            name: w,
            role: 'worker',
            hours: hours || 11
          });
        }
      });

      const numberMatch = lower.match(/\b(\d{3})\b/);
      if (numberMatch && window.state?.trucks) {
        const truckNum = numberMatch[1];
        const truck = window.state.trucks.find(t => String(t.number || '').includes(truckNum));
        if (truck) {
          let action = 'arrive';
          if (lower.includes('погруз') || lower.includes('груз')) action = 'load';
          if (lower.includes('ттн') || lower.includes('накладн')) action = 'ttn';
          
          let vol = truck.defaultVol || 20;
          const volMatch = lower.match(/(\d{2})\s*(?:куб|м3|м³)/);
          if (volMatch) vol = parseInt(volMatch[1], 10);

          result.truckActions.push({
            truckId: truck.id,
            truckName: `${truck.brand} ${truck.number}`,
            action,
            volume: vol,
            isTransfer,
            transferDest
          });
        }
      }

      if (result.truckActions.length) {
        result.type = 'line';
        result.tabelRows = [];
      } else if (result.tabelRows.length) {
        result.type = 'tabel';
      }

      return result;
    },

    getAiModel(taskType = 'light') {
      if (taskType === 'heavy') {
        return localStorage.getItem(STORAGE_KEY_API_MODEL_HEAVY) || 'deepseek/deepseek-reasoner';
      }
      return localStorage.getItem(STORAGE_KEY_API_MODEL_LIGHT) || localStorage.getItem(STORAGE_KEY_API_MODEL) || 'deepseek/deepseek-chat';
    },

    async queryExternalAiApi(text, apiKey, taskType = 'light') {
      const endpoint = localStorage.getItem(STORAGE_KEY_API_ENDPOINT) || 'https://api.apimira.com/v1/chat/completions';
      const model = this.getAiModel(taskType);

      const prompt = `Ты строительный ассистент дорожного участка. 
Распознай из надиктованного текста команды для табеля и линии самосвалов.
Текст: "${text}"
Верни СТРОГО JSON без лишних слов:
{
  "type": "tabel" или "line",
  "truckActions": [{"truckNumber": "3 цифры номера", "action": "arrive"|"load"|"ttn", "volume": число}],
  "tabelRows": [{"name": "Фамилия или техника", "role": "worker"|"equipment"|"itr", "hours": число}]
}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1
        })
      });

      if (!response.ok) throw new Error('API status: ' + response.status);
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      const cleanJson = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      parsed.sourceText = text;
      return parsed;
    }
  };

  // ==========================================================
  // 4. БОРТЖУРНАЛ ОШИБОК И ГЕНЕРАТОР ПРОМПТОВ ДЛЯ НЕЙРОСЕТИ
  // ==========================================================
  const AiFeedbackCollector = {
    errors: [],
    feedbacks: [],

    init() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_FEEDBACK);
        if (saved) {
          const parsed = JSON.parse(saved);
          this.feedbacks = parsed.feedbacks || [];
          this.errors = parsed.errors || [];
        }
      } catch (e) {}

      // Перехват системных ошибок интерфейса
      window.addEventListener('error', (event) => {
        this.addError({
          type: 'error',
          message: event.message || 'Script error',
          source: (event.filename || '').split('/').pop() + ':' + (event.lineno || 0),
          time: new Date().toLocaleTimeString('ru-RU')
        });
      });

      window.addEventListener('unhandledrejection', (event) => {
        this.addError({
          type: 'unhandledrejection',
          message: event.reason?.message || String(event.reason) || 'Promise rejection',
          source: 'Promise',
          time: new Date().toLocaleTimeString('ru-RU')
        });
      });
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY_FEEDBACK, JSON.stringify({
          feedbacks: this.feedbacks.slice(-50),
          errors: this.errors.slice(-50)
        }));
      } catch (e) {}
    },

    addError(err) {
      this.errors.unshift(err);
      if (this.errors.length > 50) this.errors.pop();
      this.save();
      AiCopilotUI.renderFeedbackList();
    },

    addFeedback(text) {
      if (!text || !text.trim()) return;
      const activeTabEl = document.querySelector('.nav-btn.active') || document.querySelector('.tab-content.active');
      const tabName = activeTabEl?.dataset?.tab || activeTabEl?.id?.replace('tab-', '') || 'line';
      
      this.feedbacks.unshift({
        id: 'fb_' + Date.now(),
        text: text.trim(),
        tab: tabName,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        date: new Date().toLocaleDateString('ru-RU'),
        viewport: `${window.innerWidth}x${window.innerHeight}`
      });
      if (this.feedbacks.length > 50) this.feedbacks.pop();
      this.save();
      AiCopilotUI.renderFeedbackList();
    },

    removeFeedback(idOrIdx) {
      this.feedbacks = this.feedbacks.filter((f, idx) => f.id !== idOrIdx && String(idx) !== String(idOrIdx));
      this.save();
      AiCopilotUI.renderFeedbackList();
      if (typeof showToastEl === 'function') showToastEl('🗑️ Замечание удалено', false);
    },

    removeError(index) {
      this.errors = this.errors.filter((_, idx) => idx !== Number(index));
      this.save();
      AiCopilotUI.renderFeedbackList();
      if (typeof showToastEl === 'function') showToastEl('🗑️ Ошибка удалена', false);
    },

    clearFeedbacks() {
      const count = this.feedbacks.length;
      this.feedbacks = [];
      this.save();
      AiCopilotUI.renderFeedbackList();
      if (typeof showToastEl === 'function') showToastEl(`🧹 Очищено выполненных замечаний: ${count}`, false);
    },

    clearErrors() {
      const count = this.errors.length;
      this.errors = [];
      this.save();
      AiCopilotUI.renderFeedbackList();
      if (typeof showToastEl === 'function') showToastEl(`🧹 Очищено ошибок: ${count}`, false);
    },

    clearAll() {
      const total = this.feedbacks.length + this.errors.length;
      this.feedbacks = [];
      this.errors = [];
      this.save();
      AiCopilotUI.renderFeedbackList();
      if (typeof showToastEl === 'function') showToastEl(`🧹 Все замечания и ошибки очищены (${total} шт.)`, false);
    },

    generatePromptForAiDeveloper() {
      const shift = window.state?.shift;
      const shiftDesc = shift ? `Активна (Объект: "${shift.objectName || shift.objectId || 'Тест'}")` : 'Закрыта';
      const version = document.querySelector('meta[name="test-app-version"]')?.content || '4.1.4 (тест)';
      const buildId = document.querySelector('meta[name="test-app-build"]')?.content || 'latest';
      const dateStr = new Date().toLocaleDateString('ru-RU');

      const traffic = AiLocalLearner.getTrafficFactor();
      const patterns = AiLocalLearner.data.shiftEndPatterns || {};
      const typicalTtn = patterns.typicalTtnStartHour || 16.0;
      const ttnTimeStr = Math.floor(typicalTtn) + ':' + String(Math.round((typicalTtn % 1) * 60)).padStart(2, '0');
      const typicalEnd = patterns.typicalEndHour || 16.5;
      const endTimeStr = Math.floor(typicalEnd) + ':' + String(Math.round((typicalEnd % 1) * 60)).padStart(2, '0');

      let prompt = `# Техническое задание для ИИ-разработчика (OpenCode / LLM)\n\n`;
      prompt += `**Проект:** «Учёт самосвалов и Табель»\n`;
      prompt += `**Окружение:** index-test.html · Версия: ${version} · Сборка: ${buildId}\n`;
      prompt += `**Дата фиксации:** ${dateStr}\n`;
      prompt += `**Текущий статус смены:** ${shiftDesc}\n`;
      prompt += `**Дорожный контекст:** ${traffic.dayName} · ${traffic.reason} (x${traffic.factor})\n`;
      prompt += `**Паттерн завершения смены:** сбор ТТН ~${ttnTimeStr}, закрытие ~${endTimeStr}\n\n`;

      prompt += `## 1. Замечания и пожелания пользователя по интерфейсу:\n`;
      if (this.feedbacks.length > 0) {
        this.feedbacks.slice(0, 10).forEach((fb, i) => {
          prompt += `${i + 1}. **[${fb.time}, экран: ${fb.tab}, размер: ${fb.viewport}]**: ${fb.text}\n`;
        });
      } else {
        prompt += `*Пользовательские замечания пока не зафиксированы.*\n`;
      }

      prompt += `\n## 2. Автоматически выявленные узкие места UX и предложения ИИ:\n`;
      const suggestions = AiUxAnalytics.generateSuggestions();
      if (suggestions.length > 0) {
        suggestions.forEach((sug, i) => {
          prompt += `${i + 1}. **[${sug.title}]**: ${sug.text}\n`;
        });
      } else {
        prompt += `*Интерфейс работает в штатном режиме.*\n`;
      }

      prompt += `\n## 3. Зафиксированные ошибки интерфейса (Console/Runtime):\n`;
      if (this.errors.length > 0) {
        this.errors.slice(0, 8).forEach((err, i) => {
          prompt += `${i + 1}. \`[${err.time}] [${err.type}]\` ${err.message} (${err.source})\n`;
        });
      } else {
        prompt += `*Ошибок выполнения скриптов не обнаружено.*\n`;
      }

      prompt += `\n## 4. Требования к реализации изменений:\n`;
      prompt += `- Сохранять принцип Offline-First и защиту от дублей отметок рейсов.\n`;
      prompt += `- Рабочую версию index.html не менять; правки вносить в test-app/source/ с последующей сборкой через tools/build-test.py.\n`;
      prompt += `- Поддерживать лёгкую математику в PWA и фоновую агрегацию весов на Synology NAS без перегрузки процессора сервера.\n`;
      prompt += `- Учесть вышеуказанные замечания пользователя и предложения ИИ по улучшению UX.\n`;

      return prompt;
    }
  };

  // ==========================================================
  // 5. АНАЛИЗАТОР UX И ПОВЕДЕНИЯ ОПЕРАТОРОВ (UX Intelligence)
  // ==========================================================
  const AiUxAnalytics = {
    stats: {
      actionCounts: {},
      lastActionTimestamp: 0
    },

    init() {
      try {
        const saved = localStorage.getItem('samosval_ai_ux_v1');
        if (saved) {
          this.stats = JSON.parse(saved);
        }
      } catch (e) {}
      this.attachListeners();
    },

    save() {
      try {
        localStorage.setItem('samosval_ai_ux_v1', JSON.stringify(this.stats));
      } catch (e) {}
    },

    attachListeners() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const txt = btn.textContent || '';
        const cls = btn.className || '';

        if (cls.includes('btn-arrive') || txt.includes('Прибыл')) {
          this.recordAction('arrive');
        } else if (cls.includes('btn-load') || txt.includes('Погрузка')) {
          this.recordAction('load');
        } else if (cls.includes('btn-ttn') || txt.includes('ТТН')) {
          this.recordAction('ttn');
          AiLocalLearner.recordShiftActivity('ttn');
          
          const card = btn.closest('.truck-card');
          const truckId = card?.dataset?.truckId;
          if (truckId) {
            const check = AiLocalLearner.checkLastRoundFeasibility(truckId);
            if (check.warning) {
              if (typeof showToastEl === 'function') {
                showToastEl(check.message, true);
              }
            }
          }
        } else if (cls.includes('btn-undo') || txt.includes('Отмена') || txt.includes('Удалить')) {
          this.recordAction('cancel');
        }
      }, true);
    },

    recordAction(type) {
      if (!this.stats.actionCounts) this.stats.actionCounts = {};
      this.stats.actionCounts[type] = (this.stats.actionCounts[type] || 0) + 1;
      this.stats.lastActionTimestamp = Date.now();
      this.save();
    },

    generateSuggestions() {
      const suggestions = [];
      const cancels = this.stats.actionCounts?.cancel || 0;

      // 1. Анализ отмен
      if (cancels >= 1) {
        suggestions.push({
          type: 'ui_safety',
          title: 'Защита от ошибочных нажатий при вибрации/морозе',
          text: `Зафиксировано ${cancels} отмен отметок. Предложение: увеличить кликабельную область кнопок на 15% и добавить режим подтверждения перед отправкой в рейс.`
        });
      }

      // 2. Сбор ТТН и дорожный трафик
      const patterns = AiLocalLearner.data.shiftEndPatterns;
      const typicalTtn = patterns?.typicalTtnStartHour || 16.0;
      const ttnTimeStr = Math.floor(typicalTtn) + ':' + String(Math.round((typicalTtn % 1) * 60)).padStart(2, '0');
      const traffic = AiLocalLearner.getTrafficFactor();

      suggestions.push({
        type: 'shift_timing',
        title: `Паттерн завершения смены (~${ttnTimeStr}) и дорожный трафик`,
        text: `Изучено поведение: сбор ТТН обычно начинается около ${ttnTimeStr}. Сегодня: ${traffic.dayName} (${traffic.reason}). Учитывайте время сбора ТТН и дорожный трафик при планировании работы до закрытия смены.`
      });

      // 3. Авто-сортировка активных машин
      const trucks = window.state?.trucks || [];
      if (trucks.length >= 3) {
        suggestions.push({
          type: 'fleet_opt',
          title: 'Автоматическая приоритизация карточек',
          text: `В списке ${trucks.length} самосвалов. Предложение: автоматически закреплять самосвалы на погрузке и с оформленной ТТН вверху экрана для сокращения лишнего скролла.`
        });
      }

      return suggestions;
    }
  };

  // ==========================================================
  // 6. СИНХРОНИЗАЦИЯ ВЕСОВ И UX С SYNOLOGY NAS (Federated Learning)
  // ==========================================================
  const AiNasSyncBridge = {
    isSyncing: false,
    lastSyncTime: 0,

    getPayload() {
      return {
        type: 'samosval_ai_federated_weights',
        datasetEpoch: Date.now(),
        uid: window.currentUid || 'client_pwa',
        userEmail: window.currentEmail || 'anonymous',
        appVersion: document.querySelector('meta[name="test-app-version"]')?.content || '4.1.4',
        weights: {
          truckProfiles: AiLocalLearner.data.truckProfiles,
          shiftPatterns: AiLocalLearner.data.shiftEndPatterns
        },
        uxSummary: {
          actionCounts: AiUxAnalytics.stats.actionCounts,
          feedbacksCount: AiFeedbackCollector.feedbacks.length,
          errorsCount: AiFeedbackCollector.errors.length
        }
      };
    },

    async pushWeightsToNas() {
      if (this.isSyncing) return false;
      this.isSyncing = true;
      try {
        const payload = this.getPayload();
        localStorage.setItem('samosval_nas_ai_outbox', JSON.stringify(payload));
        
        if (typeof isNasRuntime === 'function' && isNasRuntime()) {
          const resp = await fetch('https://iluxa.synology.me:18443/api/nas/ai-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (resp.ok) {
            this.lastSyncTime = Date.now();
            return true;
          }
        }
        this.lastSyncTime = Date.now();
        return true;
      } catch (e) {
        return false;
      } finally {
        this.isSyncing = false;
      }
    }
  };

  // ==========================================================
  // 7. КОНВЕЙЕР ФРЕЗЫ И БАЛАНС АВТОПАРКА (Milling Pipeline & Fleet Balance)
  // ==========================================================
  const MillingPipelineTracker = {
    state: {
      lastMillingLoadTs: 0,
      lastMillingTruckId: null,
      loadsHistory: [], // { truckId, ts, loadDurationMs, volume, isTransfer, transferDest }
      avgLoadMins: 8,   // T_load (по умолчанию 8 мин)
      avgTravelMins: 32,// T_travel (по умолчанию 32 мин)
      millingRateM3h: 120 // Q (м³/ч)
    },

    init() {
      this.loadState();
      this.recalculate();
    },

    loadState() {
      try {
        const s = localStorage.getItem('samosval_ai_milling_v1');
        if (s) Object.assign(this.state, JSON.parse(s));
      } catch (e) {}
    },

    saveState() {
      try {
        localStorage.setItem('samosval_ai_milling_v1', JSON.stringify(this.state));
      } catch (e) {}
    },

    onTruckLoad(truckId, volume = 20, isTransfer = false, transferDest = '') {
      const now = Date.now();
      let loadDurationMs = 8 * 60000;
      
      // Аксиома 1 фрезы:
      // Когда текущий самосвал встает под погрузку, предыдущий гарантированно закончил погрузку и поехал на разгрузку
      if (this.state.lastMillingLoadTs > 0) {
        const elapsed = now - this.state.lastMillingLoadTs;
        if (elapsed >= 2 * 60000 && elapsed <= 45 * 60000) {
          loadDurationMs = elapsed;
        }
      }

      const record = {
        truckId,
        ts: now,
        loadDurationMs,
        volume: Number(volume) || 20,
        isTransfer: !!isTransfer,
        transferDest: transferDest || ''
      };

      this.state.loadsHistory.push(record);
      if (this.state.loadsHistory.length > 50) this.state.loadsHistory.shift();

      this.state.lastMillingLoadTs = now;
      this.state.lastMillingTruckId = truckId;

      this.recalculate();
      this.saveState();
      if (window.AiCopilotUI) AiCopilotUI.renderShiftBanner();
    },

    recalculate() {
      if (!this.state.loadsHistory.length) return;
      
      const loads = this.state.loadsHistory;
      const totalLoadMs = loads.reduce((sum, l) => sum + l.loadDurationMs, 0);
      const avgLoadMs = totalLoadMs / loads.length;
      this.state.avgLoadMins = Math.max(3, Math.round(avgLoadMs / 60000));

      // Расчет производительности фрезы Q (м³/ч)
      const oneHourAgo = Date.now() - 3600000;
      const recent = loads.filter(l => l.ts >= oneHourAgo);
      if (recent.length >= 2) {
        const totalV = recent.reduce((sum, l) => sum + l.volume, 0);
        const spanHours = (Date.now() - recent[0].ts) / 3600000;
        if (spanHours > 0.1) {
          this.state.millingRateM3h = Math.round(totalV / spanHours);
        }
      } else {
        const avgVol = loads.reduce((s, l) => s + l.volume, 0) / loads.length;
        this.state.millingRateM3h = Math.round(avgVol / (this.state.avgLoadMins / 60));
      }

      // T_travel: расчет среднего плеча хода без учета погрузки (исключая нестандартные трансферы)
      const activeTrucks = (window.state?.trucks || []).filter(t => window.state?.truckStatus?.[t.id]?.onLine);
      let totalTravelMins = 0;
      let count = 0;
      activeTrucks.forEach(t => {
        const p = AiLocalLearner.predict(t.id);
        if (p.predictedMins) {
          totalTravelMins += p.predictedMins;
          count++;
        }
      });
      this.state.avgTravelMins = count ? Math.round(totalTravelMins / count) : 32;
    },

    getFleetBalance() {
      const tLoad = Math.max(2, this.state.avgLoadMins);
      const tTravel = Math.max(5, this.state.avgTravelMins);
      // Формула идеального количества самосвалов:
      // N_ideal = (T_travel + T_load) / T_load
      const idealN = (tTravel + tLoad) / tLoad;
      const roundedIdeal = Math.round(idealN * 10) / 10;

      const activeTrucksCount = (window.state?.trucks || []).filter(t => window.state?.truckStatus?.[t.id]?.onLine).length || 1;

      let status = 'optimal';
      let message = 'Ритм фрезы и автопарк сбалансированы';

      if (activeTrucksCount < idealN - 0.7) {
        status = 'starvation';
        const shortage = Math.ceil(idealN - activeTrucksCount);
        message = `⚠️ Дефицит автопарка! Фреза простаивает. Рекомендуется добавить +${shortage} самосвал(а).`;
      } else if (activeTrucksCount > idealN + 1.2) {
        status = 'excess';
        const excess = Math.floor(activeTrucksCount - idealN);
        message = `⏳ Избыток машин! Очередь под фрезой (+${excess} лишних). Перерасход топлива.`;
      } else {
        status = 'optimal';
        message = `✅ Оптимальный конвейер: фреза работает без простоев, очередей нет.`;
      }

      return {
        status,
        message,
        idealN: roundedIdeal,
        activeN: activeTrucksCount,
        tLoad,
        tTravel,
        millingRateM3h: Math.max(20, this.state.millingRateM3h)
      };
    }
  };

  // ==========================================================
  // 8. ЯНДЕКС КАРТЫ И МАРШРУТЫ (AiRouteManager)
  // ==========================================================
  const AiRouteManager = {
    loadAddress: '',
    unloadAddress: '',

    init() {
      try {
        const saved = localStorage.getItem('samosval_ai_route_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          this.loadAddress = parsed.loadAddress || '';
          this.unloadAddress = parsed.unloadAddress || '';
        }
      } catch (e) {}
    },

    save(loadAddr, unloadAddr) {
      this.loadAddress = (loadAddr || '').trim();
      this.unloadAddress = (unloadAddr || '').trim();
      try {
        localStorage.setItem('samosval_ai_route_v1', JSON.stringify({
          loadAddress: this.loadAddress,
          unloadAddress: this.unloadAddress
        }));
      } catch (e) {}
    },

    getYandexMapsUrl() {
      const from = this.loadAddress || (window.state?.shift?.objectName ? window.state.shift.objectName + ', Санкт-Петербург' : 'Санкт-Петербург');
      const to = this.unloadAddress || 'АБЗ, Санкт-Петербург';
      return `https://yandex.ru/maps/?rtext=${encodeURIComponent(from)}~${encodeURIComponent(to)}&rtt=auto`;
    },

    openYandexMaps() {
      const url = this.getYandexMapsUrl();
      window.open(url, '_blank');
      if (typeof showToastEl === 'function') {
        showToastEl('🗺️ Открыт маршрут и пробки в Яндекс Картах', false);
      }
    }
  };

  // ==========================================================
  // 9. ДИНАМИЧЕСКАЯ АНАЛИТИКА И ЭКСПОРТ СВОДКИ (AiDynamicAnalytics)
  // ==========================================================
  const AiDynamicAnalytics = {
    getSummaryData() {
      const logs = window.state?.logs || [];
      const shift = window.state?.shift;
      const stdLogs = logs.filter(l => !l.isGAI);
      const factoryLogs = stdLogs.filter(l => !l.isTransfer);
      const transferLogs = stdLogs.filter(l => !!l.isTransfer);

      const factVol = factoryLogs.reduce((s, l) => s + (Number(l.volume) || 0), 0);
      const transVol = transferLogs.reduce((s, l) => s + (Number(l.volume) || 0), 0);
      const totalVol = factVol + transVol;

      const balance = MillingPipelineTracker.getFleetBalance();
      const photoProgress = AiPhotoProtocol.getProgress();

      // Прогноз выполнения плана к 16:30
      const now = new Date();
      const currentH = now.getHours() + now.getMinutes() / 60;
      const targetH = 16.5;
      const remainingHours = Math.max(0, targetH - currentH);
      const projectedAddVol = Math.round(remainingHours * (balance.millingRateM3h || 100));
      const projected1630Vol = factVol + projectedAddVol;

      return {
        objectName: shift ? (shift.objectName || shift.objectId || 'Тестовый объект') : 'Смена закрыта',
        dateStr: new Date().toLocaleDateString('ru-RU'),
        timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        totalTrips: stdLogs.length,
        factTrips: factoryLogs.length,
        factVol,
        transTrips: transferLogs.length,
        transVol,
        totalVol,
        millingRate: balance.millingRateM3h,
        balance,
        photoProgress,
        projected1630Vol,
        loadAddr: AiRouteManager.loadAddress,
        unloadAddr: AiRouteManager.unloadAddress
      };
    },

    generateShareText() {
      const d = this.getSummaryData();
      let text = `📊 СВОДКА СМЕНЫ: ${d.objectName}\n`;
      text += `📅 ${d.dateStr} · ${d.timeStr}\n\n`;
      text += `🚛 На завод: ${d.factVol} м³ (${d.factTrips} рейсов)\n`;
      if (d.transTrips > 0) {
        text += `🔄 Перемещения: ${d.transVol} м³ (${d.transTrips} рейсов)\n`;
      }
      text += `⚡ Ритм фрезы: ~${d.millingRate} м³/ч\n`;
      text += `🚦 Автопарк: ${d.balance.activeN} из ${d.balance.idealN} расч. (${d.balance.status === 'optimal' ? 'Идеал' : d.balance.status === 'starvation' ? 'Дефицит' : 'Избыток'})\n`;
      if (d.loadAddr || d.unloadAddr) {
        text += `🗺️ Маршрут: ${d.loadAddr || 'Погрузка'} ➔ ${d.unloadAddr || 'Разгрузка'}\n`;
      }
      text += `📸 Фотоконтроль: ${d.photoProgress.count} из 5 выполнено\n`;
      text += `🎯 Прогноз к 16:30: ~${d.projected1630Vol} м³\n`;
      text += `\n— Учёт самосвалов PWA`;
      return text;
    },

    async copyShareText() {
      const text = this.generateShareText();
      try {
        await navigator.clipboard.writeText(text);
        if (typeof showToastEl === 'function') showToastEl('📋 Сводка скопирована для WhatsApp/Telegram!', false);
      } catch (e) {
        alert(text);
      }
    },

    shareViaWhatsApp() {
      const text = encodeURIComponent(this.generateShareText());
      window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
    },

    shareViaTelegram() {
      const text = encodeURIComponent(this.generateShareText());
      window.open(`https://t.me/share/url?url=${text}`, '_blank');
    }
  };

  // ==========================================================
  // 10. РЕГЛАМЕНТ ФОТОФИКСАЦИИ (5 ФОТО ЗА СМЕНУ) (AiPhotoProtocol)
  // ==========================================================
  const AiPhotoProtocol = {
    steps: [
      { id: 1, title: 'Начало смены / расстановка техники' },
      { id: 2, title: 'Работа фрезы / глубина срезки' },
      { id: 3, title: 'Погрузка / автоколонна' },
      { id: 4, title: 'Разгрузка / укладка асфальта' },
      { id: 5, title: 'Завершение смены / приёмка захватки' }
    ],
    completedSteps: {},
    appType: 'camera_native', // 'camera_native' | 'app_custom'
    customAppUrl: '',

    init() {
      try {
        const saved = localStorage.getItem('samosval_ai_photo_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          this.completedSteps = parsed.completedSteps || {};
          this.appType = parsed.appType || 'camera_native';
          this.customAppUrl = parsed.customAppUrl || '';
        }
      } catch (e) {}
    },

    save() {
      try {
        localStorage.setItem('samosval_ai_photo_v1', JSON.stringify({
          completedSteps: this.completedSteps,
          appType: this.appType,
          customAppUrl: this.customAppUrl
        }));
      } catch (e) {}
    },

    getProgress() {
      const completed = Object.keys(this.completedSteps).filter(k => this.completedSteps[k]).length;
      return {
        count: completed,
        total: 5,
        isCompleted: completed >= 5,
        nextStep: this.steps.find(s => !this.completedSteps[s.id]) || this.steps[4]
      };
    },

    triggerTakePhoto(stepId) {
      const id = stepId || this.getProgress().nextStep.id;
      this.completedSteps[id] = { ts: Date.now(), timeStr: new Date().toLocaleTimeString('ru-RU') };
      this.save();
      if (window.AiCopilotUI) AiCopilotUI.renderShiftBanner();

      if (this.appType === 'app_custom' && this.customAppUrl) {
        window.open(this.customAppUrl, '_blank');
      } else {
        const input = document.getElementById('aiHiddenCameraInput');
        if (input) input.click();
      }

      if (typeof showToastEl === 'function') {
        showToastEl(`📸 Фото #${id} зафиксировано в регламенте смены!`, false);
      }
    },

    onFileCaptured(event) {
      const file = event.target.files?.[0];
      if (file && typeof showToastEl === 'function') {
        showToastEl(`📸 Фото успешно сохранено (${Math.round(file.size/1024)} Кб)`, false);
      }
    }
  };

  // ==========================================================
  // 11. DWG / DXF ПИКЕТАЖ, ВЕРТИКАЛЬНАЯ ПЛАНИРОВКА И GPS-ПРИВЯЗКА (AiCadRoadEngine)
  // ==========================================================
  const AiCadRoadEngine = {
    data: {
      startStation: 10.0, // ПК 10+00
      endStation: 15.5,   // ПК 15+50
      widthM: 7.5,        // Ширина дороги 7.5 м
      depthCm: 5.0,       // Глубина фрезерования 5 см
      densityTpm3: 2.35,  // Плотность асфальта т/м³
      truckCapacityM3: 20,// Вместимость самосвала 20 м³
      cadFileName: 'Проект_вертикальная_планировка.dxf',
      cadFileData: null,  // { fileName, fileSize, layers, stations, profile, parsedAt, isBinaryDwg, dwgVersion, warning }
      anchors: [],        // [{ id, station, lat, lon, accuracy, calibratedAt }] (многоточечный пикетаж)
      anchor1: null,      // { station, lat, lon, accuracy, calibratedAt } (обратная совместимость)
      anchor2: null,      // { station, lat, lon, accuracy, calibratedAt } (обратная совместимость)
      vector: null,       // { distanceM, azimuthDeg, stationDelta, ready: true, pointCount }
      lastLocation: null  // { currentStation, offsetM, groundZ, projectZ, cutCm, accuracy, segmentIndex, anchorsCount }
    },

    init() {
      try {
        const saved = localStorage.getItem('samosval_ai_cad_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          Object.assign(this.data, parsed);
        }
        if (!Array.isArray(this.data.anchors)) {
          this.data.anchors = [];
          if (this.data.anchor1) this.data.anchors.push(this.data.anchor1);
          if (this.data.anchor2) this.data.anchors.push(this.data.anchor2);
        }
        this.updateAnchorsState();
        const savedCad = localStorage.getItem('samosval_cad_dwg_v1');
        if (savedCad) this.data.cadFileData = JSON.parse(savedCad);
      } catch (e) {}
    },

    updateAnchorsState() {
      if (!Array.isArray(this.data.anchors)) this.data.anchors = [];
      this.data.anchors.sort((a, b) => a.station - b.station);
      this.data.anchor1 = this.data.anchors[0] || null;
      this.data.anchor2 = this.data.anchors[1] || null;

      if (this.data.anchors.length >= 2) {
        let totalDist = 0;
        const R = 6371e3;
        for (let i = 0; i < this.data.anchors.length - 1; i++) {
          const a = this.data.anchors[i];
          const b = this.data.anchors[i + 1];
          const dLat = (b.lat - a.lat) * Math.PI / 180;
          const dLon = (b.lon - a.lon) * Math.PI / 180;
          const lat1 = a.lat * Math.PI / 180;
          const lat2 = b.lat * Math.PI / 180;
          const dM = R * 2 * Math.asin(Math.sqrt(Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2));
          totalDist += dM;
        }

        const a1 = this.data.anchors[0];
        const aLast = this.data.anchors[this.data.anchors.length - 1];
        const dLat = (aLast.lat - a1.lat) * Math.PI / 180;
        const dLon = (aLast.lon - a1.lon) * Math.PI / 180;
        const lat1 = a1.lat * Math.PI / 180;
        const latLast = aLast.lat * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(latLast);
        const x = Math.cos(lat1) * Math.sin(latLast) - Math.sin(lat1) * Math.cos(latLast) * Math.cos(dLon);
        const azimuthRad = Math.atan2(y, x);
        const azimuthDeg = (azimuthRad * 180 / Math.PI + 360) % 360;
        const stationDelta = aLast.station - a1.station;

        this.data.vector = {
          distanceM: Math.round(totalDist),
          azimuthDeg: Math.round(azimuthDeg),
          stationDelta,
          metersPerStation: stationDelta !== 0 ? Math.abs(totalDist / stationDelta) : 100,
          ready: true,
          pointCount: this.data.anchors.length
        };
      } else {
        this.data.vector = null;
      }
    },

    save() {
      try {
        this.updateAnchorsState();
        localStorage.setItem('samosval_ai_cad_v1', JSON.stringify({
          startStation: this.data.startStation,
          endStation: this.data.endStation,
          widthM: this.data.widthM,
          depthCm: this.data.depthCm,
          densityTpm3: this.data.densityTpm3,
          truckCapacityM3: this.data.truckCapacityM3,
          cadFileName: this.data.cadFileName,
          anchors: this.data.anchors,
          anchor1: this.data.anchor1,
          anchor2: this.data.anchor2,
          vector: this.data.vector
        }));
        if (this.data.cadFileData) {
          localStorage.setItem('samosval_cad_dwg_v1', JSON.stringify(this.data.cadFileData));
        }
      } catch (e) {}
    },

    getGroundZ(station) {
      if (this.data.cadFileData?.profile?.length) {
        const p = this.data.cadFileData.profile;
        const exact = p.find(pt => Math.abs(pt.station - station) < 0.05);
        if (exact) return exact.groundZ;
        for (let i = 0; i < p.length - 1; i++) {
          if (station >= p[i].station && station <= p[i+1].station) {
            const ratio = (station - p[i].station) / (p[i+1].station - p[i].station || 1);
            return Math.round((p[i].groundZ + ratio * (p[i+1].groundZ - p[i].groundZ)) * 100) / 100;
          }
        }
      }
      return Math.round((142.50 + (station - this.data.startStation) * 0.35) * 100) / 100;
    },

    getProjectZ(station) {
      const g = this.getGroundZ(station);
      return Math.round((g - (this.data.depthCm / 100)) * 100) / 100;
    },

    calculateVolume() {
      const lengthM = Math.max(0, (this.data.endStation - this.data.startStation) * 100);
      const areaM2 = lengthM * this.data.widthM;
      const volumeM3 = Math.round(areaM2 * (this.data.depthCm / 100) * 10) / 10;
      const tons = Math.round(volumeM3 * this.data.densityTpm3 * 10) / 10;
      const tripsNeeded = Math.ceil(volumeM3 / (this.data.truckCapacityM3 || 20));

      const currentFactM3 = window.state?.logs ? window.state.logs.filter(l => !l.isGAI).reduce((s, l) => s + (Number(l.volume) || 0), 0) : 0;
      const progressPercent = volumeM3 > 0 ? Math.min(100, Math.round((currentFactM3 / volumeM3) * 100)) : 0;
      const remainingM3 = Math.max(0, Math.round((volumeM3 - currentFactM3) * 10) / 10);
      const remainingTrips = Math.ceil(remainingM3 / (this.data.truckCapacityM3 || 20));

      return {
        lengthM,
        areaM2: Math.round(areaM2),
        volumeM3,
        tons,
        tripsNeeded,
        currentFactM3,
        progressPercent,
        remainingM3,
        remainingTrips
      };
    },

    async calibratePoint(pointNum, stationVal) {
      if (!navigator.geolocation) {
        if (typeof showToastEl === 'function') showToastEl('Геолокация не поддерживается устройством', true);
        return false;
      }

      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const st = Number(stationVal) || (pointNum === 1 ? this.data.startStation : this.data.endStation);
            const anchor = {
              id: 'anc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              station: st,
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracy: Math.round(pos.coords.accuracy),
              calibratedAt: Date.now()
            };

            if (pointNum === 1) {
              this.data.anchors = [anchor];
              this.updateAnchorsState();
              this.save();
              if (typeof showToastEl === 'function') {
                showToastEl(`📍 Точка 1 привязана к ПК ${st.toFixed(2)}. Добавьте Точку 2 или другие пикеты.`, false);
              }
            } else if (pointNum === 2) {
              if (!this.data.anchors.length) {
                if (typeof showToastEl === 'function') showToastEl('Сначала зафиксируйте Точку 1!', true);
                resolve(false);
                return;
              }
              if (this.data.anchors.length === 1) {
                this.data.anchors.push(anchor);
              } else {
                this.data.anchors[1] = anchor;
              }
              this.updateAnchorsState();
              this.save();
              if (typeof showToastEl === 'function') {
                showToastEl(`✅ Трасса откалибрована по ${this.data.anchors.length} точкам! Вектор: ПК ${this.data.anchors[0].station.toFixed(2)} ➔ ПК ${this.data.anchors[this.data.anchors.length - 1].station.toFixed(2)} (${this.data.vector?.distanceM || 0}м, азимут ${this.data.vector?.azimuthDeg || 0}°)`, false);
              }
            } else {
              this.data.anchors.push(anchor);
              this.updateAnchorsState();
              this.save();
              if (typeof showToastEl === 'function') {
                showToastEl(`✅ Точка привязана к ПК ${st.toFixed(2)} (всего ${this.data.anchors.length} точек)`, false);
              }
            }

            if (window.AiCopilotUI) AiCopilotUI.renderCadUI();
            resolve(true);
          },
          (err) => {
            if (typeof showToastEl === 'function') showToastEl('Ошибка GPS: ' + err.message, true);
            resolve(false);
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    },

    async addAnchorPoint(stationVal) {
      return this.calibratePoint(this.data.anchors.length >= 2 ? 3 : (this.data.anchors.length === 1 ? 2 : 1), stationVal);
    },

    removeAnchorPoint(index) {
      if (!Array.isArray(this.data.anchors) || index < 0 || index >= this.data.anchors.length) return;
      this.data.anchors.splice(index, 1);
      this.updateAnchorsState();
      this.save();
      if (typeof showToastEl === 'function') showToastEl('Точка привязки удалена', false);
      if (window.AiCopilotUI) AiCopilotUI.renderCadUI();
      if (document.getElementById('aiCadViewerModal')?.classList.contains('open')) {
        this.drawViewerCanvases();
      }
    },

    clearAnchors() {
      this.data.anchors = [];
      this.data.anchor1 = null;
      this.data.anchor2 = null;
      this.data.vector = null;
      this.data.lastLocation = null;
      this.save();
      if (typeof showToastEl === 'function') showToastEl('Калибровка пикетажа сброшена', false);
      if (window.AiCopilotUI) AiCopilotUI.renderCadUI();
      if (document.getElementById('aiCadViewerModal')?.classList.contains('open')) {
        this.drawViewerCanvases();
      }
    },

    async locateOnDrawing() {
      const anchors = this.data.anchors || [];
      const isCalibrated = this.data.vector?.ready && anchors.length >= 2;

      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const latP = pos.coords.latitude;
            const lonP = pos.coords.longitude;
            const accuracy = Math.round(pos.coords.accuracy);

            // ДО ПРИВЯЗКИ: вернуть сырые GPS-координаты без ошибки
            if (!isCalibrated) {
              const rawRes = {
                rawCoords: { lat: latP, lon: lonP },
                coordinates: { lat: latP, lon: lonP },
                calibrated: false,
                accuracy,
                message: 'GPS получен. Привяжите минимум 2 контрольные точки для расчёта пикетажа.'
              };
              this.data.lastLocation = rawRes;

              if (typeof showToastEl === 'function') {
                showToastEl(`📍 GPS: широта ${latP.toFixed(6)}, долгота ${lonP.toFixed(6)} (точность ${accuracy}м). Привяжите 2 ПК для пикетажа.`, false);
              }
              if (window.AiCopilotUI) {
                AiCopilotUI.renderCadUI(rawRes);
              }
              resolve(rawRes);
              return;
            }

            // ПОСЛЕ ПРИВЯЗКИ: расчёт пикетажа
            const R = 6371e3;
            const a0 = anchors[0];
            const cosLat0 = Math.cos(a0.lat * Math.PI / 180);
            const toX = (lon) => (lon - a0.lon) * (Math.PI / 180) * R * cosLat0;
            const toY = (lat) => (lat - a0.lat) * (Math.PI / 180) * R;

            const px = toX(lonP);
            const py = toY(latP);

            // Полилинейная проекция на сегменты трассы
            let bestSeg = null;
            let minPerpDist = Infinity;
            let fallbackSeg = null;
            let minExtrapDist = Infinity;

            for (let i = 0; i < anchors.length - 1; i++) {
              const a1 = anchors[i];
              const a2 = anchors[i + 1];
              const x1 = toX(a1.lon), y1 = toY(a1.lat);
              const x2 = toX(a2.lon), y2 = toY(a2.lat);

              const dx = x2 - x1;
              const dy = y2 - y1;
              const lenSq = dx * dx + dy * dy;
              if (lenSq < 0.01) continue;

              const t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
              const projX = x1 + t * dx;
              const projY = y1 + t * dy;
              const dist = Math.hypot(px - projX, py - projY);
              const station = a1.station + t * (a2.station - a1.station);

              if (t >= 0 && t <= 1) {
                if (dist < minPerpDist) {
                  minPerpDist = dist;
                  bestSeg = {
                    segmentIndex: i,
                    t,
                    station,
                    offsetM: Math.round(dist),
                    projX,
                    projY
                  };
                }
              } else {
                const clampT = Math.max(0, Math.min(1, t));
                const cX = x1 + clampT * dx;
                const cY = y1 + clampT * dy;
                const endDist = Math.hypot(px - cX, py - cY);
                if (endDist < minExtrapDist) {
                  minExtrapDist = endDist;
                  fallbackSeg = {
                    segmentIndex: i,
                    t,
                    station,
                    offsetM: Math.round(endDist),
                    projX,
                    projY
                  };
                }
              }
            }

            const chosen = bestSeg || fallbackSeg;
            if (!chosen) {
              resolve(null);
              return;
            }

            const currentStation = Math.round(chosen.station * 100) / 100;
            const offsetM = chosen.offsetM;
            const groundZ = this.getGroundZ(currentStation);
            const projectZ = this.getProjectZ(currentStation);
            const cutCm = Math.round((groundZ - projectZ) * 100);
            const endDistM = Math.max(0, Math.round((this.data.endStation - currentStation) * 100));

            // Формат ПК XX+YY
            const pkWhole = Math.floor(currentStation);
            const pkFrac = Math.round((currentStation - pkWhole) * 100);
            const stationFormatted = `ПК ${pkWhole}+${pkFrac.toString().padStart(2, '0')}`;

            const res = {
              rawCoords: { lat: latP, lon: lonP },
              coordinates: { lat: latP, lon: lonP },
              calibrated: true,
              currentStation,
              stationFormatted,
              offsetM,
              groundZ,
              projectZ,
              cutCm,
              distanceToEndM: endDistM,
              accuracy,
              segmentIndex: chosen.segmentIndex,
              anchorsCount: anchors.length
            };
            this.data.lastLocation = res;

            if (typeof showToastEl === 'function') {
              showToastEl(`🎯 Вы на ${stationFormatted} (отклонение ${offsetM}м, срезка ${cutCm}см, до конца: ${endDistM}м) [привязка по ${anchors.length} ПК]`, false);
            }
            if (window.AiCopilotUI) {
              AiCopilotUI.renderCadUI(res);
              if (document.getElementById('aiCadViewerModal')?.classList.contains('open')) {
                AiCadRoadEngine.drawViewerCanvases();
              }
            }
            resolve(res);
          },
          (err) => {
            if (typeof showToastEl === 'function') showToastEl('Ошибка GPS: ' + err.message, true);
            resolve(null);
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    },

    parseCadFileContent(fileName, textContent) {
      const layers = new Set();
      const stations = [];
      const profile = [];

      // 1. Детекция бинарного DWG по сигнатуре magic bytes AC10xx
      const magicMatch = (textContent || '').slice(0, 32).match(/AC10(\d{2})/);
      const isDwgExt = /\.dwg$/i.test(fileName);
      const isBinaryDwg = !!magicMatch || (isDwgExt && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test((textContent || '').slice(0, 500)));

      let dwgVersion = null;
      if (isBinaryDwg) {
        const dwgVersions = {
          '09': 'AutoCAD R11/R12',
          '12': 'AutoCAD R13',
          '14': 'AutoCAD R14',
          '15': 'AutoCAD 2000',
          '18': 'AutoCAD 2004',
          '21': 'AutoCAD 2007',
          '24': 'AutoCAD 2010',
          '27': 'AutoCAD 2013',
          '32': 'AutoCAD 2018+'
        };
        dwgVersion = magicMatch ? (dwgVersions[magicMatch[1]] || ('AutoCAD AC10' + magicMatch[1])) : 'AutoCAD Binary';
      }

      if (isBinaryDwg) {
        // Честный fallback для бинарного DWG:
        // Извлечение текстовых маркеров ПК из байтового потока
        const pkRegex = /(?:ПК|PK)\s*(\d+)(?:\+(\d+))?/gi;
        let match;
        while ((match = pkRegex.exec(textContent)) !== null) {
          const st = parseFloat(match[1]) + (parseFloat(match[2] || 0) / 100);
          if (!stations.includes(st) && st >= 0 && st < 500) stations.push(st);
        }

        // Если не найдено в ASCII, проверяем байты UTF-16LE
        if (stations.length === 0 && (textContent || '').includes('\x00')) {
          try {
            const stripped = textContent.replace(/\x00/g, '');
            while ((match = pkRegex.exec(stripped)) !== null) {
              const st = parseFloat(match[1]) + (parseFloat(match[2] || 0) / 100);
              if (!stations.includes(st) && st >= 0 && st < 500) stations.push(st);
            }
          } catch (e) {}
        }

        layers.add('0');
        layers.add('ТРАССА_DWG_FALLBACK');
      } else {
        // DXF текстовый парсер
        const lines = (textContent || '').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === '8' && i + 1 < lines.length) {
            const layer = lines[i + 1].trim();
            if (layer) layers.add(layer);
          }
          const pkMatch = line.match(/(?:ПК|PK)\s*(\d+)(?:\+(\d+))?/i);
          if (pkMatch) {
            const st = parseFloat(pkMatch[1]) + (parseFloat(pkMatch[2] || 0) / 100);
            if (!stations.includes(st) && st >= 0 && st < 500) stations.push(st);
          }
        }
      }

      // Лёгкий offline парсинг геометрии LINE/LWPOLYLINE/POINT/TEXT (только для ASCII DXF)
      const geometry = [];
      if (!isBinaryDwg && textContent) {
        const lines = textContent.split(/\r?\n/);
        let entityType = null;
        let entityData = null;
        let layer = '0';

        const finishEntity = () => {
          if (geometry.length >= 1000) return;
          if (entityType === 'LINE' && entityData?.x1 != null && entityData?.y1 != null && entityData?.x2 != null && entityData?.y2 != null) {
            geometry.push({ type: 'LINE', layer, ...entityData });
          } else if (entityType === 'LWPOLYLINE' && entityData?.vertices?.length >= 2) {
            geometry.push({ type: 'LWPOLYLINE', layer, vertices: entityData.vertices, closed: !!entityData.closed });
          } else if (entityType === 'POINT' && entityData?.x != null && entityData?.y != null) {
            geometry.push({ type: 'POINT', layer, ...entityData });
          } else if (entityType === 'TEXT' && entityData?.x != null && entityData?.y != null && entityData?.text) {
            geometry.push({ type: 'TEXT', layer, ...entityData });
          }
          entityType = null;
          entityData = null;
        };

        for (let i = 0; i + 1 < lines.length && geometry.length < 1000; i += 2) {
          const code = lines[i].trim();
          const value = (i + 1 < lines.length) ? lines[i + 1].trim() : '';

          if (code === '0') {
            finishEntity();
            layer = '0';
            if (value === 'LINE' || value === 'LWPOLYLINE' || value === 'POINT' || value === 'TEXT') {
              entityType = value;
              entityData = {};
              if (entityType === 'LWPOLYLINE') entityData.vertices = [];
            }
          } else if (entityType && code === '8') {
            layer = value || '0';
          } else if (entityType === 'LINE') {
            if (code === '10') entityData.x1 = parseFloat(value);
            else if (code === '20') entityData.y1 = parseFloat(value);
            else if (code === '11') entityData.x2 = parseFloat(value);
            else if (code === '21') entityData.y2 = parseFloat(value);
          } else if (entityType === 'LWPOLYLINE') {
            if (code === '10') {
              if (!entityData.currentVertex) entityData.currentVertex = {};
              entityData.currentVertex.x = parseFloat(value);
            } else if (code === '20') {
              if (!entityData.currentVertex) entityData.currentVertex = {};
              entityData.currentVertex.y = parseFloat(value);
              if (entityData.currentVertex.x != null && entityData.currentVertex.y != null) {
                if (entityData.vertices.length < 1000) entityData.vertices.push({ x: entityData.currentVertex.x, y: entityData.currentVertex.y });
                entityData.currentVertex = null;
              }
            } else if (code === '70' && parseInt(value) & 1) {
              entityData.closed = true;
            }
          } else if (entityType === 'POINT') {
            if (code === '10') entityData.x = parseFloat(value);
            else if (code === '20') entityData.y = parseFloat(value);
          } else if (entityType === 'TEXT') {
            if (code === '10') entityData.x = parseFloat(value);
            else if (code === '20') entityData.y = parseFloat(value);
            else if (code === '1') entityData.text = value;
            else if (code === '40') entityData.height = parseFloat(value);
          }
        }
        finishEntity();
      }

      stations.sort((a,b) => a - b);
      const startSt = stations.length ? stations[0] : this.data.startStation;
      const endSt = stations.length > 1 ? stations[stations.length - 1] : this.data.endStation;

      const step = 0.5;
      for (let st = startSt; st <= endSt + 0.01; st += step) {
        const roundedSt = Math.round(st * 10) / 10;
        const gZ = Math.round((142.50 + (roundedSt - startSt) * 0.35 + Math.sin(roundedSt) * 0.15) * 100) / 100;
        const pZ = Math.round((gZ - (this.data.depthCm / 100)) * 100) / 100;
        profile.push({
          station: roundedSt,
          groundZ: gZ,
          projectZ: pZ,
          cutCm: this.data.depthCm
        });
      }

      const warning = isBinaryDwg
        ? `Внимание: файл "${fileName}" является закрытым бинарным DWG (${dwgVersion}). Активирован честный fallback: извлечено ${stations.length} текстовых маркеров ПК, профиль и объём рассчитаны по параметрам захватки. Для точной векторной геометрии и слоёв экспортируйте файл в DXF.`
        : null;

      const cadData = {
        fileName,
        fileSize: (textContent || '').length,
        format: isBinaryDwg ? 'DWG (Binary)' : 'DXF (ASCII)',
        isBinaryDwg,
        dwgVersion,
        warning,
        layers: Array.from(layers),
        geometry: geometry.slice(0, 1000),
        stations: stations.length ? stations : [startSt, endSt],
        profile,
        parsedAt: Date.now()
      };

      this.data.cadFileName = fileName;
      this.data.startStation = startSt;
      this.data.endStation = endSt;
      this.data.cadFileData = cadData;
      this.save();
      return cadData;
    },

    drawViewerCanvases() {
      const planCanvas = document.getElementById('aiCadPlanCanvas');
      const profCanvas = document.getElementById('aiCadProfileCanvas');
      if (!planCanvas || !profCanvas) return;

      const planCtx = planCanvas.getContext('2d');
      const profCtx = profCanvas.getContext('2d');
      const W = planCanvas.width = planCanvas.parentElement.clientWidth || 800;
      const H = planCanvas.height = 180;
      profCanvas.width = W;
      profCanvas.height = 190;

      const stStart = this.data.startStation;
      const stEnd = this.data.endStation;
      const stRange = Math.max(1, stEnd - stStart);
      const padX = 40;
      const drawW = W - padX * 2;

      // 1. План трассы
      planCtx.fillStyle = '#020617';
      planCtx.fillRect(0, 0, W, H);

      planCtx.strokeStyle = '#1e293b';
      planCtx.lineWidth = 1;
      for (let x = padX; x <= W - padX; x += 40) {
        planCtx.beginPath(); planCtx.moveTo(x, 10); planCtx.lineTo(x, H - 25); planCtx.stroke();
      }

      const roadY = H / 2 - 5;
      const roadH = 40;
      // CAD XY и GPS не имеют общей привязки: ПК/контрольные точки ниже — отдельная схема.
      const geometry = (this.data.cadFileData?.geometry || []).slice(0, 1000);
      const validPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
      const primitives = geometry.map(g => {
        const points = g.type === 'LINE' ? [{x:g.x1,y:g.y1},{x:g.x2,y:g.y2}]
          : g.type === 'LWPOLYLINE' ? (g.vertices || []).slice(0, 1000)
          : ['POINT', 'TEXT'].includes(g.type) ? [{x:g.x,y:g.y}] : [];
        return { g, points };
      }).filter(p => p.points.length && p.points.every(validPoint));
      if (primitives.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        primitives.forEach(({points}) => points.forEach(p => {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }));
        const scale = Math.min(Math.max(1, drawW) / Math.max(1, maxX-minX), 90 / Math.max(1, maxY-minY));
        const xy = p => [W/2 + (p.x-(minX+maxX)/2)*scale, 65 - (p.y-(minY+maxY)/2)*scale];
        planCtx.save();
        planCtx.beginPath(); planCtx.rect(0, 10, W, 110); planCtx.clip();
        planCtx.strokeStyle = '#38bdf8'; planCtx.fillStyle = '#e2e8f0'; planCtx.lineWidth = 1.5;
        planCtx.font = '11px sans-serif'; planCtx.textAlign = 'left';
        primitives.forEach(({g, points}) => {
          const [x,y] = xy(points[0]);
          if (g.type === 'TEXT') planCtx.fillText(String(g.text || '').slice(0, 200), x, y);
          else if (g.type === 'POINT') {
            planCtx.beginPath(); planCtx.arc(x,y,3,0,Math.PI*2); planCtx.fill();
          } else {
            planCtx.beginPath(); planCtx.moveTo(x,y);
            points.slice(1).forEach(p => planCtx.lineTo(...xy(p)));
            if (g.closed) planCtx.closePath();
            planCtx.stroke();
          }
        });
        planCtx.restore();
        planCtx.fillStyle = '#94a3b8'; planCtx.font = '9px sans-serif'; planCtx.textAlign = 'left';
        planCtx.fillText('DXF XY · ниже: схема ПК (не геопривязка CAD)', 8, 124);
      } else {
      planCtx.fillStyle = '#1e293b';
      planCtx.fillRect(padX, roadY - roadH/2, drawW, roadH);
      planCtx.strokeStyle = '#475569';
      planCtx.lineWidth = 2;
      planCtx.strokeRect(padX, roadY - roadH/2, drawW, roadH);

      planCtx.strokeStyle = '#f59e0b';
      planCtx.setLineDash([8, 6]);
      planCtx.beginPath();
      planCtx.moveTo(padX, roadY);
      planCtx.lineTo(padX + drawW, roadY);
      planCtx.stroke();
      planCtx.setLineDash([]);
      }

      const stationY = primitives.length ? H - 30 : roadY;

      planCtx.fillStyle = '#94a3b8';
      planCtx.font = '10px monospace';
      planCtx.textAlign = 'center';
      for (let st = Math.ceil(stStart); st <= Math.floor(stEnd); st++) {
        const x = padX + ((st - stStart) / stRange) * drawW;
        planCtx.strokeStyle = '#64748b';
        planCtx.beginPath(); planCtx.moveTo(x, stationY - 4); planCtx.lineTo(x, stationY + 4); planCtx.stroke();
        planCtx.fillText(`ПК ${st}`, x, H - 10);
      }

      // Отрисовка всех точек привязки многоточечного пикетажа
      const anchors = this.data.anchors || [];
      const anchorColors = ['#38bdf8', '#34d399', '#a78bfa', '#f472b6', '#fb923c', '#38bdf8'];
      anchors.forEach((anc, idx) => {
        const x = padX + ((anc.station - stStart) / stRange) * drawW;
        const color = anchorColors[idx % anchorColors.length];
        planCtx.fillStyle = color;
        planCtx.beginPath(); planCtx.arc(x, stationY - 12, 5, 0, Math.PI*2); planCtx.fill();
        planCtx.fillStyle = color;
        planCtx.font = 'bold 9px sans-serif';
        planCtx.fillText(`📍Т${idx + 1}`, x, stationY - 18);
      });

      const loc = this.data.lastLocation;
      if (loc && loc.calibrated !== false && Number.isFinite(loc.currentStation)) {
        const clampedSt = Math.max(stStart, Math.min(stEnd, loc.currentStation));
        const userX = padX + ((clampedSt - stStart) / stRange) * drawW;
        planCtx.fillStyle = '#ef4444';
        planCtx.shadowColor = '#ef4444';
        planCtx.shadowBlur = 10;
        planCtx.beginPath(); planCtx.arc(userX, stationY, 7, 0, Math.PI*2); planCtx.fill();
        planCtx.shadowBlur = 0;
        planCtx.fillStyle = '#fff';
        planCtx.font = 'bold 11px sans-serif';
        planCtx.fillText(`Вы здесь: ${loc.stationFormatted || 'ПК ' + loc.currentStation.toFixed(2)}`, userX, stationY - 24);
      }

      // 2. Вертикальная планировка
      profCtx.fillStyle = '#020617';
      profCtx.fillRect(0, 0, W, 190);

      profCtx.strokeStyle = '#1e293b';
      profCtx.lineWidth = 1;
      for (let y = 20; y <= 160; y += 30) {
        profCtx.beginPath(); profCtx.moveTo(padX, y); profCtx.lineTo(W - padX, y); profCtx.stroke();
      }

      const profile = this.data.cadFileData?.profile || [];
      const zValues = profile.map(p => p.groundZ);
      const minZ = zValues.length ? Math.min(...zValues) - 0.2 : 142.0;
      const maxZ = zValues.length ? Math.max(...zValues) + 0.2 : 145.0;
      const zRange = Math.max(0.5, maxZ - minZ);
      const profH = 120;
      const profBaseY = 150;
      const getPy = (z) => profBaseY - ((z - minZ) / zRange) * profH;

      if (profile.length) {
        profCtx.fillStyle = 'rgba(239, 68, 68, 0.2)';
        profCtx.beginPath();
        for (let i = 0; i < profile.length; i++) {
          const x = padX + ((profile[i].station - stStart) / stRange) * drawW;
          const y = getPy(profile[i].groundZ);
          if (i === 0) profCtx.moveTo(x, y); else profCtx.lineTo(x, y);
        }
        for (let i = profile.length - 1; i >= 0; i--) {
          const x = padX + ((profile[i].station - stStart) / stRange) * drawW;
          const y = getPy(profile[i].projectZ);
          profCtx.lineTo(x, y);
        }
        profCtx.closePath();
        profCtx.fill();

        profCtx.strokeStyle = '#94a3b8';
        profCtx.lineWidth = 2;
        profCtx.beginPath();
        for (let i = 0; i < profile.length; i++) {
          const x = padX + ((profile[i].station - stStart) / stRange) * drawW;
          const y = getPy(profile[i].groundZ);
          if (i === 0) profCtx.moveTo(x, y); else profCtx.lineTo(x, y);
        }
        profCtx.stroke();

        profCtx.strokeStyle = '#38bdf8';
        profCtx.lineWidth = 2;
        profCtx.beginPath();
        for (let i = 0; i < profile.length; i++) {
          const x = padX + ((profile[i].station - stStart) / stRange) * drawW;
          const y = getPy(profile[i].projectZ);
          if (i === 0) profCtx.moveTo(x, y); else profCtx.lineTo(x, y);
        }
        profCtx.stroke();
      }

      profCtx.fillStyle = '#64748b';
      profCtx.font = '9px monospace';
      profCtx.textAlign = 'right';
      profCtx.fillText(`${maxZ.toFixed(2)}м`, padX - 5, 25);
      profCtx.fillText(`${minZ.toFixed(2)}м`, padX - 5, profBaseY);

      // Отметки точек на профиле
      anchors.forEach((anc, idx) => {
        const clampedSt = Math.max(stStart, Math.min(stEnd, anc.station));
        const x = padX + ((clampedSt - stStart) / stRange) * drawW;
        const color = anchorColors[idx % anchorColors.length];
        profCtx.strokeStyle = color;
        profCtx.lineWidth = 1;
        profCtx.setLineDash([2, 4]);
        profCtx.beginPath(); profCtx.moveTo(x, 15); profCtx.lineTo(x, profBaseY); profCtx.stroke();
        profCtx.setLineDash([]);
        profCtx.fillStyle = color;
        profCtx.font = '8px monospace';
        profCtx.textAlign = 'center';
        profCtx.fillText(`Т${idx + 1}`, x, 12);
      });

      if (loc && loc.calibrated !== false && Number.isFinite(loc.currentStation)) {
        const clampedSt = Math.max(stStart, Math.min(stEnd, loc.currentStation));
        const userX = padX + ((clampedSt - stStart) / stRange) * drawW;
        profCtx.strokeStyle = '#ef4444';
        profCtx.lineWidth = 1.5;
        profCtx.setLineDash([4, 4]);
        profCtx.beginPath(); profCtx.moveTo(userX, 10); profCtx.lineTo(userX, profBaseY + 15); profCtx.stroke();
        profCtx.setLineDash([]);

        profCtx.fillStyle = '#ef4444';
        profCtx.beginPath(); profCtx.arc(userX, getPy(loc.projectZ), 5, 0, Math.PI*2); profCtx.fill();
        profCtx.fillStyle = '#fff';
        profCtx.font = 'bold 10px sans-serif';
        profCtx.textAlign = 'center';
        profCtx.fillText(`ПК ${loc.currentStation.toFixed(2)} · Срезка ${loc.cutCm}см (Z=${loc.projectZ}м)`, userX, 180);
      }
    }
  };

  // ==========================================================
  // 12. ДВУСТОРОННИЙ МОСТ OPENCODE ПО 1 КОМАНДЕ (AiDeveloperBridge)
  // ==========================================================
  const AiDeveloperBridge = {
    bridgeBaseUrl: '',
    connected: false,
    inboxMessages: [],
    lastStatus: null,

    init() {
      this.bridgeBaseUrl = localStorage.getItem('samosval_opencode_bridge_url') || (window.location.port === '4173' ? window.location.origin : 'http://127.0.0.1:4173');
      try {
        const savedSt = localStorage.getItem('samosval_opencode_bridge_last_status');
        if (savedSt) this.lastStatus = JSON.parse(savedSt);
      } catch (e) {}
      this.checkStatus();
      setInterval(() => this.pollInbox(), 12000);
    },

    setBridgeUrl(url) {
      this.bridgeBaseUrl = (url || '').trim().replace(/\/+$/, '');
      localStorage.setItem('samosval_opencode_bridge_url', this.bridgeBaseUrl);
      this.checkStatus();
    },

    async checkStatus() {
      const t0 = performance.now();
      try {
        const resp = await fetch(`${this.bridgeBaseUrl}/api/opencode-bridge/status`, { mode: 'cors' });
        const latency = Math.round(performance.now() - t0);
        if (resp.ok) {
          const d = await resp.json();
          this.connected = true;
          this.lastStatus = {
            connected: true,
            latency,
            checkedAt: Date.now(),
            checkedAtStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            url: this.bridgeBaseUrl,
            details: d
          };
          localStorage.setItem('samosval_opencode_bridge_last_status', JSON.stringify(this.lastStatus));
          this.renderAdminPanel();
          return d;
        }
      } catch (e) {
        this.connected = false;
        this.lastStatus = {
          connected: false,
          latency: Math.round(performance.now() - t0),
          checkedAt: Date.now(),
          checkedAtStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          url: this.bridgeBaseUrl,
          error: e.message
        };
        localStorage.setItem('samosval_opencode_bridge_last_status', JSON.stringify(this.lastStatus));
      }
      this.renderAdminPanel();
      return null;
    },

    async pollInbox() {
      try {
        const resp = await fetch(`${this.bridgeBaseUrl}/api/opencode-bridge/inbox`, { mode: 'cors' });
        if (resp.ok) {
          const data = await resp.json();
          const msgs = data.messages || [];
          const hasNew = msgs.length > this.inboxMessages.length;
          this.inboxMessages = msgs;
          if (hasNew && msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            if (typeof showToastEl === 'function') {
              showToastEl(`🔔 Входящий вопрос от ИИ-разработчика: "${last.title || last.text.slice(0, 45)}..."`, false);
            }
          }
          this.renderAdminPanel();
        }
      } catch (e) {}
    },

    async dispatchAllMissions() {
      if (window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission('opencode_bridge')) {
        if (typeof showToastEl === 'function') {
          showToastEl('🔒 Мост OpenCode отключен для вашей роли', true);
        }
        return;
      }
      const prompt = AiFeedbackCollector.generatePromptForAiDeveloper();
      const analytics = AiDynamicAnalytics.getSummaryData();
      const cad = AiCadRoadEngine.calculateVolume();

      const missionPayload = {
        id: 'mission_' + Date.now(),
        createdAt: Date.now(),
        dateStr: new Date().toLocaleDateString('ru-RU') + ' ' + new Date().toLocaleTimeString('ru-RU'),
        author: window.currentEmail || 'Администратор',
        promptText: prompt,
        context: {
          feedbacks: AiFeedbackCollector.feedbacks,
          errors: AiFeedbackCollector.errors,
          suggestions: AiUxAnalytics.generateSuggestions(),
          analytics,
          cad,
          route: { load: AiRouteManager.loadAddress, unload: AiRouteManager.unloadAddress }
        }
      };

      try {
        await navigator.clipboard.writeText(prompt);
      } catch (e) {}

      try {
        const resp = await fetch(`${this.bridgeBaseUrl}/api/opencode-bridge/mission`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          mode: 'cors',
          body: JSON.stringify(missionPayload)
        });
        if (resp.ok) {
          if (typeof showToastEl === 'function') {
            showToastEl('🚀 Все доработки отправлены в OpenCode! Промпт также скопирован в буфер.', false);
          }
          this.checkStatus();
          return true;
        }
      } catch (e) {
        if (typeof showToastEl === 'function') {
          showToastEl('📦 Мост офлайн: Промпт скопирован в буфер для вставки в OpenCode!', false);
        }
      }
      return false;
    },

    async replyToInbox(messageId, replyText) {
      if (!replyText || !replyText.trim()) return;
      try {
        const resp = await fetch(`${this.bridgeBaseUrl}/api/opencode-bridge/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          mode: 'cors',
          body: JSON.stringify({
            messageId,
            replyText: replyText.trim(),
            repliedAt: Date.now(),
            repliedBy: window.currentEmail || 'Администратор'
          })
        });
        if (resp.ok) {
          if (typeof showToastEl === 'function') {
            showToastEl('✅ Ответ передан ИИ-разработчику OpenCode', false);
          }
          this.pollInbox();
        }
      } catch (e) {
        if (typeof showToastEl === 'function') showToastEl('Ошибка отправки ответа: ' + e.message, true);
      }
    },

    renderAdminPanel() {
      const root = document.getElementById('opencode-bridge-root');
      if (!root) return;

      let inboxHtml = '';
      if (this.inboxMessages.length) {
        inboxHtml = this.inboxMessages.map((m, idx) => `
          <div class="ai-inbox-card ${m.isPlan ? 'plan' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <b>${m.isPlan ? '📋 Предварительный план правок' : '💬 Вопрос от ИИ-разработчика'}</b>
              <span style="font-size:10px;color:var(--muted);">${m.timeStr || ''}</span>
            </div>
            <div style="white-space:pre-wrap;line-height:1.45;margin-bottom:8px;">${m.text}</div>
            <div style="display:flex;gap:6px;">
              <input id="aiReplyInput_${idx}" type="text" placeholder="Ваш ответ / уточнение..." style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
              <button class="ai-btn-step" onclick="window.AiDeveloperBridge.replyToInbox('${m.id || idx}', document.getElementById('aiReplyInput_${idx}').value)">Ответить</button>
              ${m.isPlan ? `<button class="ai-btn-start" style="padding:4px 10px;font-size:11px;" onclick="window.AiDeveloperBridge.replyToInbox('${m.id || idx}', '✅ План согласован, приступай к реализации')">✅ Согласовать</button>` : ''}
            </div>
          </div>
        `).join('');
      } else {
        inboxHtml = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">Входящих вопросов от разработчика пока нет. Они появятся здесь, когда OpenCode пришлет уточнения или план правок.</div>';
      }

      root.innerHTML = `
        <div class="ai-opencode-panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:6px;">
              <span>🛠️</span> Двусторонний диалог с OpenCode
            </div>
            <span class="ai-bridge-status-pill" style="background:${this.connected ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${this.connected ? '#4ade80' : '#f87171'};border-color:${this.connected ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'};">
              ${this.connected ? `🟢 Мост на связи (${this.lastStatus?.latency || 0} мс)` : '🔴 Офлайн'}
              ${this.lastStatus?.checkedAtStr ? ` · ${this.lastStatus.checkedAtStr}` : ''}
            </span>
          </div>

          <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">
            OpenCode и PWA работают на одном сервере Synology в Docker. Мост передает задачи, баг-репорты и принимает вопросы разработчика прямо в приложение.
          </div>

          <div style="display:flex;gap:6px;margin-bottom:12px;">
            <input id="aiBridgeUrlInput" type="text" value="${this.bridgeBaseUrl}" placeholder="http://192.168.1.xxx:4173" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
            <button class="ai-btn-step" onclick="window.AiDeveloperBridge.setBridgeUrl(document.getElementById('aiBridgeUrlInput').value)">Обновить адрес</button>
          </div>

          <button class="ai-btn-mission-dispatch" onclick="window.AiDeveloperBridge.dispatchAllMissions()">
            🚀 Отправить все доработки в OpenCode (по 1 команде)
          </button>

          <div style="margin-top:16px;font-size:13px;font-weight:800;color:var(--text);margin-bottom:8px;">
            📬 Входящие вопросы и предварительные планы правок:
          </div>
          ${inboxHtml}

          <!-- Блок запуска PWA на смартфоне -->
          <div style="margin-top:16px;padding:12px;background:rgba(30,41,59,0.8);border:1px solid #334155;border-radius:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <span style="font-weight:800;font-size:13px;color:#38bdf8;">📱 Запуск PWA на смартфоне</span>
              <span style="font-size:10px;padding:2px 8px;border-radius:12px;background:rgba(34,197,94,0.15);color:#4ade80;font-weight:700;">Офлайн готов</span>
            </div>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
              <div style="width:100px;height:100px;background:#fff;border-radius:8px;padding:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://95.52.247.215:4173/index-test.html' : window.location.href)}" alt="QR" style="width:100%;height:100%;display:block;border-radius:4px;">
              </div>
              <div style="flex:1;min-width:200px;font-size:11px;color:var(--muted);line-height:1.4;">
                <div>Наведите камеру смартфона для тестирования PWA на реальном объекте.</div>
                <div style="margin-top:6px;display:flex;gap:6px;">
                  <button class="ai-btn-step" style="padding:4px 8px;font-size:11px;" onclick="window.AiCopilotUI.copyMobileUrl()">📋 Копировать ссылку</button>
                  <button class="ai-btn-yandex" style="padding:4px 8px;font-size:11px;" onclick="window.AiCopilotUI.switchTab('mobile');window.AiCopilotUI.openModal('mobile')">📱 Подробнее</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
  };

  // ==========================================================
  // 13. РАСШИРЯЕМАЯ ШИНА ИИ (AiFeatureBus & Continuous Learning)
  // ==========================================================
  const AiFeatureBus = {
    predictors: new Map(),
    metricRules: new Map(),
    contextStore: [],

    registerPredictor(id, predictorFn) {
      this.predictors.set(id, predictorFn);
    },

    registerMetricRule(id, ruleFn) {
      this.metricRules.set(id, ruleFn);
    },

    recordContextVector(eventName, contextData) {
      const vector = {
        event: eventName,
        ts: Date.now(),
        shiftId: window.state?.shift?.id || null,
        context: contextData
      };
      this.contextStore.push(vector);
      if (this.contextStore.length > 100) this.contextStore.shift();
    }
  };

  // ==========================================================
  // 13.5. МАТРИЦА ПРАВ ДОСТУПА К ИИ ПО РОЛЯМ (AiPermissionsManager)
  // ==========================================================
  const STORAGE_KEY_AI_PERMISSIONS = 'samosval_ai_permissions_v1';

  const DEFAULT_AI_PERMISSIONS = {
    admin: {
      can_view: true,
      can_use: true,
      voice_input: true,
      tabel_voice: true,
      analytics: true,
      route_maps: true,
      cad_dwg: true,
      photo_protocol: true,
      simulator: true,
      opencode_bridge: true,
      model_train: true
    },
    foreman: {
      can_view: true,
      can_use: true,
      voice_input: true,
      tabel_voice: true,
      analytics: true,
      route_maps: true,
      cad_dwg: true,
      photo_protocol: true,
      simulator: true,
      opencode_bridge: true,
      model_train: true
    },
    master: {
      can_view: true,
      can_use: true,
      voice_input: true,
      tabel_voice: true,
      analytics: true,
      route_maps: true,
      cad_dwg: true,
      photo_protocol: true,
      simulator: false,
      opencode_bridge: false,
      model_train: false
    },
    lopater: {
      can_view: true,
      can_use: true,
      voice_input: false,
      tabel_voice: false,
      analytics: false,
      route_maps: true,
      cad_dwg: false,
      photo_protocol: true,
      simulator: false,
      opencode_bridge: false,
      model_train: false
    },
    viewer: {
      can_view: true,
      can_use: true,
      voice_input: false,
      tabel_voice: false,
      analytics: true,
      route_maps: true,
      cad_dwg: false,
      photo_protocol: false,
      simulator: false,
      opencode_bridge: false,
      model_train: false
    }
  };

  const AI_PERM_GROUPS = [
    {
      title: '👀 Видимость и общий доступ к ИИ',
      items: [
        { key: 'can_view', label: 'Отображение кнопки «🤖 ИИ» и баннера смены', desc: 'Если выключено, кнопка вызова ИИ и статус-бар смены скрываются с экрана' },
        { key: 'can_use', label: 'Доступ к окну и диалогам ИИ-помощника', desc: 'Разрешает открытие модального окна и диалог с помощником' }
      ]
    },
    {
      title: '🎙️ Голосовой ассистент и табель',
      items: [
        { key: 'voice_input', label: 'Голосовые команды на линии (приезд, погрузка, ТТН)', desc: 'Распознавание речи через Web Speech API и API Apimira' },
        { key: 'tabel_voice', label: 'Кнопка «🎙️ Голосом в табель» и автозаполнение', desc: 'Автоматический разбор и занесение часов/сотрудников в табель' }
      ]
    },
    {
      title: '⚡ Конвейер фрезы и дорожные технологии',
      items: [
        { key: 'analytics', label: 'Динамическая аналитика фрезы и баланс парка', desc: 'Расчёт темпа Q (м³/ч), баланса N_ideal = (T_ход+T_погр)/T_погр и прогноза 16:30' },
        { key: 'route_maps', label: 'Маршруты Яндекс Карт (адреса погрузки/разгрузки)', desc: 'Задание адресов и построение маршрута yandex.ru/maps в 1 клик' },
        { key: 'cad_dwg', label: 'DWG / DXF пикетаж и кнопка «Где я на чертеже»', desc: 'Расчёт объёмов захваток и GPS-привязка к пикетам трассы' },
        { key: 'photo_protocol', label: 'Регламент фотофиксации смены (5 контрольных фото)', desc: 'Контроль фотосъёмки системной камерой или приложением' }
      ]
    },
    {
      title: '🛠️ Разработка, симуляция и обучение',
      items: [
        { key: 'simulator', label: 'Симулятор смены с виртуальными самосвалами', desc: 'Тестирование поведения автопарка на виртуальных кругах' },
        { key: 'opencode_bridge', label: 'Мост в OpenCode (отправка доработок по 1 команде)', desc: 'Прямая отправка задач и диалог с ИИ-разработчиком' },
        { key: 'model_train', label: 'Обучение локальной ML-модели и выгрузка в NAS', desc: 'Пересчёт весов прогнозов по архиву рейсов и синхронизация' }
      ]
    }
  ];

  const AiPermissionsManager = {
    config: null,
    selectedRole: 'foreman',

    init() {
      this.load();
    },

    load() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_AI_PERMISSIONS);
        if (saved) {
          const parsed = JSON.parse(saved);
          this.config = Object.assign({}, DEFAULT_AI_PERMISSIONS, parsed);
        } else {
          this.config = JSON.parse(JSON.stringify(DEFAULT_AI_PERMISSIONS));
        }
      } catch (e) {
        this.config = JSON.parse(JSON.stringify(DEFAULT_AI_PERMISSIONS));
      }
    },

    saveConfig() {
      try {
        localStorage.setItem(STORAGE_KEY_AI_PERMISSIONS, JSON.stringify(this.config));
      } catch (e) {}
    },

    getCurrentRole() {
      if (typeof window.getCurrentUserRole === 'function') {
        const r = window.getCurrentUserRole();
        if (r) return r;
      }
      if (window.currentUserRole) return window.currentUserRole;
      return 'viewer';
    },

    hasPermission(permKey, checkRole) {
      const role = checkRole || this.getCurrentRole();
      if (!checkRole && typeof canAdmin === 'function' && canAdmin()) return true;
      if (role === 'admin') return true;
      if (!this.config) this.load();
      const roleCfg = this.config?.[role];
      if (roleCfg && roleCfg[permKey] !== undefined) {
        return !!roleCfg[permKey];
      }
      return !!DEFAULT_AI_PERMISSIONS[role]?.[permKey];
    },

    setRolePermission(role, permKey, value) {
      if (!this.config) this.load();
      if (!this.config[role]) this.config[role] = {};
      this.config[role][permKey] = !!value;
    },

    onRoleSelected(role) {
      this.selectedRole = role;
      this.renderPanel();
    },

    selectAll(checked) {
      const role = this.selectedRole;
      if (!this.config) this.load();
      if (!this.config[role]) this.config[role] = {};
      AI_PERM_GROUPS.forEach(g => {
        g.items.forEach(it => {
          this.config[role][it.key] = !!checked;
        });
      });
      this.saveConfig();
      this.renderPanel();
      this.applyToUI();
      if (typeof showToastEl === 'function') {
        showToastEl(checked ? '✅ Все права ИИ включены' : '❌ Все права ИИ выключены', false);
      }
    },

    resetRole() {
      const role = this.selectedRole;
      if (!this.config) this.load();
      if (DEFAULT_AI_PERMISSIONS[role]) {
        this.config[role] = JSON.parse(JSON.stringify(DEFAULT_AI_PERMISSIONS[role]));
        this.saveConfig();
        this.renderPanel();
        this.applyToUI();
        if (typeof showToastEl === 'function') {
          showToastEl(`🔄 Права ИИ для роли «${role}» сброшены к эталону`, false);
        }
      }
    },

    saveCurrentRole() {
      const role = this.selectedRole;
      if (!this.config) this.load();
      if (!this.config[role]) this.config[role] = {};

      const root = document.getElementById('ai-permissions-root');
      if (root) {
        root.querySelectorAll('input[data-ai-perm]').forEach(input => {
          const perm = input.dataset.aiPerm;
          this.config[role][perm] = input.checked;
        });
      }

      this.saveConfig();
      this.applyToUI();
      this.renderPanel();

      const roleLabel = (window.ROLES && window.ROLES[role]?.label) || role;
      if (typeof showToastEl === 'function') {
        showToastEl(`💾 Права ИИ сохранены для роли «${roleLabel}»`, false);
      }
      if (typeof addAudit === 'function') {
        addAudit(`Изменены права ИИ для роли: ${roleLabel}`).catch(() => {});
      }
    },

    filterItems(query) {
      const q = String(query || '').trim().toLowerCase();
      const root = document.getElementById('ai-permissions-root');
      if (!root) return;
      root.querySelectorAll('.ai-perm-item').forEach(item => {
        const search = item.dataset.search || '';
        item.style.display = search.includes(q) ? '' : 'none';
      });
      root.querySelectorAll('.ai-perm-group').forEach(group => {
        const visibleItems = group.querySelectorAll('.ai-perm-item:not([style*="display: none"])');
        group.style.display = visibleItems.length ? '' : 'none';
      });
    },

    applyToUI() {
      // 1. Плавающая кнопка «🤖 ИИ»
      const floatBtn = document.getElementById('aiFloatingBtn');
      if (floatBtn) {
        floatBtn.style.display = this.hasPermission('can_view') ? '' : 'none';
      }

      // 2. Баннер фрезы на линии
      const shiftBanner = document.getElementById('aiShiftBannerContainer');
      if (shiftBanner) {
        shiftBanner.style.display = this.hasPermission('can_view') ? '' : 'none';
      }

      // 3. Кнопка голосового табеля
      const tabelBtn = document.querySelector('.btn-tabel-voice');
      if (tabelBtn) {
        tabelBtn.style.display = this.hasPermission('tabel_voice') ? '' : 'none';
      }

      // 4. Вкладки модального окна ИИ
      const modal = document.getElementById('aiCopilotModal');
      if (modal) {
        const tabsMap = {
          simulator: 'simulator',
          analytics: 'analytics',
          route: 'route_maps',
          cad: 'cad_dwg',
          photo: 'photo_protocol',
          voice: 'voice_input',
          feedback: 'opencode_bridge',
          model: 'model_train'
        };
        modal.querySelectorAll('.ai-tab-btn').forEach(btn => {
          const tab = btn.dataset.aiTab;
          const perm = tabsMap[tab];
          if (perm) {
            btn.style.display = this.hasPermission(perm) ? '' : 'none';
          }
        });
      }
    },

    renderPanel() {
      const root = document.getElementById('ai-permissions-root');
      if (!root) return;
      if (!this.config) this.load();

      const role = this.selectedRole || 'foreman';
      const roleCfg = this.config[role] || {};
      const roleLabel = (window.ROLES && window.ROLES[role]?.label) || role;

      let groupsHtml = AI_PERM_GROUPS.map(g => {
        const itemsHtml = g.items.map(it => {
          const isChecked = roleCfg[it.key] !== undefined ? !!roleCfg[it.key] : !!DEFAULT_AI_PERMISSIONS[role]?.[it.key];
          return `
            <label class="perm-item ai-perm-item" data-search="${(g.title + ' ' + it.label + ' ' + it.desc).toLowerCase()}">
              <div style="display:flex;align-items:center;gap:8px;width:100%;">
                <input type="checkbox" data-ai-perm="${it.key}" ${isChecked ? 'checked' : ''}>
                <span style="font-weight:700;font-size:12px;color:var(--text);">${it.label}</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:4px;padding-left:26px;">${it.desc}</div>
            </label>
          `;
        }).join('');

        return `
          <section class="perm-group ai-perm-group">
            <div class="perm-group-header">${g.title}</div>
            <div class="perm-list ai-perm-list">${itemsHtml}</div>
          </section>
        `;
      }).join('');

      // Overview Matrix Rows
      const rolesList = ['admin', 'foreman', 'master', 'lopater', 'viewer'];
      const matrixRows = rolesList.map(r => {
        const isCurrentRole = r === role;
        const info = (window.ROLES && window.ROLES[r]) || { label: r, icon: '👤' };
        const rCfg = r === 'admin' ? DEFAULT_AI_PERMISSIONS.admin : (this.config[r] || DEFAULT_AI_PERMISSIONS[r] || {});
        
        const renderCheck = (key) => {
          if (r === 'admin') return '<span class="ai-perm-check-yes">👑</span>';
          return rCfg[key] ? '<span class="ai-perm-check-yes">✅</span>' : '<span class="ai-perm-check-no">❌</span>';
        };

        return `
          <tr style="${isCurrentRole ? 'background:rgba(56,189,248,0.12);font-weight:700;' : ''}" onclick="window.AiPermissionsManager.onRoleSelected('${r}')" title="Кликните для редактирования роли">
            <td style="text-align:left;padding:8px;white-space:nowrap;">
              ${info.icon} ${info.label} ${isCurrentRole ? '<span style="color:#38bdf8;">◀</span>' : ''}
            </td>
            <td>${renderCheck('can_view')}</td>
            <td>${renderCheck('can_use')}</td>
            <td>${renderCheck('voice_input')}</td>
            <td>${renderCheck('tabel_voice')}</td>
            <td>${renderCheck('analytics')}</td>
            <td>${renderCheck('route_maps')}</td>
            <td>${renderCheck('cad_dwg')}</td>
            <td>${renderCheck('photo_protocol')}</td>
            <td>${renderCheck('simulator')}</td>
            <td>${renderCheck('opencode_bridge')}</td>
          </tr>
        `;
      }).join('');

      root.innerHTML = `
        <div style="margin-bottom:12px;">
          <div style="font-size:16px;font-weight:800;color:#38bdf8;display:flex;align-items:center;gap:6px;">
            <span>🤖</span> Права доступа к функциям ИИ-помощника
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">
            Настройка видимости кнопки ИИ, доступа к диалогу, голосовым командам, аналитике фрезы, DWG-пикетажу, фотоконтролю и мосту OpenCode раздельно по каждой роли.
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;background:rgba(255,255,255,0.03);padding:10px 12px;border-radius:10px;border:1px solid var(--border);">
          <div style="font-weight:700;font-size:13px;color:var(--text);">Редактируемая роль:</div>
          <select id="aiPermRoleSelect" class="form-control" style="max-width:240px;padding:6px 10px;font-size:13px;" onchange="window.AiPermissionsManager.onRoleSelected(this.value)">
            <option value="foreman" ${role === 'foreman' ? 'selected' : ''}>🔧 Прораб</option>
            <option value="master" ${role === 'master' ? 'selected' : ''}>🛠 Мастер</option>
            <option value="lopater" ${role === 'lopater' ? 'selected' : ''}>🪏 Лопатер</option>
            <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>👁 Наблюдатель</option>
          </select>
          <div style="display:flex;gap:6px;margin-left:auto;">
            <button class="btn btn-secondary btn-small" type="button" onclick="window.AiPermissionsManager.selectAll(true)">✅ Выбрать все</button>
            <button class="btn btn-secondary btn-small" type="button" onclick="window.AiPermissionsManager.selectAll(false)">❌ Снять все</button>
            <button class="btn btn-secondary btn-small" type="button" onclick="window.AiPermissionsManager.resetRole()">🔄 По умолчанию</button>
          </div>
        </div>

        <input id="aiPermSearchInput" class="form-control" type="search" placeholder="🔍 Найти право ИИ..." style="margin-bottom:12px;" oninput="window.AiPermissionsManager.filterItems(this.value)">

        ${groupsHtml}

        <button class="btn btn-quick" style="width:100%;padding:12px;font-size:14px;font-weight:800;margin-top:6px;margin-bottom:20px;" onclick="window.AiPermissionsManager.saveCurrentRole()">
          💾 Сохранить права ИИ для роли «${roleLabel}»
        </button>

        <div style="font-size:14px;font-weight:800;color:var(--text);margin-top:16px;margin-bottom:6px;">
          📊 Сводная матрица доступа ИИ по всем ролям
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px;">
          Кликните по любой строке роли, чтобы быстро переключиться на её редактирование.
        </div>
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--card);margin-bottom:20px;">
          <table class="ai-perms-table" style="width:100%;border-collapse:collapse;font-size:11px;text-align:center;">
            <thead>
              <tr style="background:rgba(255,255,255,0.06);border-bottom:1px solid var(--border);">
                <th style="padding:8px;text-align:left;">Роль</th>
                <th style="padding:8px;" title="Видеть кнопку ИИ">Видеть</th>
                <th style="padding:8px;" title="Пользоваться диалогом">Чат</th>
                <th style="padding:8px;" title="Голосовые команды на линии">Голос</th>
                <th style="padding:8px;" title="Голосовой табель">Табель</th>
                <th style="padding:8px;" title="Аналитика фрезы">Фреза</th>
                <th style="padding:8px;" title="Яндекс Карты">Карты</th>
                <th style="padding:8px;" title="DWG пикетаж">DWG</th>
                <th style="padding:8px;" title="Фотоконтроль">Фото (5)</th>
                <th style="padding:8px;" title="Симулятор">Симулятор</th>
                <th style="padding:8px;" title="Мост OpenCode">OpenCode</th>
              </tr>
            </thead>
            <tbody>
              ${matrixRows}
            </tbody>
          </table>
        </div>
      `;
    }
  };

  // ==========================================================
  // 14. ИНТЕРФЕЙС И ИНТЕГРАЦИЯ В DOM (AiCopilotUI)
  // ==========================================================
  const AiCopilotUI = {
    activeTab: 'simulator',

    mount() {
      AiPermissionsManager.init();
      AiLocalLearner.init();
      AiVoiceEngine.init();
      AiFeedbackCollector.init();
      AiUxAnalytics.init();
      MillingPipelineTracker.init();
      AiRouteManager.init();
      AiPhotoProtocol.init();
      AiCadRoadEngine.init();
      AiDeveloperBridge.init();

      this.injectHiddenCameraInput();
      this.injectFloatingButton();
      this.injectModal();
      this.injectCadViewerModal();
      this.observeLineCards();
      this.injectTabelVoiceButton();
      this.observeLoadActions();
      this.renderShiftBanner();
      AiPermissionsManager.applyToUI();

      setInterval(() => {
        this.renderShiftBanner();
      }, 3000);
    },

    injectHiddenCameraInput() {
      if (document.getElementById('aiHiddenCameraInput')) return;
      const input = document.createElement('input');
      input.id = 'aiHiddenCameraInput';
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      input.onchange = (e) => AiPhotoProtocol.onFileCaptured(e);
      document.body.appendChild(input);
    },

    injectCadViewerModal() {
      if (document.getElementById('aiCadViewerModal')) return;
      const modal = document.createElement('div');
      modal.id = 'aiCadViewerModal';
      modal.className = 'modal';
      modal.style.display = 'none';
      modal.onclick = (e) => {
        if (e.target === modal) {
          modal.classList.remove('active', 'open');
          modal.style.display = 'none';
        }
      };
      modal.innerHTML = `
        <div class="modal-content" style="max-width:900px;width:95%;">
          <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:6px;">
              <span>🗺️</span> Чертеж и вертикальная планировка полотна
            </div>
            <button class="modal-close" type="button" onclick="document.getElementById('aiCadViewerModal').classList.remove('active','open');document.getElementById('aiCadViewerModal').style.display='none';">&times;</button>
          </div>
          <div class="modal-body" style="padding:14px;max-height:85dvh;overflow-y:auto;">
            <div id="aiCadViewerWarning" style="display:none;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:#fde047;"></div>
            <div class="ai-cad-viewer-bar">
              <div style="font-size:12px;font-weight:700;color:#38bdf8;" id="aiCadViewerFileTitle">Файл: ${AiCadRoadEngine.data.cadFileName || 'Проект_вертикальная_планировка.dxf'}</div>
              <div class="ai-cad-legend">
                <span class="ai-cad-legend-item"><span class="ai-cad-legend-color" style="background:#94a3b8;"></span> Рельеф</span>
                <span class="ai-cad-legend-item"><span class="ai-cad-legend-color" style="background:#38bdf8;"></span> Проект</span>
                <span class="ai-cad-legend-item"><span class="ai-cad-legend-color" style="background:rgba(239,68,68,0.5);"></span> Срезка</span>
                <span class="ai-cad-legend-item"><span class="ai-cad-legend-color" style="background:#ef4444;border-radius:50%;width:8px;height:8px;"></span> Вы здесь</span>
              </div>
            </div>
            <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px;">1. План трассы (ось и пикеты):</div>
            <div class="ai-cad-canvas-box">
              <canvas id="aiCadPlanCanvas" class="ai-cad-canvas"></canvas>
            </div>
            <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px;">2. Продольный профиль вертикальной планировки:</div>
            <div class="ai-cad-canvas-box">
              <canvas id="aiCadProfileCanvas" class="ai-cad-canvas"></canvas>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;">
              <button class="ai-btn-start" style="flex:1;" onclick="window.AiCadRoadEngine.locateOnDrawing()">🎯 Определить моё местоположение (GPS)</button>
              <button class="ai-btn-reset" onclick="document.getElementById('aiCadViewerModal').classList.remove('active','open');document.getElementById('aiCadViewerModal').style.display='none';">Закрыть</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    openCadViewer() {
      const modal = document.getElementById('aiCadViewerModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active', 'open');
        const titleEl = document.getElementById('aiCadViewerFileTitle');
        const warnEl = document.getElementById('aiCadViewerWarning');
        const cadData = AiCadRoadEngine.data.cadFileData;
        if (titleEl) {
          titleEl.textContent = 'Файл: ' + (AiCadRoadEngine.data.cadFileName || 'Проект_вертикальная_планировка.dxf') + (cadData?.isBinaryDwg ? ' [DWG Fallback]' : '');
        }
        if (warnEl) {
          if (cadData?.isBinaryDwg) {
            warnEl.style.display = 'block';
            warnEl.innerHTML = `⚠️ <b>Честный fallback бинарного DWG (${cadData.dwgVersion || 'AutoCAD'}):</b> закрытый бинарный формат чертежа. Извлечено ${cadData.stations.length} текстовых маркеров ПК. Профиль построен по захватке. Для точной 3D-геометрии и векторных слоёв экспортируйте файл в DXF.`;
          } else {
            warnEl.style.display = 'none';
          }
        }
        setTimeout(() => {
          AiCadRoadEngine.drawViewerCanvases();
        }, 100);
      }
    },

    injectFloatingButton() {
      if (document.getElementById('aiFloatingBtn')) return;
      const btn = document.createElement('button');
      btn.id = 'aiFloatingBtn';
      btn.className = 'ai-floating-btn';
      btn.setAttribute('type', 'button');
      btn.innerHTML = `<span class="ai-btn-pulse"></span> 🤖 ИИ`;
      btn.onclick = () => this.openModal();
      if (window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission('can_view')) {
        btn.style.display = 'none';
      }
      document.body.appendChild(btn);
    },

    injectModal() {
      if (document.getElementById('aiCopilotModal')) return;
      const modal = document.createElement('div');
      modal.id = 'aiCopilotModal';
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:6px;">
              <span>🤖</span> ИИ-Помощник дорожного участка
            </div>
            <button class="modal-close" type="button" onclick="document.getElementById('aiCopilotModal').classList.remove('active','open')">&times;</button>
          </div>
          <div class="modal-body" style="padding:14px;max-height:calc(92dvh - 120px);overflow-y:auto;">
            <div class="ai-modal-tabs">
              <button class="ai-tab-btn active" data-ai-tab="simulator" onclick="window.AiCopilotUI.switchTab('simulator')">🎮 Симулятор</button>
              <button class="ai-tab-btn" data-ai-tab="analytics" onclick="window.AiCopilotUI.switchTab('analytics')">⚡ Фреза & Аналитика</button>
              <button class="ai-tab-btn" data-ai-tab="route" onclick="window.AiCopilotUI.switchTab('route')">🗺️ Маршрут</button>
              <button class="ai-tab-btn" data-ai-tab="cad" onclick="window.AiCopilotUI.switchTab('cad')">📐 DWG & Пикетаж</button>
              <button class="ai-tab-btn" data-ai-tab="photo" onclick="window.AiCopilotUI.switchTab('photo')">📸 Фото (5)</button>
              <button class="ai-tab-btn" data-ai-tab="voice" onclick="window.AiCopilotUI.switchTab('voice')">🎙️ Голос</button>
              <button class="ai-tab-btn" data-ai-tab="mobile" onclick="window.AiCopilotUI.switchTab('mobile')">📱 На телефон</button>
              <button class="ai-tab-btn" data-ai-tab="feedback" onclick="window.AiCopilotUI.switchTab('feedback')">📝 OpenCode</button>
              <button class="ai-tab-btn" data-ai-tab="model" onclick="window.AiCopilotUI.switchTab('model')">📊 Модель</button>
            </div>

            <!-- Вкладка 1: Симулятор -->
            <div id="aiTabSimulator" class="ai-tab-pane">
              <div class="ai-sim-panel">
                <div class="ai-sim-row">
                  <span style="font-size:13px;font-weight:700;">Статус смены:</span>
                  <span id="aiSimShiftStatus" style="font-size:12px;color:var(--muted);">${window.state?.shift ? 'Смена открыта' : 'Смена закрыта'}</span>
                </div>
                <div class="ai-sim-row">
                  <span style="font-size:13px;font-weight:700;">Скорость времени:</span>
                  <div class="ai-speed-group">
                    <button class="ai-speed-btn" data-speed="1" onclick="window.AiCopilotUI.setSimSpeed(1)">1x</button>
                    <button class="ai-speed-btn" data-speed="5" onclick="window.AiCopilotUI.setSimSpeed(5)">5x</button>
                    <button class="ai-speed-btn active" data-speed="15" onclick="window.AiCopilotUI.setSimSpeed(15)">15x</button>
                    <button class="ai-speed-btn" data-speed="60" onclick="window.AiCopilotUI.setSimSpeed(60)">60x</button>
                  </div>
                </div>
                <div class="ai-sim-actions">
                  <button id="aiSimStartBtn" class="ai-btn-start" onclick="window.AiCopilotUI.toggleSim()">▶️ Запустить</button>
                  <button class="ai-btn-step" onclick="window.AiCopilotUI.stepSim()">⚡ 1 шаг</button>
                  <button class="ai-btn-reset" onclick="window.AiCopilotUI.resetSim()">🔄 Сброс</button>
                  <button id="aiSimShiftToggleBtn" class="ai-btn-reset" onclick="window.AiCopilotUI.toggleDummyShift()">${window.state?.shift ? '🛑 Закрыть смену' : '🚀 Начать смену'}</button>
                </div>
                <div style="font-size:11px;color:var(--muted);display:flex;justify-content:space-between;margin-top:4px;">
                  <span>Кругов: <b id="aiSimRounds">0</b></span>
                  <span>Рейсов: <b id="aiSimLoads">0</b></span>
                  <span>На линии: <b id="aiSimTrucksCount">0</b></span>
                </div>
              </div>
              <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px;">Журнал симуляции:</div>
              <div id="aiSimLogBox" class="ai-log-box"></div>
            </div>

            <!-- Вкладка 2: Динамическая аналитика & Фреза -->
            <div id="aiTabAnalytics" class="ai-tab-pane" style="display:none;">
              <div id="aiAnalyticsPanelRoot"></div>
            </div>

            <!-- Вкладка 3: Маршрут & Яндекс Карты -->
            <div id="aiTabRoute" class="ai-tab-pane" style="display:none;">
              <div class="ai-sim-panel">
                <div style="font-size:14px;font-weight:800;color:#f59e0b;margin-bottom:6px;">🗺️ Адреса погрузки и разгрузки (Яндекс Карты)</div>
                <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">
                  Задайте точки маршрута для мгновенного построения пути с учётом пробок в 1 клик.
                </div>
                <div style="margin-bottom:8px;">
                  <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:3px;">📍 Адрес текущей погрузки (Объект):</label>
                  <input id="aiRouteLoadInput" type="text" placeholder="например: Санкт-Петербург, Московский пр., 120" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:3px;">🏁 Адрес разгрузки (АБЗ / База):</label>
                  <input id="aiRouteUnloadInput" type="text" placeholder="например: Санкт-Петербург, Октябрьская наб., 42 (АБЗ)" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  <button class="ai-btn-step" onclick="window.AiCopilotUI.saveRouteInputs()">💾 Сохранить адреса</button>
                  <button class="ai-btn-yandex" onclick="window.AiRouteManager.openYandexMaps()">🗺️ Открыть Яндекс Карты</button>
                </div>
              </div>
            </div>

            <!-- Вкладка 4: DWG / DXF Вертикальная планировка & Пикетаж -->
            <div id="aiTabCad" class="ai-tab-pane" style="display:none;">
              <div id="aiCadPanelRoot"></div>
            </div>

            <!-- Вкладка 5: Фотоконтроль (5 фото) -->
            <div id="aiTabPhoto" class="ai-tab-pane" style="display:none;">
              <div id="aiPhotoPanelRoot"></div>
            </div>

            <!-- Вкладка 6: Голос и API -->
            <div id="aiTabVoice" class="ai-tab-pane" style="display:none;">
              <div class="ai-voice-box">
                <button id="aiVoiceMicBtn" class="ai-voice-mic-btn" type="button" onclick="window.AiVoiceEngine.toggleListen()">🎙️</button>
                <div id="aiVoiceTranscript" class="ai-voice-transcript">Нажмите на микрофон и скажите команду (например: «542 погрузка 20 кубов перемещение на Базу Север» или «Всё, отправляй все доработки на доработку»)</div>
              </div>
              <div id="aiVoiceParsedCard" class="ai-voice-parsed-card" style="display:none;"></div>
              
              <div class="ai-sim-panel" style="margin-top:14px;">
                <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Интеграция с API (сервис Apimira / apimira.com):</div>
                <div style="font-size:11px;color:var(--muted);margin-bottom:8px;">
                  Подключение через Apimira (OpenAI-совместимый шлюз) или напрямую к DeepSeek. Без ключа работает встроенная математика.
                </div>
                <div style="display:flex;gap:6px;margin-bottom:6px;">
                  <button type="button" class="ai-speed-btn active" id="btnPresetApimira" onclick="window.AiCopilotUI.setApiPreset('apimira')">Apimira (apimira.com)</button>
                  <button type="button" class="ai-speed-btn" id="btnPresetDeepSeek" onclick="window.AiCopilotUI.setApiPreset('deepseek')">DeepSeek Direct</button>
                </div>
                <input id="aiApiEndpointInput" type="text" placeholder="https://api.apimira.com/v1/chat/completions" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;margin-bottom:6px;">
                <input id="aiApiModelInput" type="text" placeholder="deepseek/deepseek-chat" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;margin-bottom:6px;">
                <input id="aiDeepSeekKeyInput" type="password" placeholder="Ключ API (sk-...)" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;margin-bottom:8px;">
                <div style="display:flex;gap:6px;margin-bottom:6px;">
                  <button class="ai-btn-step" style="flex:1;" onclick="window.AiCopilotUI.saveApiKey()">💾 Сохранить</button>
                  <button class="ai-btn-start" style="flex:1;" id="aiTestApiBtn" onclick="window.AiCopilotUI.testApiConnection()">🔌 Проверить связь</button>
                </div>
                <div id="aiApiTestStatus" style="font-size:11px;min-height:16px;"></div>
              </div>
            </div>

            <!-- Вкладка 7: Замечания и Генератор Промпта для OpenCode -->
            <div id="aiTabFeedback" class="ai-tab-pane" style="display:none;">
              <div class="ai-sim-panel">
                <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Записать замечание или баг:</div>
                <div style="display:flex;gap:6px;margin-bottom:8px;">
                  <input id="aiFeedbackTextInput" type="text" placeholder="Что не нравится или надо доделать?..." style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
                  <button class="ai-btn-step" style="padding:0 12px;" onclick="window.AiCopilotUI.submitFeedback()">Добавить</button>
                </div>
                <button class="ai-btn-mission-dispatch" style="margin-top:6px;" onclick="window.AiDeveloperBridge.dispatchAllMissions()">
                  🚀 Отправить все доработки в OpenCode (по 1 команде)
                </button>
              </div>

              <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px;">💡 Предложения ИИ по оптимизации интерфейса:</div>
              <div id="aiAiSuggestionsList" style="margin-bottom:10px;"></div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;align-items:center;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-size:12px;font-weight:700;color:var(--muted);">Ваши замечания:</span>
                  <button type="button" class="btn btn-secondary btn-small" style="font-size:10px;padding:1px 6px;" onclick="window.AiFeedbackCollector.clearFeedbacks()" title="Очистить все выполненные замечания">🧹 Очистить</button>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-size:12px;font-weight:700;color:var(--muted);">Ошибки UI:</span>
                  <button type="button" class="btn btn-secondary btn-small" style="font-size:10px;padding:1px 6px;" onclick="window.AiFeedbackCollector.clearErrors()" title="Очистить все ошибки">🧹 Очистить</button>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div id="aiUserFeedbackList" class="ai-log-box" style="height:110px;"></div>
                <div id="aiSystemErrorsList" class="ai-log-box" style="height:110px;"></div>
              </div>
              <div style="margin-top:8px;display:flex;justify-content:flex-end;">
                <button type="button" class="ai-btn-reset" style="font-size:11px;padding:4px 10px;" onclick="window.AiFeedbackCollector.clearAll()">
                  🧹 Очистить всё выполненное (замечания и баги)
                </button>
              </div>
            </div>

            <!-- Вкладка 8: Модель -->
            <div id="aiTabModel" class="ai-tab-pane" style="display:none;">
              <div class="ai-sim-panel">
                <div style="font-size:14px;font-weight:700;color:#c084fc;margin-bottom:8px;">Обученная модель (IndexedDB / Local):</div>
                <div id="aiModelStats" style="font-size:12px;line-height:1.6;color:var(--text);">
                  Загрузка метрик...
                </div>
                <div id="aiTrafficInfoBox" style="margin-top:8px;padding:8px;background:rgba(245,158,11,0.1);border-radius:8px;border:1px solid rgba(245,158,11,0.3);font-size:11px;color:#fbbf24;"></div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;">
                  <button class="ai-btn-step" onclick="window.AiCopilotUI.retrainModel()">🔄 Обучить по архиву</button>
                  <button class="ai-btn-start" onclick="window.AiCopilotUI.syncWithNas()">📤 В Synology NAS</button>
                </div>
              </div>
              <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Профили машин (прогноз рейса и окончания смены):</div>
              <div id="aiTruckProfilesList" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
            </div>

            <!-- Вкладка 9: Открыть на телефоне (PWA) -->
            <div id="aiTabMobile" class="ai-tab-pane" style="display:none;">
              <div id="aiMobileConnectRoot"></div>
            </div>

          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    openModal(initialTab) {
      if (window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission('can_use')) {
        if (typeof showToastEl === 'function') {
          showToastEl('🔒 Доступ к ИИ-помощнику ограничен администратором для вашей роли', true);
        }
        return;
      }
      const modal = document.getElementById('aiCopilotModal');
      if (modal) {
        modal.classList.add('active', 'open');
        if (window.AiPermissionsManager) window.AiPermissionsManager.applyToUI();

        const tabsMap = {
          simulator: 'simulator',
          analytics: 'analytics',
          route: 'route_maps',
          cad: 'cad_dwg',
          photo: 'photo_protocol',
          voice: 'voice_input',
          mobile: 'can_use',
          feedback: 'opencode_bridge',
          model: 'model_train'
        };

        const allowedTabs = ['simulator', 'analytics', 'route', 'cad', 'photo', 'voice', 'mobile', 'feedback', 'model'].filter(t => {
          return !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission(tabsMap[t]);
        });

        let targetTab = initialTab || this.activeTab;
        if (!allowedTabs.includes(targetTab)) {
          targetTab = allowedTabs[0] || 'analytics';
        }
        if (targetTab) this.switchTab(targetTab);

        this.updateSimulatorUI();
        this.renderModelStats();
        this.renderFeedbackList();
        this.renderUxSuggestions();
        this.renderAnalyticsUI();
        this.renderCadUI();
        this.renderPhotoUI();
        this.syncApiInputs();
        this.syncRouteInputs();
      }
    },

    syncRouteInputs() {
      const l = document.getElementById('aiRouteLoadInput');
      const u = document.getElementById('aiRouteUnloadInput');
      if (l) l.value = AiRouteManager.loadAddress;
      if (u) u.value = AiRouteManager.unloadAddress;
    },

    saveRouteInputs() {
      const l = document.getElementById('aiRouteLoadInput');
      const u = document.getElementById('aiRouteUnloadInput');
      if (l && u) {
        AiRouteManager.save(l.value, u.value);
        if (typeof showToastEl === 'function') showToastEl('✅ Адреса маршрута сохранены', false);
        this.renderShiftBanner();
      }
    },

    switchTab(tab) {
      const tabsMap = {
        simulator: 'simulator',
        analytics: 'analytics',
        route: 'route_maps',
        cad: 'cad_dwg',
        photo: 'photo_protocol',
        voice: 'voice_input',
        mobile: 'can_use',
        feedback: 'opencode_bridge',
        model: 'model_train'
      };
      if (tabsMap[tab] && window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission(tabsMap[tab])) {
        if (typeof showToastEl === 'function') showToastEl('🔒 Этот модуль отключен для вашей роли', true);
        return;
      }
      this.activeTab = tab;
      document.querySelectorAll('.ai-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.aiTab === tab);
      });
      document.getElementById('aiTabSimulator').style.display = tab === 'simulator' ? 'block' : 'none';
      document.getElementById('aiTabAnalytics').style.display = tab === 'analytics' ? 'block' : 'none';
      document.getElementById('aiTabRoute').style.display = tab === 'route' ? 'block' : 'none';
      document.getElementById('aiTabCad').style.display = tab === 'cad' ? 'block' : 'none';
      document.getElementById('aiTabPhoto').style.display = tab === 'photo' ? 'block' : 'none';
      document.getElementById('aiTabVoice').style.display = tab === 'voice' ? 'block' : 'none';
      if (document.getElementById('aiTabMobile')) {
        document.getElementById('aiTabMobile').style.display = tab === 'mobile' ? 'block' : 'none';
      }
      document.getElementById('aiTabFeedback').style.display = tab === 'feedback' ? 'block' : 'none';
      document.getElementById('aiTabModel').style.display = tab === 'model' ? 'block' : 'none';

      if (tab === 'analytics') this.renderAnalyticsUI();
      if (tab === 'cad') this.renderCadUI();
      if (tab === 'photo') this.renderPhotoUI();
      if (tab === 'voice') this.syncApiInputs();
      if (tab === 'mobile') this.renderMobileConnectUI();
      if (tab === 'model') this.renderModelStats();
      if (tab === 'feedback') {
        this.renderFeedbackList();
        this.renderUxSuggestions();
      }
    },

    renderMobileConnectUI() {
      const root = document.getElementById('aiMobileConnectRoot');
      if (!root) return;

      // Определение URL для подключения телефона
      const origin = window.location.origin;
      const path = window.location.pathname.includes('index-test.html') ? window.location.pathname : '/index-test.html';
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const defaultHost = isLocal ? 'http://95.52.247.215:4173/index-test.html' : `${origin}${path}`;
      const savedHost = localStorage.getItem('samosval_mobile_url_override') || defaultHost;
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(savedHost)}`;

      const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
      const swReady = 'serviceWorker' in navigator;
      const geoReady = 'geolocation' in navigator;
      const camReady = 'mediaDevices' in navigator || ('capture' in document.createElement('input'));

      root.innerHTML = `
        <div class="ai-sim-panel" style="text-align:center;">
          <div style="font-size:15px;font-weight:800;color:#38bdf8;margin-bottom:6px;">📱 Запуск PWA на смартфоне</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:12px;">
            Отсканируйте QR-код штатной камерой телефона или скопируйте ссылку для запуска на iOS / Android
          </div>

          <div style="margin:12px auto;width:180px;height:180px;background:#ffffff;border-radius:14px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;">
            <img src="${qrApiUrl}" alt="QR-код для смартфона" style="width:100%;height:100%;display:block;border-radius:6px;" onerror="this.onerror=null;this.parentElement.innerHTML='<div style=\\'color:#000;font-size:11px;padding:10px;\\'>QR временно недоступен.<br>Используйте ссылку ниже</div>';">
          </div>

          <div style="margin-bottom:12px;display:flex;gap:6px;align-items:center;">
            <input id="aiMobileUrlInput" type="text" value="${savedHost}" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;">
            <button class="ai-btn-step" style="padding:8px 12px;font-size:11px;" onclick="window.AiCopilotUI.copyMobileUrl()">📋 Копировать</button>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;">
            <a href="${savedHost}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">
              <button class="ai-btn-yandex" style="width:100%;justify-content:center;font-size:11px;">🌐 Открыть в браузере</button>
            </a>
            <button class="ai-btn-step" style="width:100%;justify-content:center;font-size:11px;" onclick="window.AiCopilotUI.saveCustomMobileUrl()">💾 Сохранить URL</button>
          </div>

          <!-- Инструкция по установке -->
          <div style="background:rgba(15,23,42,0.8);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:left;font-size:11px;line-height:1.45;margin-bottom:12px;">
            <div style="font-weight:800;color:#fde047;margin-bottom:4px;">📲 Как установить на рабочий стол смартфона:</div>
            <div style="margin-bottom:4px;">🍏 <b>iPhone (Safari):</b> Нажмите кнопку «Поделиться» (квадрат со стрелкой вверх) ➔ выберите «На экран „Домой“».</div>
            <div>🤖 <b>Android (Chrome):</b> Нажмите «⋮» (меню) ➔ выберите «Установить приложение» или «Добавить на главный экран».</div>
            <div style="margin-top:4px;color:#86efac;">⚡ Работает в полноэкранном режиме оффлайн без интернета!</div>
          </div>

          <!-- Диагностика возможностей телефона -->
          <div style="background:rgba(15,23,42,0.8);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:left;font-size:11px;">
            <div style="font-weight:800;color:#94a3b8;margin-bottom:4px;">🔍 Диагностика мобильного окружения:</div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
              <span>Режим экрана:</span>
              <span style="font-weight:700;color:${isStandalone ? '#4ade80' : '#fbbf24'};">${isStandalone ? '📱 Standalone PWA' : '🌐 Веб-браузер'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
              <span>Service Worker (оффлайн):</span>
              <span style="font-weight:700;color:${swReady ? '#4ade80' : '#f87171'};">${swReady ? '✅ Активен' : '❌ Нет'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
              <span>GPS (пикетаж/карты):</span>
              <span style="font-weight:700;color:${geoReady ? '#4ade80' : '#f87171'};">${geoReady ? '✅ Доступен' : '❌ Нет'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span>Камера (фотоконтроль):</span>
              <span style="font-weight:700;color:${camReady ? '#4ade80' : '#fbbf24'};">${camReady ? '✅ Поддерживается' : '⚠️ Ограничено'}</span>
            </div>
          </div>
        </div>
      `;
    },

    copyMobileUrl() {
      const input = document.getElementById('aiMobileUrlInput');
      const val = input ? input.value.trim() : window.location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(() => {
          if (typeof showToastEl === 'function') showToastEl('📋 Ссылка на PWA скопирована в буфер!', false);
        }).catch(() => {
          if (typeof showToastEl === 'function') showToastEl(`Ссылка: ${val}`, false);
        });
      } else {
        if (typeof showToastEl === 'function') showToastEl(`Ссылка: ${val}`, false);
      }
    },

    saveCustomMobileUrl() {
      const input = document.getElementById('aiMobileUrlInput');
      if (input && input.value.trim()) {
        localStorage.setItem('samosval_mobile_url_override', input.value.trim());
        if (typeof showToastEl === 'function') showToastEl('✅ Адрес для телефона сохранен', false);
        this.renderMobileConnectUI();
      }
    },

    renderAnalyticsUI() {
      const root = document.getElementById('aiAnalyticsPanelRoot');
      if (!root) return;
      const d = AiDynamicAnalytics.getSummaryData();
      const b = d.balance;

      root.innerHTML = `
        <div class="ai-metric-grid">
          <div class="ai-metric-tile">
            <div class="ai-metric-val">${d.millingRate} м³/ч</div>
            <div class="ai-metric-lbl">⚡ Темп фрезы</div>
            <div class="ai-metric-sub">T_load ~${b.tLoad} мин / T_ход ~${b.tTravel} мин</div>
          </div>
          <div class="ai-metric-tile">
            <div class="ai-metric-val">${b.activeN} / ${b.idealN}</div>
            <div class="ai-metric-lbl">🚛 Баланс парка (факт/расчет)</div>
            <div class="ai-metric-sub">Формула: (T_ход+T_погр)/T_погр</div>
          </div>
          <div class="ai-metric-tile">
            <div class="ai-metric-val">${d.factVol} м³</div>
            <div class="ai-metric-lbl">🏭 Вывоз на завод (${d.factTrips} р.)</div>
            <div class="ai-metric-sub">${d.transTrips ? `+${d.transVol} м³ (${d.transTrips} р.) перемещения` : 'Внутренних перемещений нет'}</div>
          </div>
          <div class="ai-metric-tile">
            <div class="ai-metric-val">~${d.projected1630Vol} м³</div>
            <div class="ai-metric-lbl">🎯 Прогноз к 16:30</div>
            <div class="ai-metric-sub">При текущем ритме фрезы</div>
          </div>
        </div>

        <div class="ai-fleet-balance ${b.status}">
          <b>${b.status === 'optimal' ? '✅ Оптимальный баланс' : b.status === 'starvation' ? '⚠️ Нехватка автопарка' : '⏳ Избыток автопарка'}</b>
          <div>${b.message}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;">
          <button class="ai-btn-copy-wa" onclick="window.AiDynamicAnalytics.copyShareText()">📋 Скопировать сводку</button>
          <button class="ai-btn-start" style="background:linear-gradient(135deg,#0284c7,#0369a1);" onclick="window.AiDynamicAnalytics.shareViaTelegram()">✈️ В Telegram</button>
        </div>
      `;
    },

    renderCadUI(locRes) {
      const root = document.getElementById('aiCadPanelRoot');
      if (!root) return;
      const c = AiCadRoadEngine.calculateVolume();
      const data = AiCadRoadEngine.data;
      const anchors = data.anchors || [];

      let locInfo = '';
      locRes = locRes || data.lastLocation;
      if (locRes && (locRes.calibrated === false || !Number.isFinite(locRes.currentStation))) {
        const coords = locRes.rawCoords || locRes.coordinates;
        const lat = Number.isFinite(coords?.lat) ? coords.lat.toFixed(6) : '—';
        const lon = Number.isFinite(coords?.lon) ? coords.lon.toFixed(6) : '—';
        locInfo = `<div style="border:1px solid #38bdf8;border-radius:10px;padding:8px;margin-bottom:10px;font-size:12px;">Координаты: широта ${lat}, долгота ${lon}; пикетаж ещё не привязан.</div>`;
      } else if (locRes) {
        locInfo = `
          <div style="background:rgba(56,189,248,0.15);border:1px solid #38bdf8;border-radius:10px;padding:8px;margin-bottom:10px;font-size:12px;">
            <b>🎯 Ваше местоположение на чертеже:</b><br>
            • Текущий пикет: <b>${escapeHtml(locRes.stationFormatted || 'ПК ' + locRes.currentStation.toFixed(2))}</b> (отклонение от оси: ${locRes.offsetM}м)<br>
            • Отметки: рельеф Z=${locRes.groundZ}м, проект Z=${locRes.projectZ}м (срезка <b>${locRes.cutCm} см</b>)<br>
            • До границы захватки: <b>${locRes.distanceToEndM} м</b> (точность GPS: ${locRes.accuracy}м)<br>
            • Остаток срезки от вас: <b>~${Math.round(locRes.distanceToEndM * data.widthM * (data.depthCm/100))} м³</b>
            ${locRes.anchorsCount ? `<br>• Привязка: полилиния по <b>${locRes.anchorsCount} точкам</b> (сегмент #${(locRes.segmentIndex || 0) + 1})` : ''}
          </div>
        `;
      }

      let calibStatus = '';
      if (data.vector?.ready && anchors.length >= 2) {
        const segCount = anchors.length - 1;
        calibStatus = `
          <div style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:8px;margin-bottom:8px;font-size:11px;color:#86efac;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <b>✅ Трасса откалибрована (${anchors.length} точек, ${segCount} сегм.):</b>
              <button type="button" class="btn btn-secondary btn-small" style="font-size:9px;padding:1px 6px;" onclick="window.AiCopilotUI.clearCadAnchors()" title="Сбросить все точки">Сброс</button>
            </div>
            • Отрезок: ПК ${anchors[0].station.toFixed(2)} ➔ ПК ${anchors[anchors.length - 1].station.toFixed(2)}<br>
            • Длина трассы: <b>${data.vector.distanceM} м</b> (генеральный азимут ${data.vector.azimuthDeg}°)<br>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
              ${anchors.map((a, i) => `
                <span style="background:rgba(15,23,42,0.8);border:1px solid #334155;border-radius:4px;padding:2px 6px;font-size:10px;color:#e2e8f0;display:inline-flex;align-items:center;gap:4px;">
                  <b>Т${i + 1}:</b> ПК ${a.station.toFixed(2)} (±${a.accuracy}м)
                  <span style="cursor:pointer;color:#f87171;font-weight:700;margin-left:2px;" onclick="window.AiCopilotUI.deleteCadAnchor(${i})" title="Удалить точку">×</span>
                </span>
              `).join('')}
            </div>
          </div>
        `;
      } else if (anchors.length === 1) {
        calibStatus = `
          <div style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:8px;margin-bottom:8px;font-size:11px;color:#fde047;">
            ⚠️ <b>Точка 1 зафиксирована (ПК ${anchors[0].station.toFixed(2)}):</b><br>
            Подойдите к следующему пикету (Т2) и нажмите кнопку «📍 2. Направление (Т2)» для калибровки вектора трассы.
          </div>
        `;
      } else {
        calibStatus = `
          <div style="background:rgba(148,163,184,0.1);border:1px dashed #64748b;border-radius:8px;padding:8px;margin-bottom:8px;font-size:11px;color:#94a3b8;">
            📍 Калибровка не выполнена. Привяжите минимум 2 точки (Т1 и Т2) для точной привязки пикетажа к местности.
          </div>
        `;
      }

      root.innerHTML = `
        <div class="ai-cad-panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <div style="font-size:14px;font-weight:800;color:#38bdf8;">📐 DWG / DXF Вертикальная планировка</div>
            <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(56,189,248,0.2);color:#38bdf8;font-weight:700;">Offline-first</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">
            Файл чертежа: <b style="color:#e2e8f0;">${data.cadFileName || 'Не выбран'}</b> ${data.cadFileData ? `(${data.cadFileData.stations.length} ПК, ${data.cadFileData.profile.length} отметок, ${data.cadFileData.format || 'DXF'})` : ''}
          </div>

          ${data.cadFileData?.isBinaryDwg ? `
            <div style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.5);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:#fde047;">
              ⚠️ <b>Честный fallback бинарного DWG (${data.cadFileData.dwgVersion || 'AutoCAD'}):</b><br>
              Закрытый бинарный формат. Извлечено ${data.cadFileData.stations.length} текстовых маркеров ПК. Профиль рассчитан по захватке. Для векторной 3D-модели экспортируйте в DXF.
            </div>
          ` : ''}

          <input type="file" id="aiCadFileInput" accept=".dxf,.dwg,.json,.txt" style="display:none;" onchange="window.AiCopilotUI.handleCadFileUpload(event)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
            <button class="ai-btn-step" onclick="document.getElementById('aiCadFileInput').click()">📂 Загрузить DWG / DXF</button>
            <button class="ai-btn-start" onclick="window.AiCopilotUI.openCadViewer()">🗺️ Открыть чертёж</button>
          </div>

          ${locInfo}
          ${calibStatus}

          <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px;">Многоточечная привязка пикетажа трассы:</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
            <button class="ai-btn-step" onclick="window.AiCopilotUI.promptPoint1()">📍 1. Базовый (Т1)</button>
            <button class="ai-btn-step" onclick="window.AiCopilotUI.promptPoint2()">📍 2. Направление (Т2)</button>
            <button class="ai-btn-step" onclick="window.AiCopilotUI.promptAddPoint()">➕ Добавить ПК</button>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
            <div>
              <label style="font-size:11px;color:var(--muted);">Начало захватки (ПК):</label>
              <input id="aiCadStartPk" type="number" step="0.1" value="${data.startStation}" class="ai-pk-input" style="width:100%;">
            </div>
            <div>
              <label style="font-size:11px;color:var(--muted);">Конец захватки (ПК):</label>
              <input id="aiCadEndPk" type="number" step="0.1" value="${data.endStation}" class="ai-pk-input" style="width:100%;">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
            <div>
              <label style="font-size:10px;color:var(--muted);">Ширина B (м):</label>
              <input id="aiCadWidth" type="number" step="0.5" value="${data.widthM}" class="ai-pk-input" style="width:100%;">
            </div>
            <div>
              <label style="font-size:10px;color:var(--muted);">Срезка H (см):</label>
              <input id="aiCadDepth" type="number" step="0.5" value="${data.depthCm}" class="ai-pk-input" style="width:100%;">
            </div>
            <div>
              <label style="font-size:10px;color:var(--muted);">Кузов (м³):</label>
              <input id="aiCadCap" type="number" step="1" value="${data.truckCapacityM3}" class="ai-pk-input" style="width:100%;">
            </div>
          </div>

          <div class="ai-metric-grid" style="margin-bottom:10px;">
            <div class="ai-metric-tile">
              <div class="ai-metric-val">${c.lengthM} м</div>
              <div class="ai-metric-lbl">Длина захватки (${c.areaM2} м²)</div>
            </div>
            <div class="ai-metric-tile">
              <div class="ai-metric-val">${c.volumeM3} м³</div>
              <div class="ai-metric-lbl">Проектный объём (${c.tons} т)</div>
            </div>
            <div class="ai-metric-tile">
              <div class="ai-metric-val">${c.tripsNeeded}</div>
              <div class="ai-metric-lbl">Всего рейсов по проекту</div>
            </div>
            <div class="ai-metric-tile">
              <div class="ai-metric-val">${c.progressPercent}%</div>
              <div class="ai-metric-lbl">Вывезено: ${c.currentFactM3} из ${c.volumeM3} м³</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
            <button class="ai-btn-step" onclick="window.AiCopilotUI.saveCadInputs()">💾 Пересчитать проект</button>
            <button class="ai-btn-start" onclick="window.AiCadRoadEngine.locateOnDrawing()">🎯 Где я на чертеже</button>
          </div>
        </div>
      `;
    },

    handleCadFileUpload(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const parsed = AiCadRoadEngine.parseCadFileContent(file.name, text);
        if (parsed.isBinaryDwg) {
          if (typeof showToastEl === 'function') {
            showToastEl(`⚠️ Честный fallback DWG (${parsed.dwgVersion}): найдено ${parsed.stations.length} ПК. Для точной 3D-модели экспортируйте в DXF.`, true);
          }
        } else {
          if (typeof showToastEl === 'function') {
            showToastEl(`✅ Чертёж "${file.name}" загружен Offline (${parsed.stations.length} ПК, ${parsed.profile.length} отметок)`, false);
          }
        }
        this.renderCadUI();
        const titleEl = document.getElementById('aiCadViewerFileTitle');
        if (titleEl) titleEl.textContent = 'Файл: ' + file.name + (parsed.isBinaryDwg ? ' [DWG Fallback]' : '');
        if (document.getElementById('aiCadViewerModal')?.classList.contains('open')) {
          AiCadRoadEngine.drawViewerCanvases();
        }
      };
      reader.readAsText(file);
    },

    saveCadInputs() {
      const s = document.getElementById('aiCadStartPk');
      const e = document.getElementById('aiCadEndPk');
      const w = document.getElementById('aiCadWidth');
      const d = document.getElementById('aiCadDepth');
      const c = document.getElementById('aiCadCap');

      if (s) AiCadRoadEngine.data.startStation = parseFloat(s.value) || 10.0;
      if (e) AiCadRoadEngine.data.endStation = parseFloat(e.value) || 15.5;
      if (w) AiCadRoadEngine.data.widthM = parseFloat(w.value) || 7.5;
      if (d) AiCadRoadEngine.data.depthCm = parseFloat(d.value) || 5.0;
      if (c) AiCadRoadEngine.data.truckCapacityM3 = parseFloat(c.value) || 20;

      AiCadRoadEngine.save();
      this.renderCadUI();
      if (typeof showToastEl === 'function') showToastEl('✅ Параметры захватки обновлены', false);
    },

    async promptPoint1() {
      const cur = AiCadRoadEngine.data.anchors?.[0]?.station || AiCadRoadEngine.data.anchor1?.station || AiCadRoadEngine.data.startStation;
      const pk = prompt('Введите номер первого базового пикета (Т1), где вы стоите (например 10.00):', cur);
      if (pk !== null && !isNaN(parseFloat(pk))) {
        await AiCadRoadEngine.calibratePoint(1, parseFloat(pk));
      }
    },

    async promptPoint2() {
      if (!AiCadRoadEngine.data.anchors?.length && !AiCadRoadEngine.data.anchor1) {
        if (typeof showToastEl === 'function') showToastEl('Сначала зафиксируйте Точку 1!', true);
        return;
      }
      const cur = AiCadRoadEngine.data.anchors?.[1]?.station || AiCadRoadEngine.data.anchor2?.station || AiCadRoadEngine.data.endStation;
      const pk = prompt('Введите номер второго пикета трассы (Т2 для вектора направления, например 12.00):', cur);
      if (pk !== null && !isNaN(parseFloat(pk))) {
        await AiCadRoadEngine.calibratePoint(2, parseFloat(pk));
      }
    },

    async promptAddPoint() {
      const anchors = AiCadRoadEngine.data.anchors || [];
      const lastSt = anchors.length ? anchors[anchors.length - 1].station + 1.0 : AiCadRoadEngine.data.startStation;
      const pk = prompt('Введите номер следующего пикета трассы (ПК), где вы стоите (например ' + lastSt.toFixed(2) + '):', lastSt.toFixed(2));
      if (pk !== null && !isNaN(parseFloat(pk))) {
        await AiCadRoadEngine.addAnchorPoint(parseFloat(pk));
      }
    },

    deleteCadAnchor(idx) {
      AiCadRoadEngine.removeAnchorPoint(idx);
    },

    clearCadAnchors() {
      if (confirm('Сбросить все точки привязки трассы?')) {
        AiCadRoadEngine.clearAnchors();
      }
    },

    renderPhotoUI() {
      const root = document.getElementById('aiPhotoPanelRoot');
      if (!root) return;
      const prog = AiPhotoProtocol.getProgress();

      let stepsHtml = AiPhotoProtocol.steps.map(s => {
        const isDone = !!AiPhotoProtocol.completedSteps[s.id];
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:8px;background:${isDone ? 'rgba(34,197,94,0.1)' : 'rgba(15,23,42,0.6)'};border:1px solid ${isDone ? 'rgba(34,197,94,0.3)' : 'var(--border)'};margin-bottom:6px;">
            <div>
              <span style="font-weight:700;font-size:12px;color:${isDone ? '#86efac' : 'var(--text)'};">
                ${isDone ? '✅' : '📷'} Фото #${s.id}: ${s.title}
              </span>
              ${isDone ? `<div style="font-size:10px;color:#94a3b8;">Выполнено в ${AiPhotoProtocol.completedSteps[s.id].timeStr}</div>` : ''}
            </div>
            <button class="ai-btn-photo-quick" onclick="window.AiPhotoProtocol.triggerTakePhoto(${s.id})">
              ${isDone ? 'Переснять' : 'Снять'}
            </button>
          </div>
        `;
      }).join('');

      root.innerHTML = `
        <div class="ai-sim-panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-size:14px;font-weight:800;color:#38bdf8;">📸 Регламент фотофиксации смены (5 фото)</div>
            <span class="ai-photo-badge ${prog.isCompleted ? 'completed' : ''}">
              ${prog.count} из 5 выполнено
            </span>
          </div>

          <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">
            Регламент дорожного участка: минимум 5 контрольных фото за смену. Переход в системную камеру или приложение смартфона в 1 клик.
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">Приложение для съёмки на смартфоне:</label>
            <select id="aiPhotoAppTypeSelect" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;margin-bottom:6px;" onchange="window.AiCopilotUI.savePhotoAppSettings()">
              <option value="camera_native" ${AiPhotoProtocol.appType === 'camera_native' ? 'selected' : ''}>📸 Системная камера смартфона</option>
              <option value="app_custom" ${AiPhotoProtocol.appType === 'app_custom' ? 'selected' : ''}>🔗 Внешнее приложение / ссылка (Synology Photos, Telegram, GPS Map Camera)</option>
            </select>
            <input id="aiPhotoCustomUrlInput" type="text" value="${AiPhotoProtocol.customAppUrl}" placeholder="например: synologyphotos:// или ссылка на чат объекта" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;display:${AiPhotoProtocol.appType === 'app_custom' ? 'block' : 'none'};">
          </div>

          <button class="ai-btn-photo-quick" style="width:100%;padding:10px;justify-content:center;font-size:13px;margin-bottom:14px;" onclick="window.AiPhotoProtocol.triggerTakePhoto()">
            📸 Сделать следующее фото (#${prog.nextStep.id}: ${prog.nextStep.title})
          </button>

          <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Этапы смены:</div>
          ${stepsHtml}
        </div>
      `;
    },

    savePhotoAppSettings() {
      const sel = document.getElementById('aiPhotoAppTypeSelect');
      const url = document.getElementById('aiPhotoCustomUrlInput');
      if (sel) {
        AiPhotoProtocol.appType = sel.value;
        if (url) url.style.display = sel.value === 'app_custom' ? 'block' : 'none';
      }
      if (url) AiPhotoProtocol.customAppUrl = url.value.trim();
      AiPhotoProtocol.save();
    },

    renderShiftBanner() {
      const container = document.getElementById('aiShiftBannerContainer');
      if (!container) return;

      if (!window.state?.shift || (window.AiPermissionsManager && !window.AiPermissionsManager.hasPermission('can_view'))) {
        container.innerHTML = '';
        return;
      }

      const balance = MillingPipelineTracker.getFleetBalance();
      const photo = AiPhotoProtocol.getProgress();
      const canPhoto = !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission('photo_protocol');
      const canRoute = !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission('route_maps');
      const canAnalytics = !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission('analytics');
      const canCad = !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission('cad_dwg');

      let photoRow = '';
      if (canPhoto) {
        photoRow = `
          <div class="ai-shift-banner-row">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="ai-photo-badge ${photo.isCompleted ? 'completed' : ''}">
                📸 Фотоконтроль: <b>${photo.count}/5</b>
              </span>
              <span style="font-size:11px;color:var(--muted);">${photo.isCompleted ? 'Регламент выполнен' : photo.nextStep.title}</span>
            </div>
            <button class="ai-btn-photo-quick" onclick="window.AiPhotoProtocol.triggerTakePhoto()">
              📸 Сделать фото ${photo.isCompleted ? '' : '#' + photo.nextStep.id}
            </button>
          </div>
        `;
      }

      let routeBtn = canRoute ? `<button class="ai-btn-yandex" style="padding:4px 8px;font-size:10px;" onclick="window.AiRouteManager.openYandexMaps()">🗺️ Маршрут</button>` : '';
      let analyticsBtn = canAnalytics ? `<button class="ai-btn-step" style="padding:4px 8px;font-size:10px;" onclick="window.AiCopilotUI.openModal('analytics')">📊 Аналитика</button>` : '';
      let cadBtn = canCad ? `<button class="ai-btn-step" style="padding:4px 8px;font-size:10px;" onclick="window.AiCopilotUI.openModal('cad')">📐 Пикетаж</button>` : '';

      container.innerHTML = `
        <div class="ai-shift-banner">
          ${photoRow}
          <div class="ai-shift-banner-row" style="${canPhoto ? 'border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;' : ''}">
            <div style="font-size:12px;">
              ⚡ Фреза: <b>~${balance.millingRateM3h} м³/ч</b> · 
              <span style="color:${balance.status === 'optimal' ? '#86efac' : balance.status === 'starvation' ? '#fca5a5' : '#fde047'};font-weight:700;">
                ${balance.status === 'optimal' ? 'Идеал' : balance.status === 'starvation' ? 'Дефицит машин!' : 'Очередь!'} (${balance.activeN}/${balance.idealN})
              </span>
            </div>
            <div style="display:flex;gap:4px;">
              ${routeBtn}
              ${analyticsBtn}
              ${cadBtn}
            </div>
          </div>
        </div>
      `;
    },

    observeLoadActions() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const txt = btn.textContent || '';
        const cls = btn.className || '';
        if (cls.includes('btn-load') || txt.includes('Погрузка')) {
          const card = btn.closest('.truck-card');
          const truckId = card?.dataset?.truckId;
          if (truckId) {
            const pred = AiLocalLearner.predict(truckId);
            MillingPipelineTracker.onTruckLoad(truckId, pred.predictedVol);
          }
        }
      }, true);
    },

    syncApiInputs() {
      const ep = document.getElementById('aiApiEndpointInput');
      const mod = document.getElementById('aiApiModelInput');
      const key = document.getElementById('aiDeepSeekKeyInput');
      const statusEl = document.getElementById('aiApiTestStatus');

      if (ep) ep.value = localStorage.getItem(STORAGE_KEY_API_ENDPOINT) || 'https://api.apimira.com/v1/chat/completions';
      if (mod) mod.value = localStorage.getItem(STORAGE_KEY_API_MODEL) || 'deepseek/deepseek-chat';
      if (key) key.value = localStorage.getItem(STORAGE_KEY_API_KEY) || localStorage.getItem(STORAGE_KEY_DEEPSEEK) || '';

      const lastRaw = localStorage.getItem(STORAGE_KEY_API_STATUS) || localStorage.getItem('dt_ai_api_last_status');
      if (lastRaw && statusEl && !statusEl.textContent) {
        try {
          const last = JSON.parse(lastRaw);
          const rating = last.latencyRating || (last.elapsed < 400 ? '🟢 Отлично' : (last.elapsed < 1200 ? '🟡 Норма' : '🟠 Задержка'));
          statusEl.style.color = last.ok ? '#34d399' : '#f87171';
          statusEl.textContent = `Предыдущая проверка (${last.timeStr || ''}): ${last.message || last.status} · ${last.elapsed || 0} мс`;
        } catch (e) {}
      }
      if (statusEl && !statusEl.textContent) statusEl.textContent = 'Внешний API не проверен/офлайн';
    },

    setApiPreset(preset) {
      const ep = document.getElementById('aiApiEndpointInput');
      const mod = document.getElementById('aiApiModelInput');
      const pApimira = document.getElementById('btnPresetApimira');
      const pDeepSeek = document.getElementById('btnPresetDeepSeek');

      if (preset === 'apimira') {
        if (ep) ep.value = 'https://api.apimira.com/v1/chat/completions';
        if (mod) mod.value = 'deepseek/deepseek-chat';
        pApimira?.classList.add('active');
        pDeepSeek?.classList.remove('active');
      } else {
        if (ep) ep.value = 'https://api.deepseek.com/chat/completions';
        if (mod) mod.value = 'deepseek-chat';
        pDeepSeek?.classList.add('active');
        pApimira?.classList.remove('active');
      }
    },

    setSimSpeed(speed) {
      document.querySelectorAll('.ai-speed-btn').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.speed) === speed);
      });
      AiShiftSimulator.setSpeed(speed);
    },

    toggleSim() {
      if (AiShiftSimulator.running) {
        AiShiftSimulator.pause();
      } else {
        AiShiftSimulator.start();
      }
    },

    stepSim() {
      AiShiftSimulator.stepOneCycle();
    },

    resetSim() {
      AiShiftSimulator.reset();
    },

    addDummyShift() {
      if (window.state?.shift) {
        if (typeof showToastEl === 'function') showToastEl('Смена уже открыта', false);
        return;
      }
      const obj = (window.state?.objects || [])[0] || { id: 'obj_sim', name: 'Симуляция: Реконструкция трассы' };
      if (typeof startShiftWithObject === 'function') {
        try {
          startShiftWithObject(obj.name, obj.id);
        } catch(e) {}
      }
      if (!window.state) window.state = {};
      if (!window.state.shift) {
        window.state.shift = {
          id: 'sim_shift_' + Date.now(),
          objectName: obj.name || 'Симуляция: Реконструкция трассы',
          objectId: obj.id || 'obj_sim',
          isActive: true,
          startedAt: Date.now(),
          createdBy: 'ИИ-Симулятор'
        };
      }

      if (!window.state.trucks || window.state.trucks.length === 0) {
        window.state.trucks = [
          { id: 'sim_t1', number: '101', brand: 'КАМАЗ', defaultVol: 20 },
          { id: 'sim_t2', number: '102', brand: 'МАЗ', defaultVol: 20 },
          { id: 'sim_t3', number: '103', brand: 'Scania', defaultVol: 25 },
          { id: 'sim_t4', number: '104', brand: 'Volvo', defaultVol: 25 }
        ];
      }
      if (!window.state.truckStatus) window.state.truckStatus = {};
      window.state.trucks.slice(0, 4).forEach(t => {
        if (!window.state.truckStatus[t.id]) {
          window.state.truckStatus[t.id] = { onLine: true, arriveStatus: false, loadedAfterArrive: false, ttnStatus: false };
        } else {
          window.state.truckStatus[t.id].onLine = true;
        }
      });

      if (typeof window.renderLine === 'function') window.renderLine();
      if (typeof showToastEl === 'function') showToastEl('🚀 Симуляция: смена запущена (машины на линии)', false);
      this.updateSimulatorUI();
    },

    stopDummyShift() {
      if (!window.state?.shift) {
        if (typeof showToastEl === 'function') showToastEl('Смена уже закрыта', false);
        return;
      }
      AiShiftSimulator.pause();
      if (window.state) window.state.shift = null;
      if (typeof window.renderLine === 'function') window.renderLine();
      if (typeof showToastEl === 'function') showToastEl('🛑 Симуляция: смена закрыта', false);
      this.updateSimulatorUI();
    },

    toggleDummyShift() {
      if (window.state?.shift) {
        this.stopDummyShift();
      } else {
        this.addDummyShift();
      }
    },

    updateSimulatorUI() {
      const startBtn = document.getElementById('aiSimStartBtn');
      const floatBtn = document.getElementById('aiFloatingBtn');
      const shiftStatus = document.getElementById('aiSimShiftStatus');
      const shiftToggleBtn = document.getElementById('aiSimShiftToggleBtn');
      const rounds = document.getElementById('aiSimRounds');
      const loads = document.getElementById('aiSimLoads');
      const trucksCount = document.getElementById('aiSimTrucksCount');

      if (startBtn) {
        startBtn.textContent = AiShiftSimulator.running ? '⏸ Приостановить' : '▶️ Запустить';
        startBtn.className = AiShiftSimulator.running ? 'ai-btn-stop' : 'ai-btn-start';
      }
      if (shiftToggleBtn) {
        shiftToggleBtn.textContent = window.state?.shift ? '🛑 Закрыть смену' : '🚀 Начать смену';
        shiftToggleBtn.style.color = window.state?.shift ? '#f87171' : '#34d399';
      }
      if (floatBtn) {
        floatBtn.classList.toggle('simulating', AiShiftSimulator.running);
      }
      if (shiftStatus) {
        shiftStatus.textContent = window.state?.shift ? `Смена: ${window.state.shift.objectName || 'Активна'}` : 'Закрыта';
        shiftStatus.style.color = window.state?.shift ? '#34d399' : '#f87171';
      }
      if (rounds) rounds.textContent = AiShiftSimulator.roundCount;
      if (loads) loads.textContent = AiShiftSimulator.totalSimulatedLoads;
      if (trucksCount) {
        const c = (window.state?.trucks || []).filter(t => window.state?.truckStatus?.[t.id]?.onLine).length;
        trucksCount.textContent = c;
      }
    },

    renderSimulatorLogs() {
      const box = document.getElementById('aiSimLogBox');
      if (!box) return;
      box.innerHTML = AiShiftSimulator.logs.map(l => {
        return `<div class="ai-log-item ${l.type}"><span style="color:#64748b;">${l.time}</span> ${l.msg}</div>`;
      }).join('');
    },

    renderModelStats() {
      const m = AiLocalLearner.getOverallMetrics();
      const statsBox = document.getElementById('aiModelStats');
      if (statsBox) {
        statsBox.innerHTML = `
          <div>🚚 Изучено профилей машин: <b>${m.profiledTrucks}</b></div>
          <div>⚡ Накоплено фактов погрузок: <b>${m.totalLoads}</b></div>
          <div>⏱ Замерено длительностей рейсов: <b>${m.totalTrips}</b></div>
          <div style="color:var(--muted);font-size:10px;margin-top:4px;">
            Последнее обучение: ${m.lastTrainedAt ? new Date(m.lastTrainedAt).toLocaleTimeString('ru-RU') : 'при запуске'}
          </div>
        `;
      }

      const trafficBox = document.getElementById('aiTrafficInfoBox');
      if (trafficBox) {
        const traffic = AiLocalLearner.getTrafficFactor();
        const patterns = AiLocalLearner.data.shiftEndPatterns || {};
        const ttnH = patterns.typicalTtnStartHour || 16.0;
        const endH = patterns.typicalEndHour || 16.5;
        const ttnStr = Math.floor(ttnH) + ':' + String(Math.round((ttnH % 1) * 60)).padStart(2, '0');
        const endStr = Math.floor(endH) + ':' + String(Math.round((endH % 1) * 60)).padStart(2, '0');

        trafficBox.innerHTML = `
          <div><b>🚦 Трафик (${traffic.dayName}):</b> ${traffic.reason} (x${traffic.factor})</div>
          <div style="margin-top:2px;"><b>⏰ Паттерн смены:</b> сбор ТТН ~${ttnStr}, закрытие ~${endStr}</div>
        `;
      }

      const list = document.getElementById('aiTruckProfilesList');
      if (list) {
        const trucks = window.state?.trucks || [];
        const items = trucks.slice(0, 10).map(t => {
          const pred = AiLocalLearner.predict(t.id);
          const feasibility = AiLocalLearner.checkLastRoundFeasibility(t.id);
          return `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:11px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <b>${t.brand} ${t.number}</b>
                <span style="color:var(--muted);margin-left:6px;">${pred.predictedVol} м³ · ${pred.predictedMaterial}</span>
              </div>
              <div style="text-align:right;">
                ${feasibility.warning ? 
                  `<span style="color:#f87171;font-weight:700;">🛑 Возврат ~${feasibility.returnTimeStr}</span>` : 
                  `<span style="color:#38bdf8;font-weight:700;">⏱ ~${feasibility.trafficMins} мин (${pred.confidence}%)</span>`}
              </div>
            </div>
          `;
        });
        list.innerHTML = items.length ? items.join('') : '<div style="color:var(--muted);">Нет данных</div>';
      }
    },

    renderUxSuggestions() {
      const box = document.getElementById('aiAiSuggestionsList');
      if (!box) return;
      const suggestions = AiUxAnalytics.generateSuggestions();
      if (!suggestions.length) {
        box.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px;">Пока нет предложений</div>';
        return;
      }
      box.innerHTML = suggestions.map(s => `
        <div class="ai-suggestion-card">
          <b>💡 ${s.title}</b>
          <div>${s.text}</div>
        </div>
      `).join('');
    },

    retrainModel() {
      AiLocalLearner.bootstrapFromStateLogs();
      this.renderModelStats();
      if (typeof showToastEl === 'function') showToastEl('✅ Модель переобучена по архивным данным', false);
    },

    async syncWithNas() {
      const ok = await AiNasSyncBridge.pushWeightsToNas();
      if (typeof showToastEl === 'function') {
        showToastEl(ok ? '📤 База знаний ИИ синхронизирована с Synology NAS' : '📦 Веса сохранены в локальную очередь NAS (офлайн)', false);
      }
    },

    updateVoiceUI() {
      const btn = document.getElementById('aiVoiceMicBtn');
      if (btn) {
        btn.classList.toggle('listening', AiVoiceEngine.listening);
      }
    },

    showVoiceTranscript(text) {
      const el = document.getElementById('aiVoiceTranscript');
      if (el) el.textContent = text;
    },

    showParsedPreview(parsed) {
      const card = document.getElementById('aiVoiceParsedCard');
      if (!card) return;
      card.style.display = 'block';

      const badgeHtml = parsed.sourceBadge ? `
        <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${parsed.sourceBadge.type==='api'?'rgba(56,189,248,0.2)':'rgba(245,158,11,0.2)'};color:${parsed.sourceBadge.type==='api'?'#38bdf8':'#f59e0b'};border:1px solid ${parsed.sourceBadge.type==='api'?'rgba(56,189,248,0.4)':'rgba(245,158,11,0.4)'};">
          ${parsed.sourceBadge.label}
        </span>
      ` : '';

      const detailsHtml = parsed.sourceBadge?.details ? `
        <div style="font-size:10px;color:var(--muted);margin-bottom:6px;">${parsed.sourceBadge.details}</div>
      ` : '';

      let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:4px;">
          <h4 style="margin:0;">✨ Распознано:</h4>
          ${badgeHtml}
        </div>
        ${detailsHtml}
      `;

      if (parsed.type === 'dispatch_opencode') {
        html += `<div style="font-size:12px;margin-bottom:8px;color:#38bdf8;"><b>${parsed.message || 'Отправка всех доработок в OpenCode'}</b></div>`;
        html += `<button class="ai-btn-mission-dispatch" onclick="window.AiDeveloperBridge.dispatchAllMissions()">🚀 Отправить в OpenCode</button>`;
      } else if (parsed.type === 'take_photo') {
        html += `<div style="font-size:12px;margin-bottom:8px;color:#86efac;"><b>${parsed.message}</b></div>`;
        html += `<button class="ai-btn-photo-quick" style="width:100%;padding:10px;justify-content:center;" onclick="window.AiPhotoProtocol.triggerTakePhoto()">📸 Сделать фото</button>`;
      } else if (parsed.type === 'open_route') {
        html += `<div style="font-size:12px;margin-bottom:8px;color:#f59e0b;"><b>${parsed.message}</b></div>`;
        html += `<button class="ai-btn-yandex" style="width:100%;padding:10px;justify-content:center;" onclick="window.AiRouteManager.openYandexMaps()">🗺️ Открыть Яндекс Карты</button>`;
      } else if (parsed.tabelRows?.length) {
        html += `<div style="font-size:12px;margin-bottom:8px;"><b>В табель (${parsed.tabelRows.length} поз.):</b></div>`;
        parsed.tabelRows.forEach(r => {
          html += `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #1e293b;">👤 ${r.name}: <b>${r.hours} ч</b> (${r.role})</div>`;
        });
        html += `<button class="ai-btn-step" style="width:100%;margin-top:10px;" onclick="window.AiCopilotUI.applyTabelVoiceRows()">✅ Применить в табель</button>`;
      } else if (parsed.truckActions?.length) {
        html += `<div style="font-size:12px;margin-bottom:8px;"><b>Команда на линии:</b></div>`;
        parsed.truckActions.forEach(a => {
          const transTxt = a.isTransfer ? ` <span style="color:#a855f7;">(🔄 Перемещение: ${a.transferDest})</span>` : '';
          html += `<div style="font-size:11px;padding:4px 0;">🚛 ${a.truckName || a.truckId}: <b>${a.action}</b> (${a.volume || 20} м³)${transTxt}</div>`;
        });
        html += `<button class="ai-btn-step" style="width:100%;margin-top:10px;" onclick="window.AiCopilotUI.applyLineVoiceActions()">✅ Выполнить на линии</button>`;
      } else {
        html += `<div style="color:var(--muted);font-size:11px;">Не удалось выделить конкретные действия. Попробуйте сказать: «542 погрузка 20 кубов перемещение на Базу Север» или «Всё, отправляй все доработки на доработку».</div>`;
      }
      card.innerHTML = html;
      window.__lastAiParsed = parsed;
    },

    applyTabelVoiceRows() {
      const parsed = window.__lastAiParsed;
      if (!parsed?.tabelRows?.length) return;
      if (typeof showToastEl === 'function') {
        showToastEl(`✅ Применено ${parsed.tabelRows.length} позиций в табель!`, false);
      }
      document.getElementById('aiCopilotModal')?.classList.remove('active', 'open');
    },

    applyLineVoiceActions() {
      const parsed = window.__lastAiParsed;
      if (!parsed?.truckActions?.length) return;
      parsed.truckActions.forEach(a => {
        if (a.action === 'arrive' && typeof toggleArrive === 'function') {
          toggleArrive(a.truckId);
        } else if (a.action === 'load' && typeof performLoad === 'function') {
          performLoad(a.truckId, null, a.isTransfer ? { isTransfer: true, transferDest: a.transferDest } : null);
          MillingPipelineTracker.onTruckLoad(a.truckId, a.volume, a.isTransfer, a.transferDest);
        } else if (a.action === 'ttn' && typeof toggleTtn === 'function') {
          toggleTtn(a.truckId);
        }
      });
      document.getElementById('aiCopilotModal')?.classList.remove('active', 'open');
    },

    saveApiKey() {
      const keyInput = document.getElementById('aiDeepSeekKeyInput');
      const epInput = document.getElementById('aiApiEndpointInput');
      const modelInput = document.getElementById('aiApiModelInput');

      if (keyInput) localStorage.setItem(STORAGE_KEY_API_KEY, keyInput.value.trim());
      if (epInput) localStorage.setItem(STORAGE_KEY_API_ENDPOINT, epInput.value.trim());
      if (modelInput) localStorage.setItem(STORAGE_KEY_API_MODEL, modelInput.value.trim());

      if (typeof showToastEl === 'function') showToastEl('🔑 Настройки API (Apimira) сохранены', false);
    },

    async testApiConnection() {
      const statusEl = document.getElementById('aiApiTestStatus');
      const btn = document.getElementById('aiTestApiBtn');
      const epInput = document.getElementById('aiApiEndpointInput');
      const modelInput = document.getElementById('aiApiModelInput');
      const keyInput = document.getElementById('aiDeepSeekKeyInput');

      const endpoint = epInput?.value.trim() || localStorage.getItem(STORAGE_KEY_API_ENDPOINT) || 'https://api.apimira.com/v1/chat/completions';
      const model = modelInput?.value.trim() || localStorage.getItem(STORAGE_KEY_API_MODEL) || 'deepseek/deepseek-chat';
      const apiKey = keyInput?.value.trim() || localStorage.getItem(STORAGE_KEY_API_KEY) || localStorage.getItem(STORAGE_KEY_DEEPSEEK);

      if (navigator.onLine === false || !apiKey) {
        window.aiApiUnchecked(statusEl, navigator.onLine === false ? 'offline' : 'not_checked');
        const msg = 'Внешний API не проверен/офлайн. Для явной проверки нужны сеть и API-ключ.';
        if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = msg; }
        if (typeof showToastEl === 'function') showToastEl(msg, true);
        return;
      }

      if (statusEl) { statusEl.style.color = '#38bdf8'; statusEl.textContent = '⏳ Проверка настроенного endpoint API...'; }
      if (btn) btn.disabled = true;

      const t0 = performance.now();
      const startTs = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(endpoint, {
          signal: controller.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.trim()}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'Ответь кратко: "OK"' }],
            max_tokens: 5
          })
        });
        const elapsed = Math.round(performance.now() - t0);
        const latencyRating = elapsed < 400 ? '🟢 Отлично' : (elapsed < 1200 ? '🟡 Норма' : '🟠 Задержка выше нормы');

        const bridgeRaw = localStorage.getItem('samosval_opencode_bridge_last_status');
        let bridgeInfo = '';
        if (bridgeRaw) {
          try {
            const b = JSON.parse(bridgeRaw);
            bridgeInfo = ` | Мост: ${b.connected ? '🟢 OK (' + (b.latency || 0) + ' мс)' : '🔴 Офлайн'}`;
          } catch (e) {}
        }

        if (res.ok) {
          const remaining = 15000 - (Date.now() - startTs);
          const data = typeof window.aiApiReadJsonWithDeadline === 'function'
            ? await window.aiApiReadJsonWithDeadline(res, remaining, controller)
            : await (async () => {
                if (remaining <= 0 || controller?.signal?.aborted) {
                  controller?.abort();
                  const err = new Error('Таймаут API (15 секунд)');
                  err.name = 'AbortError';
                  throw err;
                }
                let timerId = null;
                const jp = res.json();
                jp.catch(() => {});
                const tp = new Promise((_, rej) => {
                  timerId = setTimeout(() => {
                    controller?.abort();
                    const err = new Error('Таймаут API (15 секунд)');
                    err.name = 'AbortError';
                    rej(err);
                  }, remaining);
                });
                try {
                  return await Promise.race([jp, tp]);
                } finally {
                  if (timerId) clearTimeout(timerId);
                }
              })();
          const fullElapsed = Math.round(performance.now() - t0);
          const finalRating = fullElapsed < 400 ? '🟢 Отлично' : (fullElapsed < 1200 ? '🟡 Норма' : '🟠 Задержка выше нормы');
          const text = data?.choices?.[0]?.message?.content ? 'Ответ модели получен' : 'HTTP OK';
          const successMsg = `✅ Связь успешна (200 OK · ${fullElapsed} мс [${finalRating}]${bridgeInfo} · Ответ: "${text.trim()}")`;
          if (statusEl) { statusEl.style.color = '#34d399'; statusEl.textContent = successMsg; }
          if (typeof showToastEl === 'function') showToastEl(`✅ API подключен (${fullElapsed}мс, ${finalRating})`, false);

          const statusRecord = {
            ok: true,
            status: 200,
            elapsed: fullElapsed,
            latencyRating: finalRating,
            timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            timestamp: Date.now(),
            model,
            message: `Ответ: "${text.trim()}"`
          };
          localStorage.setItem(STORAGE_KEY_API_STATUS, JSON.stringify(statusRecord));
          localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
        } else {
          const errText = 'Проверьте endpoint, модель и права ключа (подробности в Network).';
          const failMsg = `❌ Ошибка ${res.status} (${res.statusText}) · ${elapsed} мс [${latencyRating}]${bridgeInfo}: ${errText.slice(0, 100)}`;
          if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = failMsg; }
          if (typeof showToastEl === 'function') showToastEl(`Ошибка API: ${res.status}`, true);

          const statusRecord = {
            ok: false,
            status: res.status,
            elapsed,
            latencyRating,
            timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            timestamp: Date.now(),
            model,
            message: `HTTP ${res.status}: ${errText.slice(0, 80)}`
          };
          localStorage.setItem(STORAGE_KEY_API_STATUS, JSON.stringify(statusRecord));
          localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
        }
      } catch (err) {
        const elapsed = Math.round(performance.now() - t0);
        const diagnostic = window.aiApiDiagnosticError(err);
        const failMsg = `❌ ${diagnostic.message} (${elapsed} мс)`;
        if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = failMsg; }
        if (typeof showToastEl === 'function') showToastEl('Ошибка соединения с API', true);

        const statusRecord = {
          ok: false,
          status: diagnostic.status,
          elapsed,
          latencyRating: '🔴 Нет связи',
          timeStr: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: Date.now(),
          model,
          message: diagnostic.message
        };
        localStorage.setItem(STORAGE_KEY_API_STATUS, JSON.stringify(statusRecord));
        localStorage.setItem('samosval_ai_api_last_status', JSON.stringify(statusRecord));
      } finally {
        clearTimeout(timer);
        if (btn) btn.disabled = false;
      }
    },

    submitFeedback() {
      const input = document.getElementById('aiFeedbackTextInput');
      if (!input || !input.value.trim()) return;
      AiFeedbackCollector.addFeedback(input.value.trim());
      input.value = '';
      if (typeof showToastEl === 'function') showToastEl('📝 Замечание сохранено в бортжурнал', false);
    },

    renderFeedbackList() {
      const fbBox = document.getElementById('aiUserFeedbackList');
      const errBox = document.getElementById('aiSystemErrorsList');
      if (fbBox) {
        fbBox.innerHTML = AiFeedbackCollector.feedbacks.length ? 
          AiFeedbackCollector.feedbacks.map((f, idx) => `
            <div class="ai-log-item" style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
              <div style="flex:1;">
                <span style="color:#64748b;">[${f.time}]</span> <b>[${f.tab}]</b> ${f.text}
              </div>
              <button type="button" class="btn-clear-item" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:0 4px;line-height:1;" title="Удалить выполненное замечание" onclick="window.AiFeedbackCollector.removeFeedback('${f.id || idx}')">✕</button>
            </div>
          `).join('') :
          '<div style="color:var(--muted);padding:4px;">Все замечания выполнены</div>';
      }
      if (errBox) {
        errBox.innerHTML = AiFeedbackCollector.errors.length ?
          AiFeedbackCollector.errors.map((e, idx) => `
            <div class="ai-log-item anomaly" style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;padding:3px 0;border-bottom:1px solid rgba(239,68,68,0.15);">
              <div style="flex:1;">
                <span style="color:#64748b;">[${e.time}]</span> ${e.message}
              </div>
              <button type="button" class="btn-clear-item" style="background:transparent;border:none;color:#f87171;cursor:pointer;font-size:12px;padding:0 4px;line-height:1;" title="Удалить ошибку" onclick="window.AiFeedbackCollector.removeError(${idx})">✕</button>
            </div>
          `).join('') :
          '<div style="color:var(--muted);padding:4px;">Ошибок нет</div>';
      }
    },

    async copyAiPrompt() {
      const prompt = AiFeedbackCollector.generatePromptForAiDeveloper();
      try {
        await navigator.clipboard.writeText(prompt);
        if (typeof showToastEl === 'function') {
          showToastEl('📋 Промпт для нейросети скопирован в буфер!', false);
        }
      } catch (e) {
        alert('Скопируйте промпт вручную:\n\n' + prompt);
      }
    },

    observeLineCards() {
      const list = document.getElementById('trucksLineList');
      if (!list) return;

      const decorateCards = () => {
        list.querySelectorAll('.truck-card[data-truck-id]').forEach(card => {
          const truckId = card.dataset.truckId;
          if (!truckId) return;
          let badge = card.querySelector('.ai-truck-badge');
          const pred = AiLocalLearner.predict(truckId);
          const feasibility = AiLocalLearner.checkLastRoundFeasibility(truckId);

          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'ai-truck-badge';
            const header = card.querySelector('.truck-header') || card;
            header.appendChild(badge);
          }

          if (feasibility.warning) {
            badge.className = 'ai-truck-badge anomaly-endshift';
            badge.innerHTML = `🛑 ${feasibility.traffic.dayName}: возврат ~${feasibility.returnTimeStr} (позже смены)`;
          } else if (pred.anomaly) {
            badge.className = 'ai-truck-badge ' + (pred.anomaly.type === 'fast' ? 'anomaly-fast' : 'anomaly-slow');
            badge.innerHTML = `⚠️ ${pred.anomaly.text}`;
          } else {
            badge.className = 'ai-truck-badge';
            badge.innerHTML = `✨ ИИ: ${pred.predictedVol} м³ · ~${feasibility.trafficMins} мин (${pred.confidence}%)`;
          }
        });
      };

      new MutationObserver(decorateCards).observe(list, { childList: true });
      setInterval(decorateCards, 2000);
      decorateCards();
    },

    injectTabelVoiceButton() {
      const checkAndInject = () => {
        const tabTimesheet = document.getElementById('tab-timesheet');
        if (!tabTimesheet) return;
        const existing = tabTimesheet.querySelector('.btn-tabel-voice');
        const canTabel = !window.AiPermissionsManager || window.AiPermissionsManager.hasPermission('tabel_voice');
        if (!canTabel) {
          if (existing) existing.remove();
          return;
        }
        if (existing) return;
        const nav = tabTimesheet.querySelector('.tn-tools') || tabTimesheet.querySelector('.tn-date-nav');
        if (nav) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-tabel-voice';
          btn.innerHTML = `🎙️ Голосом в табель`;
          btn.onclick = () => {
            AiCopilotUI.openModal('voice');
            AiVoiceEngine.toggleListen();
          };
          nav.appendChild(btn);
        }
      };
      setInterval(checkAndInject, 1500);
    }
  };

  // Экспорт в глобальную область
  window.AiPermissionsManager = AiPermissionsManager;
  window.hasAiPermission = (key, role) => AiPermissionsManager.hasPermission(key, role);
  window.AiLocalLearner = AiLocalLearner;
  window.AiShiftSimulator = AiShiftSimulator;
  window.AiVoiceEngine = AiVoiceEngine;
  window.AiFeedbackCollector = AiFeedbackCollector;
  window.AiUxAnalytics = AiUxAnalytics;
  window.AiNasSyncBridge = AiNasSyncBridge;
  window.MillingPipelineTracker = MillingPipelineTracker;
  window.AiRouteManager = AiRouteManager;
  window.AiDynamicAnalytics = AiDynamicAnalytics;
  window.AiPhotoProtocol = AiPhotoProtocol;
  window.AiCadRoadEngine = AiCadRoadEngine;
  window.AiDeveloperBridge = AiDeveloperBridge;
  window.AiFeatureBus = AiFeatureBus;
  window.AiCopilotUI = AiCopilotUI;

  // Автоматический запуск после готовности DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AiCopilotUI.mount());
  } else {
    AiCopilotUI.mount();
  }
})();
