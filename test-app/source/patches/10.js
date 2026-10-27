(function(){
  if (window.__animSpeedsV7) return;
  window.__animSpeedsV7 = true;

  const SPEEDS_KEY = 'dt_anim_speeds_v1';
  const DEFAULTS = { overall: 1, fill: 1, shake: 1, wave: 1 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function loadSpeeds() {
    try {
      const raw = localStorage.getItem(SPEEDS_KEY);
      if (!raw) return { ...DEFAULTS };
      const s = JSON.parse(raw);
      return {
        overall: clamp(s.overall ?? 1, 0.3, 2.5),
        fill: clamp(s.fill ?? 1, 0.3, 2.5),
        shake: clamp(s.shake ?? 1, 0.3, 2.5),
        wave: clamp(s.wave ?? 1, 0.3, 2.5),
      };
    } catch(e) { return { ...DEFAULTS }; }
  }
  function saveSpeeds(s) { try { localStorage.setItem(SPEEDS_KEY, JSON.stringify(s)); } catch(e) {} }

  function getTimings() {
    const s = loadSpeeds();
    return {
      ARRIVE: 3.5 * s.overall,
      LOAD_OUT: 3.5 * s.overall,
      LOAD_FILL: 1.5 * s.overall * s.fill,
      SHAKE: 0.35 * s.shake,
      WAVE_MS: 260 * s.wave,
      SETTLE: 0.8 * s.overall,
      SETTLE_DELAY_MS: 500 * s.overall,
      BUMP: 0.35 * s.overall
    };
  }

  const ANIM_EASE = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

  // ===== CSS =====
  ['arrive-fix-css', 'visual-cards-css', 'visual-cards-v2-css', 'domino-bump-css', 'focus-arrive-css', 'anim-speeds-css'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  const css = document.createElement('style');
  css.id = 'anim-speeds-css';
  css.textContent = `
    .truck-card {
      height: 142px !important; min-height: 142px !important; max-height: 142px !important;
      padding: 10px 12px !important; margin-bottom: 10px !important;
      box-sizing: border-box !important; display: flex !important; flex-direction: column !important;
      gap: 8px !important; overflow: hidden !important; position: relative !important; z-index: 2 !important;
      border-width: 1px !important; border-radius: 12px !important; will-change: transform, box-shadow;
    }
    .truck-card.arrived {
      border-color: var(--warning) !important;
      box-shadow: 0 0 0 1px var(--warning), 0 0 10px rgba(245, 158, 11, 0.35) !important;
    }
    .truck-card.faded:not(.arrived) {
      opacity: 0.35 !important; filter: grayscale(50%) !important; background: #131b2e !important;
    }
    .truck-card .truck-top { flex: 1 1 auto !important; display: flex !important; gap: 12px !important; min-height: 0 !important; overflow: hidden !important; }
    .truck-card .truck-identity {
      flex: 0 0 130px !important; width: 130px !important;
      display: flex !important; flex-direction: column !important; justify-content: center !important;
      gap: 4px !important; min-width: 0 !important; overflow: hidden !important;
    }
    .truck-card .truck-brand {
      font-size: 10.5px !important; font-weight: 700 !important; color: var(--muted) !important;
      text-transform: uppercase !important; letter-spacing: 0.6px !important; line-height: 1 !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
    }
    .truck-card .truck-plate-wrap { display: flex !important; min-width: 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate { height: 34px !important; margin: 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate-main { font-size: 20px !important; padding: 0 6px !important; gap: 1px !important; }
    .truck-card .truck-plate-wrap .ru-plate-main .plate-letter { font-size: 20px !important; }
    .truck-card .truck-plate-wrap .ru-plate-main .plate-digit { font-size: 21px !important; letter-spacing: 1.5px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region { width: 28px !important; min-width: 28px !important; max-width: 28px !important; padding: 1px 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-code.region-2 { font-size: 13px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-code.region-3 { font-size: 12px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-rus { font-size: 5px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .ru-plate-flag { width: 12px !important; height: 7.5px !important; }
    .truck-card .truck-info {
      flex: 1 1 auto !important; min-width: 0 !important;
      display: flex !important; flex-direction: column !important;
      justify-content: center !important; gap: 3px !important; overflow: hidden !important;
    }
    .truck-card .info-row {
      font-size: 11px !important; line-height: 1.2 !important;
      white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
      color: var(--muted) !important; display: flex !important; align-items: center !important; gap: 4px !important;
    }
    .truck-card .info-row b { color: var(--text) !important; font-weight: 700 !important; }
    .truck-card .info-row.info-trip { color: #93c5fd !important; font-weight: 800 !important; font-size: 12px !important; }
    .truck-card .info-row.info-trip b { color: #93c5fd !important; }
    .truck-card .info-row.info-load b { color: #38bdf8 !important; }
    .truck-card .info-row.info-arrive { color: #f59e0b !important; font-weight: 700 !important; }
    .truck-card .info-row.info-arrive b { color: #f59e0b !important; }
    .truck-card .action-row {
      flex: 0 0 44px !important; height: 44px !important; margin: 0 !important;
      display: grid !important; grid-template-columns: auto 2fr 1fr !important;
      gap: 5px !important; align-items: stretch !important;
    }
    .truck-card .btn {
      min-height: 0 !important; height: 100% !important;
      padding: 4px 6px !important; font-size: 11px !important; font-weight: 700 !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; line-height: 1.1 !important;
    }
    .truck-card .btn-arrive .idle-timer { font-size: 14px !important; }
    .truck-card .btn-arrive .idle-label { font-size: 8px !important; }
    .truck-card .btn-ttn { font-size: 10.5px !important; }
    .truck-card.anim-up { z-index: 100 !important; }
    .truck-card.anim-down { z-index: 1 !important; }
    .truck-card.anim-loading {
      z-index: 1 !important;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(34, 197, 94, 0.45) !important;
    }
    .truck-card.anim-front {
      z-index: 100 !important;
      box-shadow:
        0 16px 45px rgba(0, 0, 0, 0.7),
        0 0 0 2px var(--warning),
        0 0 20px rgba(245, 158, 11, 0.6) !important;
    }
    #trucksLineList { overflow: hidden !important; }

    @keyframes cardShake {
      0%, 100% { transform: translateX(0); }
      15% { transform: translateX(-6px); }
      30% { transform: translateX(6px); }
      45% { transform: translateX(-5px); }
      60% { transform: translateX(5px); }
      75% { transform: translateX(-3px); }
      90% { transform: translateX(3px); }
    }
    .truck-card.shaking {
      animation: cardShake var(--shake-dur, 0.35s) ease-in-out !important;
    }
    @keyframes dominoBump {
      0%   { transform: translateY(0); }
      30%  { transform: translateY(-3px); }
      60%  { transform: translateY(1.5px); }
      100% { transform: translateY(0); }
    }
    .truck-card.bumping {
      animation: dominoBump var(--bump-dur, 0.35s) ease-out !important;
    }
    @keyframes arriveFlyFront {
      0%   { transform: translateY(var(--from-y, 0px)) scale(1); }
      10%  { transform: translateY(calc(var(--from-y, 0px) * 0.9)) scale(1.03); }
      90%  { transform: translateY(0) scale(1.03); }
      100% { transform: translateY(0) scale(1); }
    }
    @keyframes gapFillFly {
      0%   { transform: translateY(var(--from-y, 0px)) scale(1); }
      15%  { transform: translateY(calc(var(--from-y, 0px) * 0.7)) scale(1.03); }
      85%  { transform: translateY(0) scale(1.03); }
      100% { transform: translateY(0) scale(1); }
    }

    /* ===== UI настроек ===== */
    .speed-slider-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .speed-slider-row:last-of-type { border-bottom: none; }
    .speed-label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .speed-label { font-size: 13px; font-weight: 600; }
    .speed-value { font-size: 13px; font-weight: 800; color: var(--primary); font-variant-numeric: tabular-nums; }
    .speed-slider { width: 100%; accent-color: var(--primary); height: 24px; }
    .speed-presets { display: flex; gap: 6px; margin-bottom: 12px; }
    .speed-preset-btn { flex: 1; padding: 8px 4px; font-size: 11px; font-weight: 700; border-radius: 8px; line-height: 1.3; }
  `;
    css.textContent += `
      .truck-card{height:auto!important;min-height:154px!important;max-height:none!important}
      .truck-card .truck-top{min-height:76px!important;flex:1 0 auto!important;align-items:center!important;gap:10px!important;overflow:visible!important}
      .truck-card .truck-identity{flex:0 0 148px!important;width:148px!important;overflow:visible!important}
      .truck-card .truck-brand{max-width:148px!important;line-height:1.25!important}
      .truck-card .truck-plate-wrap{width:max-content!important;max-width:100%!important;overflow:visible!important}
      .truck-card .truck-plate-wrap .ru-plate{flex-shrink:0!important;white-space:nowrap!important}
      .truck-card .truck-info{gap:5px!important;overflow:visible!important;align-self:stretch!important}
      .truck-card .truck-info .info-row{white-space:normal!important;overflow:visible!important;line-height:1.25!important;min-width:0!important}
      .truck-card .truck-info .info-trip{flex-wrap:wrap!important;font-size:11px!important;gap:3px!important}
      .truck-card .truck-info .info-load,.truck-card .truck-info .info-arrive{display:flex!important;flex-direction:column!important;align-items:flex-start!important;gap:1px!important;padding:4px 6px!important;border-radius:7px!important}
      .truck-card .truck-info .info-load{background:rgba(56,189,248,.08)!important}
      .truck-card .card-status-label{color:var(--muted)!important;font-size:10px!important;font-weight:500!important}
      .truck-card .load-age-card{font-size:12px!important;overflow-wrap:normal!important}
      .truck-card .truck-info .info-arrive{background:rgba(245,158,11,.08)!important;font-size:11px!important}
      .truck-card .card-arrival-author{font-size:10px!important;color:var(--muted)!important;max-width:100%!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font-weight:500!important}
      @media(max-width:360px){
        .truck-card .truck-identity{flex-basis:132px!important;width:132px!important}
        .truck-card .truck-brand{max-width:132px!important}
        .truck-card .truck-top{gap:8px!important}
        .truck-card .truck-plate-wrap .ru-plate-main{font-size:18px!important;padding:0 4px!important}
        .truck-card .truck-plate-wrap .ru-plate-main .plate-letter{font-size:18px!important}
        .truck-card .truck-plate-wrap .ru-plate-main .plate-digit{font-size:19px!important;letter-spacing:1px!important}
        .truck-card .load-age-card{font-size:11px!important}
      }
    `;
  document.head.appendChild(css);

  // ===== Утилиты =====
  function parseCubicBezier(str) {
    const m = String(str).match(/cubic-bezier\(\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*\)/);
    if (!m) return [0.4, 0.0, 0.2, 1];
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
  }
  function cubicBezierProgress(t, p1x, p1y, p2x, p2y) {
    function A(a1, a2) { return 1 - 3 * a2 + 3 * a1; }
    function B(a1, a2) { return 3 * a2 - 6 * a1; }
    function C(a1) { return 3 * a1; }
    function calcBezier(t, a1, a2) { return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t; }
    function getSlope(t, a1, a2) { return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1); }
    function getTForX(x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const slope = getSlope(t, p1x, p2x);
        if (slope === 0) return t;
        const x2 = calcBezier(t, p1x, p2x) - x;
        t -= x2 / slope;
      }
      return t;
    }
    const tf = getTForX(t);
    return calcBezier(tf, p1y, p2y);
  }

  let activeScrollRaf = null;
  function startSyncScroll(targetDelta, durationSec, easingStr) {
    if (activeScrollRaf) { cancelAnimationFrame(activeScrollRaf); activeScrollRaf = null; }
    const startScroll = window.scrollY;
    const startTime = performance.now();
    const [p1x, p1y, p2x, p2y] = parseCubicBezier(easingStr);
    const durMs = durationSec * 1000;
    function tick() {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / durMs);
      const eased = cubicBezierProgress(t, p1x, p1y, p2x, p2y);
      const next = startScroll + targetDelta * eased;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.max(0, Math.min(maxScroll, next)));
      if (t < 1) activeScrollRaf = requestAnimationFrame(tick);
      else activeScrollRaf = null;
    }
    activeScrollRaf = requestAnimationFrame(tick);
  }

  function formatReis(n) {
    if (n === 0) return 'Нет рейсов';
    const lastDigit = n % 10;
    const lastTwo = n % 100;
    let word = 'рейс';
    if (lastTwo < 11 || lastTwo > 14) {
      if (lastDigit === 1) word = 'рейс';
      else if (lastDigit >= 2 && lastDigit <= 4) word = 'рейса';
      else word = 'рейсов';
    } else word = 'рейсов';
    return n + '-й ' + word;
  }

  function shakeCard(id) {
    const card = document.querySelector(`.truck-card[data-truck-id="${id}"]`);
    if (!card) return Promise.resolve();
    const t = getTimings();
    return new Promise(resolve => {
      card.style.setProperty('--shake-dur', t.SHAKE + 's');
      card.classList.add('shaking');
      setTimeout(() => { card.classList.remove('shaking'); resolve(); }, t.SHAKE * 1000 + 10);
    });
  }

  // ===== Действия: намерение фиксируется до анимации, движение — после подтверждения =====
  const confirmed_toggleArrive=window.toggleArrive;
  window.toggleArrive=async function(id){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_toggleArrive.call(this,id,intent);
  };
  const confirmed_performLoad=window.performLoad;
  window.performLoad=async function(id){
    if(!requireEdit('action_load')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_performLoad.call(this,id,intent);
  };
  const confirmed_toggleTtn=window.toggleTtn;
  window.toggleTtn=async function(id){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_toggleTtn.call(this,id,intent);
  };

  // ===== renderLine =====
  window.renderLine = function() {
    if (window.__lineAnimating) {
      window.__linePendingRender = true;
      return;
    }

    const T = getTimings();

    const sc = document.getElementById('startShiftContainer');
    const ac = document.getElementById('activeShiftContainer');
    const cb = document.getElementById('changeObjBtn');

    if (!state.shift) {
      sc.style.display = hasPermission('start_shift') ? 'block' : 'none';
      ac.style.display = 'none';
      cb.style.display = 'none';
      return;
    }
    sc.style.display = 'none';
    ac.style.display = 'block';
    cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';

    const c = document.getElementById('trucksLineList');
    const oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => {
      oldP[x.dataset.truckId] = x.offsetTop;
    });

    const ids = getActiveLineIds();
    if (!ids.length) {
      c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>';
      return;
    }

    const logs = getLogs();
    const lastTs = {};
    logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp || 0; });

    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a, b) => {
      const sA = state.truckStatus[a.id], sB = state.truckStatus[b.id];
      const aA = sA.arriveStatus ? 1 : 0, aB = sB.arriveStatus ? 1 : 0;
      if (aA !== aB) return aB - aA;
      const tA = sA.ttnStatus === true ? 1 : 0, tB = sB.ttnStatus === true ? 1 : 0;
      if (tA !== tB) return tA - tB;
      const lA = lastTs[a.id] || 0, lB = lastTs[b.id] || 0;
      if (lA === 0 && lB === 0) return 0;
      if (lA === 0) return -1;
      if (lB === 0) return 1;
      return lA - lB;
    });

    const now = Date.now();
    const cyc = (settings.cycleMinutes || 15) * 60000;
    const canEditArrive = hasPermission('action_arrive');
    const canEditLoad = hasPermission('action_load');
    const canEditTtn = hasPermission('action_ttn');
    const showStats = hasPermission('view_card_stats');

    c.innerHTML = trucks.map(t => {
      const st = state.truckStatus[t.id] || {};
      const tLogs = logs.filter(l => l.truckId === t.id);
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      const isA = !!st.arriveStatus;
      const lastL = st.lastLoadTimestamp || 0;
      const inC = lastL > 0 && (now - lastL) < cyc;
      const ttn = st.ttnStatus;
      const faded = ttn === true && !isA;
      const lTs = Math.max(Number(lastL)||0,...tLogs.map(log=>Number(log.timestamp)||0));
      const isGAI = !!t.isGAI;
      const tripsCount = tLogs.length;

      let arrBtn;
      if (inC) {
        arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:14px;" data-load-ts="${lastL}">${formatIdleDuration(cyc - (now - lastL))}</span></span></button>`;
      } else if (isA) {
        arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive ? `onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''} ${!canEditArrive ? 'disabled' : ''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp || now}">${formatIdleDuration(now - (st.arriveTimestamp || now))}</span></span></button>`;
      } else {
        arrBtn = `<button class="btn btn-arrive" ${canEditArrive ? `onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''} ${!canEditArrive ? 'disabled' : ''}>🚛 Приехал</button>`;
      }

      const ttnTxt = ttn ? '📄 ТТН ✓' : '📄 ТТН';
      const loadBtnTxt = '⚡ Погрузка';

      let infoHtml = '';
      if (showStats) {
        if (isGAI) infoHtml += `<div class="info-row info-trip"><b>${formatReis(tripsCount)}</b></div>`;
        else infoHtml += `<div class="info-row info-trip"><b>${formatReis(tripsCount)}</b> · <b>${sum} м³</b></div>`;
      }
      // Operational status is independent of the permission to see trip/volume totals.
      infoHtml += `<div class="info-row info-load"><span class="card-status-label">Загрузился</span><b class="load-age-card" data-timestamp="${lTs}">${formatLoadAge(lTs)}</b></div>`;
      if (isA) {
        const time = st.arriveStatus || '';
        const by = st.arriveBy || '';
        infoHtml += `<div class="info-row info-arrive"><span class="card-arrival-time">Прибыл <b>${escapeHtml(time)}</b></span>${by?`<span class="card-arrival-author" title="${escapeHtml(by)}">${escapeHtml(by)}</span>`:''}</div>`;
      }

      return `<div class="truck-card ${isA ? 'arrived' : ''} ${faded ? 'faded' : ''}" data-truck-id="${t.id}">
        <div class="truck-top">
          <div class="truck-identity">
            <div class="truck-brand">${escapeHtml(t.brand)}</div>
            <div class="truck-plate-wrap">${renderRussianPlate(t.number)}</div>
          </div>
          <div class="truck-info">${infoHtml}</div>
        </div>
        <div class="action-row">
          ${arrBtn}
          <button class="btn btn-quick" ${!canEditLoad || !isA ? 'disabled' : ''} ${canEditLoad && isA ? `onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''}>${loadBtnTxt}</button>
          <button class="btn btn-ttn ${ttn ? 'active-ttn' : ''}" ${!canEditTtn ? 'disabled' : ''} ${canEditTtn ? `onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''}>${ttnTxt}</button>
        </div>
      </div>`;
    }).join('');

    // ===== АНИМАЦИЯ =====
    if (Object.keys(oldP).length) {
      const loadedInfo = window.__cardJustLoaded;
      const isFreshLoad = loadedInfo && (Date.now() - loadedInfo.time) < 5000;
      const loadedId = isFreshLoad ? loadedInfo.id : null;

      const arrivedInfo = window.__cardJustArrived;
      const isFreshArrival = arrivedInfo && (Date.now() - arrivedInfo.time) < 6000;
      const arrivedId = isFreshArrival ? arrivedInfo.id : null;
      const arrivedWasFaded = arrivedId ? arrivedInfo.wasFaded : false;

      const isLoadMode = !!loadedId && !arrivedId;

      const animList = [];
      c.querySelectorAll('.truck-card[data-truck-id]').forEach(card => {
        const oldTop = oldP[card.dataset.truckId];
        if (oldTop === undefined) return;
        const newTop = card.offsetTop;
        const delta = oldTop - newTop;
        const tid = card.dataset.truckId;
        if (Math.abs(delta) < 2) return;
        animList.push({
          card, delta, tid,
          isLoaded: (tid === loadedId) && delta < 0,
          isArrive: (tid === arrivedId) && delta > 0
        });
      });

      if (animList.length) {
        window.__lineAnimating = true;

        const allAfterRender = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
        allAfterRender.sort((a, b) => a.offsetTop - b.offsetTop);
        const cardFinalIdx = {};
        allAfterRender.forEach((card, idx) => { cardFinalIdx[card.dataset.truckId] = idx; });

        let masterIdx = -1;
        let maxDelay = 0;
        if (!isLoadMode) {
          const masterId = arrivedId || loadedId;
          masterIdx = masterId != null ? cardFinalIdx[masterId] : -1;
          if (masterIdx >= 0) {
            animList.forEach(({ tid }) => {
              const idx = cardFinalIdx[tid];
              if (idx != null) {
                const d = Math.abs(idx - masterIdx) * T.WAVE_MS;
                if (d > maxDelay) maxDelay = d;
              }
            });
          }
        }

        // Автоскролл
        if (arrivedId) {
          const arrivedCardEl = c.querySelector(`.truck-card[data-truck-id="${arrivedId}"]`);
          if (arrivedCardEl) {
            const rect = arrivedCardEl.getBoundingClientRect();
            const cardAbsTop = rect.top + window.scrollY;
            const headerEl = document.getElementById('mainHeader');
            const headerH = headerEl ? headerEl.offsetHeight : 0;
            const desiredScroll = Math.max(0, cardAbsTop - headerH - 16);
            const scrollDelta = desiredScroll - window.scrollY;
            if (Math.abs(scrollDelta) > 2) startSyncScroll(scrollDelta, T.ARRIVE, ANIM_EASE);
          }
        }

        animList.forEach(({ card, delta, isLoaded, isArrive }) => {
          card.style.transition = 'none';
          card.style.transform = `translateY(${delta}px)`;
          if (isLoaded) {
            card.classList.add('anim-loading');
          } else if (isArrive) {
            card.classList.add('anim-front');
            if (arrivedWasFaded) {
              card.style.opacity = '0.35';
              card.style.filter = 'grayscale(50%)';
              card.style.backgroundColor = '#131b2e';
            }
          } else {
            card.classList.add(delta > 0 ? 'anim-up' : 'anim-down');
          }
        });

        void c.offsetWidth;

        let totalDur;

        if (isLoadMode) {
          totalDur = Math.max(T.LOAD_OUT, T.LOAD_FILL) * 1000 + 300;
          requestAnimationFrame(() => {
            animList.forEach(({ card, delta, isLoaded }) => {
              if (isLoaded) {
                card.style.transition = `transform ${T.LOAD_OUT}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              } else if (delta > 0) {
                card.style.setProperty('--from-y', `${delta}px`);
                card.style.transform = '';
                card.style.animation = `gapFillFly ${T.LOAD_FILL}s ${ANIM_EASE} forwards`;
              } else {
                card.style.transition = `transform ${T.LOAD_OUT}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              }
            });
          });
        } else {
          totalDur = T.ARRIVE * 1000 + maxDelay + 300;
          animList.forEach(({ card, delta, tid, isArrive }) => {
            const idx = cardFinalIdx[tid];
            let delay = 0;
            if (masterIdx >= 0 && idx != null) delay = Math.abs(idx - masterIdx) * T.WAVE_MS;

            setTimeout(() => {
              if (isArrive) {
                card.style.setProperty('--from-y', `${delta}px`);
                card.style.transform = '';
                card.style.animation = `arriveFlyFront ${T.ARRIVE}s ${ANIM_EASE} forwards`;
                const props = [];
                if (arrivedWasFaded) {
                  props.push(`opacity ${T.ARRIVE}s ease-in-out`);
                  props.push(`filter ${T.ARRIVE}s ease-in-out`);
                  props.push(`background-color ${T.ARRIVE}s ease-in-out`);
                }
                if (props.length) card.style.transition = props.join(', ');
                if (arrivedWasFaded) {
                  card.style.opacity = '1';
                  card.style.filter = 'grayscale(0%)';
                  card.style.backgroundColor = '#1e293b';
                }
              } else {
                card.style.transition = `transform ${T.ARRIVE}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              }
            }, delay);
          });
        }

        setTimeout(() => {
          animList.forEach(({ card }) => {
            card.style.transition = '';
            card.style.transform = '';
            card.style.animation = '';
            card.style.opacity = '';
            card.style.filter = '';
            card.style.backgroundColor = '';
            card.classList.remove('anim-up', 'anim-down', 'anim-loading', 'anim-front');
          });

          const freshCards = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
          freshCards.sort((a, b) => a.offsetTop - b.offsetTop);
          const arrivedIdx2 = arrivedId ? freshCards.findIndex(cd => cd.dataset.truckId === arrivedId) : -1;

          freshCards.forEach((card, idx) => {
            let delay = 0;
            if (!isLoadMode && arrivedIdx2 >= 0) delay = Math.abs(idx - arrivedIdx2) * 40;
            setTimeout(() => {
              card.style.setProperty('--bump-dur', T.BUMP + 's');
              card.classList.add('bumping');
              setTimeout(() => card.classList.remove('bumping'), T.BUMP * 1000 + 50);
            }, delay);
          });

          if (!isLoadMode && arrivedIdx2 > 0) {
            setTimeout(() => {
              const fcs = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
              fcs.sort((a, b) => a.offsetTop - b.offsetTop);
              const firstCard = fcs[0];
              if (!firstCard) return;
              const firstRect = firstCard.getBoundingClientRect();
              const headerEl = document.getElementById('mainHeader');
              const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
              const delta = firstRect.top - (headerBottom + 12);
              if (delta < -4) {
                const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                const targetScroll = Math.max(0, Math.min(maxScroll, window.scrollY + delta));
                const actualDelta = targetScroll - window.scrollY;
                if (Math.abs(actualDelta) > 2) startSyncScroll(actualDelta, T.SETTLE, ANIM_EASE);
              }
            }, T.SETTLE_DELAY_MS);
          }

          window.__lineAnimating = false;
          window.__cardJustLoaded = null;
          window.__cardJustArrived = null;
          if (window.__linePendingRender) {
            window.__linePendingRender = false;
            window.renderLine();
          }
        }, totalDur);
      }
    }
  };

  // ===== UI в настройках =====
  function renderSpeedSettings() {
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;
    if (document.getElementById('speed-settings-block')) return;

    const block = document.createElement('div');
    block.id = 'speed-settings-block';
    block.style.cssText = 'margin-top: 20px; border-top: 2px solid var(--border); padding-top: 16px;';

    block.innerHTML = `
      <div class="settings-label" style="margin-bottom: 12px;">🎬 Скорости анимаций</div>
      <div class="speed-presets">
        <button class="btn btn-secondary speed-preset-btn" data-preset="slow">🐢<br>Медленно</button>
        <button class="btn btn-quick speed-preset-btn" data-preset="normal">🚀<br>Обычно</button>
        <button class="btn btn-secondary speed-preset-btn" data-preset="fast">⚡<br>Быстро</button>
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Общая скорость</span>
          <span class="speed-value" id="sv-overall">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-overall">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Заполнение пустоты (погрузка)</span>
          <span class="speed-value" id="sv-fill">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-fill">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Дрожание перед действием</span>
          <span class="speed-value" id="sv-shake">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-shake">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Волна домино (приехал)</span>
          <span class="speed-value" id="sv-wave">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-wave">
      </div>

      <button class="btn btn-secondary btn-small" style="width: 100%; margin-top: 12px;" id="speed-reset">↺ Сбросить по умолчанию</button>
    `;

    modalBody.appendChild(block);

    const setVal = (key, val) => {
      const sl = document.getElementById('sl-' + key);
      const sv = document.getElementById('sv-' + key);
      if (sl) sl.value = val;
      if (sv) sv.textContent = val.toFixed(1) + '×';
    };

    const init = loadSpeeds();
    setVal('overall', init.overall);
    setVal('fill', init.fill);
    setVal('shake', init.shake);
    setVal('wave', init.wave);

    ['overall', 'fill', 'shake', 'wave'].forEach(key => {
      const sl = document.getElementById('sl-' + key);
      if (!sl) return;
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        const cur = loadSpeeds();
        cur[key] = v;
        saveSpeeds(cur);
        document.getElementById('sv-' + key).textContent = v.toFixed(1) + '×';
      });
    });

    block.querySelectorAll('.speed-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        let v = 1;
        if (p === 'slow') v = 1.6;
        else if (p === 'fast') v = 0.7;
        saveSpeeds({ overall: v, fill: v, shake: v, wave: v });
        ['overall', 'fill', 'shake', 'wave'].forEach(k => setVal(k, v));
        if (window.showToastEl) window.showToastEl('✅ Пресет применён', false);
      });
    });

    const resetBtn = document.getElementById('speed-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        saveSpeeds({ ...DEFAULTS });
        ['overall', 'fill', 'shake', 'wave'].forEach(k => setVal(k, 1));
        if (window.showToastEl) window.showToastEl('↺ Сброшено', false);
      });
    }
  }

  const origOpenSettings = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpenSettings) origOpenSettings();
    setTimeout(renderSpeedSettings, 60);
  };
})();