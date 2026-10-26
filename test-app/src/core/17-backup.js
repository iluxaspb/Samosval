  async function exportBackupFile() {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    try {
      if (!window.SamosvalBackup) throw new Error('Модуль полной резервной копии ещё не готов');
      const data = await window.SamosvalBackup.exportFileData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url;
      a.download = 'samosval_backup_' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToastEl('Бэкап скачан: база, табель и полный аудит. Фото и локальные очереди НЕ включены.', false);
    } catch(e) { showError('Экспорт не выполнен: ' + e.message); }
  }
  async function importBackupFile(ev) {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      if (!window.SamosvalBackup) throw new Error('Модуль безопасного импорта ещё не готов');
      const result = await window.SamosvalBackup.importRows(JSON.parse(await file.text()));
      if (result) showToastEl('Импорт базы/архива завершён. Записей: ' + result.written + '. Защитная копия: ' + result.safetyId, false);
    } catch(e) { showError('Ошибка импорта: ' + e.message); }
    finally { ev.target.value = ''; }
  }
