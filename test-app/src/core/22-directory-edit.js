  // === БАЗА САМОСВАЛОВ И ОБЪЕКТОВ ===
  async function saveTruckToGlobalBase() {
    if (!requireEdit('manage_trucks')) return;
    let id = document.getElementById('editTruckId').value;
    let brand = document.getElementById('newTruckBrand').value.trim();
    let num = document.getElementById('newTruckNumber').value.trim();
    let vol = parseFloat(document.getElementById('newTruckVol').value);
    let type = document.getElementById('newTruckType').value;
    let isGAI = type === 'gai';
    if (!brand || !num) { appNotice('Заполните марку и госномер'); return; }
    if (!isGAI && (isNaN(vol) || vol <= 0)) { appNotice('Укажите объем'); return; }
    try {
      if (id) { await tfAwait(refs.trucks.doc(id).update({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, updatedAt: Date.now() })); addAudit(`Обновлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('✏️ Обновлено', false); }
      else { let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); addAudit(`Добавлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('➕ Добавлено', false); }
      cancelEditTruck();
    } catch(e) { showError(e.message); }
  }
  function editGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t) return;
    document.getElementById('editTruckId').value=t.id; document.getElementById('newTruckType').value=t.isGAI?'gai':'regular';
    document.getElementById('newTruckBrand').value=t.brand; document.getElementById('newTruckNumber').value=t.number; document.getElementById('newTruckVol').value=t.defaultVol||'';
    document.getElementById('formCardTitle').textContent='Редактировать'; document.getElementById('saveTruckBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditBtn').style.display='block'; window.scrollTo(0,0); toggleVolInput();
  }
  function cancelEditTruck() {
    document.getElementById('editTruckId').value=''; document.getElementById('newTruckType').value='regular'; document.getElementById('newTruckBrand').value=''; document.getElementById('newTruckNumber').value=''; document.getElementById('newTruckVol').value='';
    document.getElementById('formCardTitle').textContent='Добавить самосвал'; document.getElementById('saveTruckBtn').textContent='➕ Добавить'; document.getElementById('cancelEditBtn').style.display='none'; toggleVolInput();
  }
  function toggleVolInput() { document.getElementById('volumeGroup').style.display = document.getElementById('newTruckType').value === 'gai' ? 'none' : 'block'; }
  async function deleteGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t || !(await appConfirm('Удалить?'))) return;
    try { let b=db.batch(); b.delete(refs.trucks.doc(id)); b.delete(refs.truckStatus.doc(id)); await tfAwait(b.commit()); await addAudit('🗑 Удалён самосвал: ' + t.brand + ' ' + t.number, {eventType:'truck_delete',truckId:id}); } catch(e){ showError(e.message); }
  }
  async function saveObjectToBase() {
    if (!requireEdit('manage_objects')) return;
    let id = document.getElementById('editObjectId').value, name = document.getElementById('newObjectNameBase').value.trim();
    if (!name) { appNotice('Введите имя'); return; }
    try { if (id) await tfAwait(refs.objects.doc(id).update({ name, updatedAt: Date.now() })); else await tfAwait(refs.objects.doc().set({ name, createdAt: Date.now(), createdBy: getUserName() })); await addAudit((id ? '✏️ Изменён объект: ' : '➕ Создан объект: ') + name, {eventType:id ? 'object_edit' : 'object_create'}); cancelEditObject(); showToastEl('Сохранено', false); }
    catch(e){ showError(e.message); }
  }
  function editGlobalObject(id) { if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o) return; document.getElementById('editObjectId').value=o.id; document.getElementById('newObjectNameBase').value=o.name; document.getElementById('formObjectCardTitle').textContent='Редактировать'; document.getElementById('saveObjectBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditObjectBtn').style.display='block'; window.scrollTo(0,0); }
  function cancelEditObject() { document.getElementById('editObjectId').value=''; document.getElementById('newObjectNameBase').value=''; document.getElementById('formObjectCardTitle').textContent='Добавить объект'; document.getElementById('saveObjectBtn').textContent='➕ Добавить'; document.getElementById('cancelEditObjectBtn').style.display='none'; }
  async function deleteGlobalObject(id) {
    if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o || !(await appConfirm('Удалить?'))) return;
    try { await tfAwait(refs.objects.doc(id).delete()); await addAudit('🗑 Удалён объект: ' + o.name, {eventType:'object_delete',targetObjectId:id}); } catch(e){ showError(e.message); }
  }

