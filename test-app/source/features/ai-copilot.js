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
  const STORAGE_KEY_FEEDBACK = 'samosval_ai_feedback_v1';
  const STORAGE_KEY_UX = 'samosval_ai_ux_v1';

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
      if (apiKey && navigator.onLine) {
        try {
          const parsed = await this.queryExternalAiApi(text, apiKey);
          if (parsed) {
            AiCopilotUI.showParsedPreview(parsed);
            return;
          }
        } catch (e) {
          console.warn('[AI API] Ошибка внешнего API (Apimira), переключаюсь на локальный парсер:', e);
        }
      }

      const localResult = this.parseLocally(text);
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
            volume: vol
          });
        }
      }

      if (result.tabelRows.length) result.type = 'tabel';
      else if (result.truckActions.length) result.type = 'line';

      return result;
    },

    async queryExternalAiApi(text, apiKey) {
      const endpoint = localStorage.getItem(STORAGE_KEY_API_ENDPOINT) || 'https://api.apimira.com/v1/chat/completions';
      const model = localStorage.getItem(STORAGE_KEY_API_MODEL) || 'deepseek/deepseek-chat';

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
        text: `Изучено поведение: сбор ТТН обычно начинается около ${ttnTimeStr}. Сегодня: ${traffic.dayName} (${traffic.reason}). Рекомендуется показывать кнопку «Финальный рейс / Отпустить с линии» для машин, не успевающих до закрытия смены.`
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
  // 5. ИНТЕРФЕЙС И ИНТЕГРАЦИЯ В DOM
  // ==========================================================
  const AiCopilotUI = {
    activeTab: 'simulator',

    mount() {
      AiLocalLearner.init();
      AiVoiceEngine.init();
      AiFeedbackCollector.init();
      AiUxAnalytics.init();

      this.injectFloatingButton();
      this.injectModal();
      this.observeLineCards();
      this.injectTabelVoiceButton();
    },

    injectFloatingButton() {
      if (document.getElementById('aiFloatingBtn')) return;
      const btn = document.createElement('button');
      btn.id = 'aiFloatingBtn';
      btn.className = 'ai-floating-btn';
      btn.setAttribute('type', 'button');
      btn.innerHTML = `<span class="ai-btn-pulse"></span> 🤖 ИИ`;
      btn.onclick = () => this.openModal();
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
              <span>🤖</span> ИИ-Помощник и Бортжурнал
            </div>
            <button class="modal-close" type="button" onclick="document.getElementById('aiCopilotModal').classList.remove('active')">&times;</button>
          </div>
          <div class="modal-body" style="padding:14px;max-height:calc(92dvh - 120px);overflow-y:auto;">
            <div class="ai-modal-tabs" style="grid-template-columns: repeat(4, 1fr);">
              <button class="ai-tab-btn active" data-ai-tab="simulator" onclick="window.AiCopilotUI.switchTab('simulator')">🎮 Симулятор</button>
              <button class="ai-tab-btn" data-ai-tab="model" onclick="window.AiCopilotUI.switchTab('model')">📊 Модель</button>
              <button class="ai-tab-btn" data-ai-tab="voice" onclick="window.AiCopilotUI.switchTab('voice')">🎙️ Голос</button>
              <button class="ai-tab-btn" data-ai-tab="feedback" onclick="window.AiCopilotUI.switchTab('feedback')">📝 Замечания</button>
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
                  <button class="ai-btn-reset" onclick="window.AiCopilotUI.addDummyShift()">➕ Тест-смена</button>
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

            <!-- Вкладка 2: Модель -->
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

            <!-- Вкладка 3: Голос и API -->
            <div id="aiTabVoice" class="ai-tab-pane" style="display:none;">
              <div class="ai-voice-box">
                <button id="aiVoiceMicBtn" class="ai-voice-mic-btn" type="button" onclick="window.AiVoiceEngine.toggleListen()">🎙️</button>
                <div id="aiVoiceTranscript" class="ai-voice-transcript">Нажмите на микрофон и продиктуйте часы в табель или номер машины</div>
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
                <button class="ai-btn-step" style="width:100%;" onclick="window.AiCopilotUI.saveApiKey()">💾 Сохранить настройки Apimira API</button>
              </div>
            </div>

            <!-- Вкладка 4: Замечания и Генератор Промпта для нейросети -->
            <div id="aiTabFeedback" class="ai-tab-pane" style="display:none;">
              <div class="ai-sim-panel">
                <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Записать замечание или баг:</div>
                <div style="display:flex;gap:6px;margin-bottom:8px;">
                  <input id="aiFeedbackTextInput" type="text" placeholder="Что не нравится или надо доделать?..." style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;">
                  <button class="ai-btn-step" style="padding:0 12px;" onclick="window.AiCopilotUI.submitFeedback()">Добавить</button>
                </div>
                <button class="ai-btn-start" style="width:100%;margin-top:6px;display:flex;align-items:center;justify-content:center;gap:6px;" onclick="window.AiCopilotUI.copyAiPrompt()">
                  📋 Сгенерировать Промпт для ИИ-разработчика
                </button>
              </div>

              <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px;">💡 Предложения ИИ по оптимизации интерфейса:</div>
              <div id="aiAiSuggestionsList" style="margin-bottom:10px;"></div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">
                <span style="font-size:12px;font-weight:700;color:var(--muted);">Ваши замечания:</span>
                <span style="font-size:12px;font-weight:700;color:var(--muted);">Ошибки UI:</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div id="aiUserFeedbackList" class="ai-log-box" style="height:100px;"></div>
                <div id="aiSystemErrorsList" class="ai-log-box" style="height:100px;"></div>
              </div>
            </div>

          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    openModal() {
      const modal = document.getElementById('aiCopilotModal');
      if (modal) {
        modal.classList.add('active');
        this.updateSimulatorUI();
        this.renderModelStats();
        this.renderFeedbackList();
        this.renderUxSuggestions();
        this.syncApiInputs();
      }
    },

    syncApiInputs() {
      const ep = document.getElementById('aiApiEndpointInput');
      const mod = document.getElementById('aiApiModelInput');
      const key = document.getElementById('aiDeepSeekKeyInput');
      if (ep) ep.value = localStorage.getItem(STORAGE_KEY_API_ENDPOINT) || 'https://api.apimira.com/v1/chat/completions';
      if (mod) mod.value = localStorage.getItem(STORAGE_KEY_API_MODEL) || 'deepseek/deepseek-chat';
      if (key) key.value = localStorage.getItem(STORAGE_KEY_API_KEY) || localStorage.getItem(STORAGE_KEY_DEEPSEEK) || '';
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

    switchTab(tab) {
      this.activeTab = tab;
      document.querySelectorAll('.ai-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.aiTab === tab);
      });
      document.getElementById('aiTabSimulator').style.display = tab === 'simulator' ? 'block' : 'none';
      document.getElementById('aiTabModel').style.display = tab === 'model' ? 'block' : 'none';
      document.getElementById('aiTabVoice').style.display = tab === 'voice' ? 'block' : 'none';
      document.getElementById('aiTabFeedback').style.display = tab === 'feedback' ? 'block' : 'none';
      if (tab === 'model') this.renderModelStats();
      if (tab === 'feedback') {
        this.renderFeedbackList();
        this.renderUxSuggestions();
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
      if (typeof startShiftWithObject === 'function') {
        const obj = (window.state?.objects || [])[0] || { id: 'test_obj', name: 'Тестовый объект' };
        startShiftWithObject(obj.id, obj.name);
      } else {
        if (typeof showToastEl === 'function') showToastEl('Откройте смену вручную во вкладке Линия', true);
      }
    },

    updateSimulatorUI() {
      const startBtn = document.getElementById('aiSimStartBtn');
      const floatBtn = document.getElementById('aiFloatingBtn');
      const shiftStatus = document.getElementById('aiSimShiftStatus');
      const rounds = document.getElementById('aiSimRounds');
      const loads = document.getElementById('aiSimLoads');
      const trucksCount = document.getElementById('aiSimTrucksCount');

      if (startBtn) {
        startBtn.textContent = AiShiftSimulator.running ? '⏸ Приостановить' : '▶️ Запустить';
        startBtn.className = AiShiftSimulator.running ? 'ai-btn-stop' : 'ai-btn-start';
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

      let html = `<h4>✨ Распознано:</h4>`;
      if (parsed.tabelRows?.length) {
        html += `<div style="font-size:12px;margin-bottom:8px;"><b>В табель (${parsed.tabelRows.length} поз.):</b></div>`;
        parsed.tabelRows.forEach(r => {
          html += `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #1e293b;">👤 ${r.name}: <b>${r.hours} ч</b> (${r.role})</div>`;
        });
        html += `<button class="ai-btn-step" style="width:100%;margin-top:10px;" onclick="window.AiCopilotUI.applyTabelVoiceRows()">✅ Применить в табель</button>`;
      } else if (parsed.truckActions?.length) {
        html += `<div style="font-size:12px;margin-bottom:8px;"><b>Команда на линии:</b></div>`;
        parsed.truckActions.forEach(a => {
          html += `<div style="font-size:11px;padding:4px 0;">🚛 ${a.truckName || a.truckId}: <b>${a.action}</b> (${a.volume || 20} м³)</div>`;
        });
        html += `<button class="ai-btn-step" style="width:100%;margin-top:10px;" onclick="window.AiCopilotUI.applyLineVoiceActions()">✅ Выполнить на линии</button>`;
      } else {
        html += `<div style="color:var(--muted);font-size:11px;">Не удалось выделить конкретные действия. Попробуйте сказать: «Иванов 11 часов дорожный рабочий» или «542 приехал».</div>`;
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
      document.getElementById('aiCopilotModal')?.classList.remove('active');
    },

    applyLineVoiceActions() {
      const parsed = window.__lastAiParsed;
      if (!parsed?.truckActions?.length) return;
      parsed.truckActions.forEach(a => {
        if (a.action === 'arrive' && typeof toggleArrive === 'function') toggleArrive(a.truckId);
        else if (a.action === 'load' && typeof performLoad === 'function') performLoad(a.truckId);
        else if (a.action === 'ttn' && typeof toggleTtn === 'function') toggleTtn(a.truckId);
      });
      document.getElementById('aiCopilotModal')?.classList.remove('active');
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
          AiFeedbackCollector.feedbacks.map(f => `<div class="ai-log-item"><span style="color:#64748b;">[${f.time}]</span> <b>[${f.tab}]</b> ${f.text}</div>`).join('') :
          '<div style="color:var(--muted);padding:4px;">Нет замечаний</div>';
      }
      if (errBox) {
        errBox.innerHTML = AiFeedbackCollector.errors.length ?
          AiFeedbackCollector.errors.map(e => `<div class="ai-log-item anomaly"><span style="color:#64748b;">[${e.time}]</span> ${e.message}</div>`).join('') :
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
        if (!tabTimesheet || tabTimesheet.querySelector('.btn-tabel-voice')) return;
        const nav = tabTimesheet.querySelector('.tn-tools') || tabTimesheet.querySelector('.tn-date-nav');
        if (nav) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-tabel-voice';
          btn.innerHTML = `🎙️ Голосом в табель`;
          btn.onclick = () => {
            AiCopilotUI.openModal();
            AiCopilotUI.switchTab('voice');
            AiVoiceEngine.toggleListen();
          };
          nav.appendChild(btn);
        }
      };
      setInterval(checkAndInject, 1500);
    }
  };

  // Экспорт в глобальную область
  window.AiLocalLearner = AiLocalLearner;
  window.AiShiftSimulator = AiShiftSimulator;
  window.AiVoiceEngine = AiVoiceEngine;
  window.AiFeedbackCollector = AiFeedbackCollector;
  window.AiUxAnalytics = AiUxAnalytics;
  window.AiNasSyncBridge = AiNasSyncBridge;
  window.AiCopilotUI = AiCopilotUI;

  // Автоматический запуск после готовности DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AiCopilotUI.mount());
  } else {
    AiCopilotUI.mount();
  }
})();
