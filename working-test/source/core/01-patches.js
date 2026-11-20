  // === ПАТЧИ (слой удалён в 1.7.10) ===
  // Живой функционал встроенных патчей перенесён в features/ (undo-redo,
  // analytics-v2, reset-hold, pretty-confirm, ticker-name, nav-sort,
  // fix-log-delete, anim-speeds, admin-compact). Пользовательские патчи из
  // коллекции auxiliary больше не исполняются: eval-патчи были механизмом
  // доставки правок до появления модульной сборки. Функции остаются
  // совместимыми заглушками — их вызывают 21-nas-runtime и reset-settings.
  async function loadAndApplyPatches() {
    if(isNasRuntime())return refreshNasAuxiliary();
    return;
  }

  function applyAllPatches() {
    // Патчи не применяются: функциональность вшита в модули features/.
    return;
  }

  function renderPatchesList() {
    // Вкладка «🔧 Патчи» удалена из админки вместе со слоем патчей.
    return;
  }
