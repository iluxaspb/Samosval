  function exportBackupFile() {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    try { let data = { exportedAt: Date.now(), version: 2.88, trucks: state.trucks, objects: state.objects, archive: state.archive }; let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); let url = URL.createObjectURL(blob); let a = document.createElement('a'); a.href = url; a.download = 'trucks_backup_' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url); showToastEl('Бэкап скачан', false); }
    catch(e) { showError(e.message); }
  }
  async function importBackupFile(ev) {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const sections = [['trucks', refs.trucks], ['objects', refs.objects], ['archive', refs.archive]];
      if (!data || typeof data !== 'object' || !sections.some(([name]) => Array.isArray(data[name]))) {
        throw new Error('Файл не похож на резервную копию программы');
      }
      for (const [name] of sections) {
        if (data[name] !== undefined && !Array.isArray(data[name])) throw new Error('Неверный раздел: ' + name);
      }
      const counts = sections.map(([name]) => name + ': ' + (data[name] || []).length).join('\\n');
      if (!(await appConfirm('Импорт добавит или обновит записи по ID, но не удалит существующие.\\n' + counts + '\\nПродолжить?'))) return;
      if(isNasRuntime()){
        await Promise.all([refreshNasObjects(),refreshNasArchive()]);const items=[];
        for(const [collection] of sections)for(const raw of data[collection]||[]){
          if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Некорректная запись: '+collection);
          const id=raw.id?String(raw.id):'import_'+crypto.randomUUID().replaceAll('-','');const {id:_,revision,...payload}=raw;
          const existing=(collection==='archive'?state.archive:collection==='trucks'?state.trucks:state.objects).find(r=>r.id===id);
          items.push({collection,recordId:id,expectedRevision:existing?.revision||0,data:payload});
        }
        if(!items.length)throw Error('Резервная копия пуста');const result=await nasBusinessCommand('auxiliary','backup',{type:'backup.import',items});await Promise.all([refreshNasObjects(),refreshNasArchive(),nasRefreshLine()]);showToastEl('Импорт завершён. Записей обработано: '+result.result.written,false);return;
      }
      let batch = db.batch(), pending = 0, written = 0;
      for (const [name, ref] of sections) {
        for (const item of (data[name] || [])) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Некорректная запись: ' + name);
          const id = item.id ? String(item.id) : ref.doc().id;
          const copy = Object.assign({}, item);
          delete copy.id;
          batch.set(ref.doc(id), copy, { merge: true });
          pending++;
          if (pending >= 400) { await tfAwait(batch.commit()); written += pending; batch = db.batch(); pending = 0; }
        }
      }
      if (pending) { await tfAwait(batch.commit()); written += pending; }
      showToastEl('Импорт завершён. Записей обработано: ' + written, false);
    } catch(e) { showError('Ошибка импорта: ' + e.message); }
    finally { ev.target.value = ''; }
  }

  // === СМЕНЫ ===
  let startShiftInFlight=false;
