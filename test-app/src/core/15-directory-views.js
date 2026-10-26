  // === СЕЛЕКТОР ===
  function renderSelectorList() {
    let q = (document.getElementById('truckSearchInput').value||'').toLowerCase();
    let c = document.getElementById('selectorListContainer');
    let f = state.trucks.filter(t=>(t.brand+' '+t.number).toLowerCase().includes(q));
    let on = new Set(getActiveLineIds());
    let html = '';
    if(!f.length) {
      html += `<div class="empty-state">Ничего не найдено</div>`;
      if(q.length > 1) { html += `<div class="form-card" style="margin-top: 10px; border-color: var(--primary);"><div style="font-size: 14px; font-weight: 700; margin-bottom: 10px; color: var(--primary);">Добавить в базу и на линию:</div><div class="form-group"><input type="text" id="quickAddBrand" class="form-control" placeholder="Марка авто (напр. КАМАЗ)"></div><div class="form-group"><input type="text" id="quickAddNumber" class="form-control" placeholder="Госномер" value="${escapeHtml(q)}"></div><div class="form-group"><select id="quickAddType" class="form-control"><option value="regular">🚛 Обычный</option><option value="gai">🛣 ГАИ</option></select></div><div class="form-group" id="quickAddVolGroup"><input type="number" step="0.5" id="quickAddVol" class="form-control" placeholder="Объем кузова" value="20"></div><button class="btn btn-quick" style="width: 100%;" onclick="quickAddTruckToLine()">➕ Создать и выбрать</button></div>`; }
    } else {
      html += f.map(t=>{ let isO = on.has(t.id); let gaiTag = t.isGAI ? '<span style="font-size:10px;background:rgba(148,163,184,0.2);color:#cbd5e1;padding:1px 4px;border-radius:4px;margin-left:4px;">ГАИ</span>' : ''; let btn = hasPermission('edit_line') ? `<button class="btn btn-small ${isO?'btn-danger':'btn-quick'}" onclick="toggleLineTruck('${t.id}')">${isO?'Убрать':'Добавить'}</button>` : (isO?'✓':''); return `<div class="selector-item"><div><b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)} ${gaiTag}</div>${btn}</div>`; }).join('');
    }
    c.innerHTML = html;
    let typeSelect = document.getElementById('quickAddType'); if(typeSelect) { typeSelect.addEventListener('change', (e) => { document.getElementById('quickAddVolGroup').style.display = e.target.value === 'gai' ? 'none' : 'block'; }); }
  }
  async function quickAddTruckToLine() {
    if(!requireEdit('manage_trucks') || !requireEdit('edit_line')) return;
    let brand = document.getElementById('quickAddBrand').value.trim();
    let num = document.getElementById('quickAddNumber').value.trim();
    let type = document.getElementById('quickAddType').value;
    let vol = parseFloat(document.getElementById('quickAddVol').value) || 0;
    let isGAI = type === 'gai';
    if(!brand || !num) { showError('Заполните марку и номер'); return; }
    try { let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); await addTruckToLine(r.id); document.getElementById('truckSearchInput').value = ''; renderSelectorList(); }
    catch(e) { showError(e.message); }
  }
  function openSelectorModal() { if(!requireEdit('edit_line') || !state.shift) return; const search=document.getElementById('truckSearchInput');if(search)search.value=''; document.getElementById('selectorModal').classList.add('open'); renderSelectorList(); }
  function closeSelectorModal() { document.getElementById('selectorModal').classList.remove('open'); }
  async function toggleLineTruck(id) { if(!requireEdit('edit_line')) return; if(getActiveLineIds().includes(id)) await removeTruckFromLine(id); else await addTruckToLine(id); renderSelectorList(); }

  function renderGlobalTrucksManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalTrucksManageList'); if(!c) return; let e = hasPermission('manage_trucks');
    c.innerHTML = state.trucks.map(t=>{ let gaiTag = t.isGAI ? '<span style="font-size:10px;background:rgba(148,163,184,0.2);color:#cbd5e1;padding:2px 4px;border-radius:4px;margin-left:8px;">ГАИ</span>' : ''; let volText = t.isGAI ? '' : `(${t.defaultVol}м³)`; return `<div class="log-item"><div><b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)} ${volText} ${gaiTag}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalTruck('${t.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalTruck('${t.id}')">X</button></div>`:''}</div>`; }).join('');
  }
  function renderGlobalObjectsManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalObjectsManageList'); if(!c) return; let e = hasPermission('manage_objects');
    c.innerHTML = state.objects.map(o=>`<div class="log-item"><div>${escapeHtml(o.name)}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalObject('${o.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalObject('${o.id}')">X</button></div>`:''}</div>`).join('');
  }
  function switchBaseSubTab(n) {
    document.getElementById('subBtnTrucks').style.background = n==='trucks'?'var(--primary)':'var(--border)';
    document.getElementById('subBtnObjects').style.background = n==='objects'?'var(--primary)':'var(--border)';
    document.getElementById('subtab-trucks').style.display = n==='trucks'?'block':'none';
    document.getElementById('subtab-objects').style.display = n==='objects'?'block':'none';
  }

