import { bindEquipmentOwnership } from "./catalog.mjs";
import { colorField, bindColorFields } from "./color-palette.mjs";
import * as R from "./request-domain.mjs";
import { arrivals } from "./line.mjs";
import * as D from "./table-domain.mjs";
import { Store, firestoreRemote } from "./store.mjs";
import { esc, btn, input, field, dialog, message, error } from "./messages.mjs";
import { sheetVisible, sheetManager } from "./sheet-access.mjs";
import { autoConflicts } from "./conflict-view.mjs";
import { historyRows } from "./history-view.mjs";
import { preferredObjectId, lastClosedKey } from "./object-default.mjs";
const areas = [
  "request",
  "shift",
  "table",
  "settings",
  "report",
  "history",
  "permissions",
];
export async function mount(ctx, container, { remoteEnabled = false } = {}) {
  const host = ctx.ledgerHost,
    session = host.session();
  if (session.projectId !== "samosval-offline")
    throw Error("Только тестовая среда");
  if (!document.querySelector("[data-tabel-v2-css]")) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = new URL("./workspace.css", import.meta.url);
    l.dataset.tabelV2Css = "";
    document.head.append(l);
  }
  const root = document.createElement("section");
  root.className = "tn tn-app";
  container.append(root);
  const s = {
    ctx,
    host,
    root,
    object: null,
    shiftTab: "equipment",
    requestLocked: !!host.requestObjectId,
    view: host.requestObjectId ? "request" : "shift",
    day: D.today(),
    shift: "day",
    generation: 0,
    grid: null,
  };
  const account = () => {
    const a = host.session();
    if (a.uid !== session.uid || a.status !== "active" || !a.tabAccess)
      throw Error("Доступ изменился. Откройте расширение заново.");
    return a;
  };
  const guard = (job) => {
    const stripped = (x) => {
      const y = D.copy(x || {});
      delete y.request;
      return y;
    };
    const requestOnly =
      job.before?.data &&
      JSON.stringify(stripped(job.before.data)) ===
        JSON.stringify(stripped(job.data));
    const area = job.key.endsWith("/config")
      ? requestOnly
        ? "request"
        : "settings"
      : job.key.includes("/sheet:")
        ? "table"
        : "shift";
    const c = s.store.get(job.key.split("/")[0] + "/config").data;
    const a = account();
    const sheetId = job.key.includes("/sheet:")
      ? job.key.split("/sheet:")[1]
      : job.key.includes("/day:")
        ? "linked"
        : null;
    if (sheetId && !sheetVisible(a, c, sheetId))
      throw Error("Нет доступа к листу");
    if (
      !sheetManager(a) &&
      job.key.endsWith("/config") &&
      JSON.stringify(job.data.sheetAccess || {}) !==
        JSON.stringify(job.before?.data?.sheetAccess || {})
    )
      throw Error("Доступ к листам настраивает прораб или администратор");
    if (!D.allowed(a, c, area, "edit"))
      throw Error("Нет права записи: " + area);
  };
  s.remote = remoteEnabled ? firestoreRemote(host, guard) : null;
  s.store = await new Store(
    session.projectId + "_" + session.workspaceId + "_" + session.uid,
    s.remote,
    () => ({ uid: account().uid, name: account().name }),
  ).open();
  // Consent is only for this tab visit, not persistent user data.
  s.foreignWriteConsents = new Set();
  s.confirmForeignWrite = async (targetId = s.object?.id, targetLabel = "") => {
    const active = host.data().shift;
    if (!active?.isActive || !active.objectId || !targetId || active.objectId === targetId) return;
    const key = JSON.stringify([active.id, active.objectId, targetId]);
    if (s.foreignWriteConsents.has(key)) return;
    const objects = host.data().objects || [];
    const activeName = objects.find((o) => o.id === active.objectId)?.name || active.objectName || active.objectId;
    const otherName = targetLabel || objects.find((o) => o.id === targetId)?.name || s.object?.name || targetId;
    const accepted = await new Promise((resolve) => {
      const confirm = dialog(
        "Изменение другого адреса",
        "<p>Активная смена на вкладке «Линия» сейчас открыта по адресу <b>" +
          esc(activeName) + "</b>.</p><p>Вы точно хотите изменить данные по другому адресу <b>" +
          esc(otherName) + "</b>?</p>",
        async () => { resolve(true); },
      );
      confirm.querySelector('[type="submit"]').textContent = "Да";
      const no = confirm.querySelector('footer [data-action="close"]');
      if (no) no.textContent = "Нет";
      confirm.addEventListener("close", () => resolve(false), { once: true });
    });
    if (!accepted) throw Error("Изменение другого адреса отменено.");
    const latest = host.data().shift;
    if (!latest || latest.id !== active.id || latest.objectId !== active.objectId || !latest.isActive) {
      return s.confirmForeignWrite(targetId, targetLabel);
    }
    s.foreignWriteConsents.add(key);
  };
  // Central protection: all table, shift, request, settings and catalog writes
  // pass through Store.save; explicit conflict resolution also changes records.
  const storeSave = s.store.save.bind(s.store);
  s.store.save = async (key, ...args) => {
    const targetId = key.startsWith("_") ? s.object?.id : key.split("/")[0];
    await s.confirmForeignWrite(targetId);
    return storeSave(key, ...args);
  };
  const storeResolve = s.store.resolve.bind(s.store);
  s.store.resolve = async (id, choice) => {
    const job = s.store.state.jobs.find((j) => j.id === id);
    if (job) await s.confirmForeignWrite(job.key.startsWith("_") ? s.object?.id : job.key.split("/")[0]);
    return storeResolve(id, choice);
  };
  s.key = (suffix) => s.object.id + "/" + suffix;
  s.config = () => {
    const stored = s.store.get(s.key("config")).data,
      defaults = s.store.get("_defaults/config").data;
    const c =
        stored ||
        (defaults
          ? {
              ...D.config(s.object),
              equipment: D.copy(defaults.equipment || []),
              people: D.copy(defaults.people || []),
              request: {
                ...D.config(s.object).request,
                ...D.copy(defaults.request),
                date: D.add(D.today(), 1),
              },
            }
          : D.config(s.object)),
      catalog = s.store.get("_catalog/config").data || {
        equipment: [],
        people: [],
      };
    c.equipment = [
      ...new Map(
        [
          ...(host.catalog?.equipment || []),
          ...c.equipment,
          ...(catalog.equipment || []),
        ].map((e) => [e.id, e]),
      ).values(),
    ];
    c.people = [
      ...new Map(
        [
          ...(host.catalog?.people || []),
          ...c.people,
          ...(catalog.people || []),
        ].map((e) => [e.id, e]),
      ).values(),
    ];
    if (!c.equipment.some(D.isWater))
      c.equipment.push({
        id: "builtin-water",
        name: "Поливомоечная",
        kind: "water",
        ownership: "own",
        pump: false,
      });
    c.equipment = c.equipment
      .filter((e) => !e.deleted && !(c.hiddenEquipmentIds || []).includes(e.id))
      .map((e) => ({
        ...e,
        pump: D.isWater(e) && e.ownership !== "hired" && !!e.pump,
      }));
    c.people = c.people.filter((p) => !p.deleted);
    for (const key of ["works", "materials", "contractors"]) {
      const deleted = new Set(
        (catalog[key] || []).filter((x) => x.deleted).map((x) => x.id),
      );
      c[key] = (c[key] || []).filter((x) => !x.deleted && !deleted.has(x.id));
    }
    // Keep the catalog as the single source of truth for a renamed address.
    // The stored config may have a stale name from the first application.
    const currentName = (host.data().objects || []).find(o => o.id === s.object?.id)?.name;
    c.name = currentName || s.object?.name || c.name;
    return c;
  };
  s.require = (area, mode = "view") => {
    if (
      ["shift", "history", "report"].includes(area) &&
      !sheetVisible(account(), s.config(), "linked")
    )
      throw Error(
        "Нет доступа к основному листу табеля. Обратитесь к прорабу или администратору.",
      );
    if (!D.allowed(account(), s.config(), area, mode))
      throw Error("Нет права: " + area + "." + mode);
  };
  s.sheetVisible = (id) => sheetVisible(account(), s.config(), id);
  s.sheetManager = () => sheetManager(account());
  s.save = async (key, data, base, label, area = "shift") => {
    s.require(area, "edit");
    const id = key.includes("/sheet:")
      ? key.split("/sheet:")[1]
      : key.includes("/day:")
        ? "linked"
        : null;
    if (id && !s.sheetVisible(id)) throw Error("Нет доступа к листу");
    const ok = await s.store.save(key, data, base, label);
    // A conflict is already durable; the automatic comparison dialog handles it.
    if (!ok) {
      s.conflictUI?.check();
      return;
    }
    if (area === "shift" && key.includes("/day:")) {
      const sheetKey = s.key("sheet:linked"),
        sheetBase = s.store.get(sheetKey);
      if (sheetBase.data) {
        const next = D.copy(sheetBase.data);
        let changed = false;
        for (const row of D.rows(s.config(), [data]))
          if (row.kind && !row.section) {
            const id = row.id + "|" + D.dayKey(data.date, data.shift);
            if (
              next.cells[id]?.raw &&
              D.value(row, data) !== D.value(row, base.data)
            ) {
              delete next.cells[id].raw;
              changed = true;
            }
          }
        if (changed)
          await s.store.save(
            sheetKey,
            next,
            sheetBase,
            "Ручной ввод вместо формулы",
          );
      }
    }
    void s.store.flush();
  };
  s.rawDays = () =>
    s.store
      .list(s.key("day:"))
      .filter((r) => r.data && !r.data.deleted)
      .map((r) => r.data)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift),
      );
  s.days = () =>
    D.linkedFormulaDays(
      s.config(),
      s.rawDays(),
      s.store.get(s.key("sheet:linked")).data,
      new Set(
        s.store
          .list(s.key("day:"))
          .filter((r) => r.data?.deleted)
          .map((r) => r.data.date),
      ),
    );
  s.saveConfig = async (c, base, area = "settings") =>
    s.save(s.key("config"), c, base, "Настройки / заявка", area);
  s.refresh = () => render(s);
  s.addEquipment = () => addEquipment(s);
  s.addPerson = (group) => addPerson(s, group);
  s.openSettings = () =>
    import("./settings-menu.mjs").then((m) => m.openSettings(s));
  s.addDefinition = (kind) =>
    import("./catalog.mjs").then((m) => m.addDefinition(s, kind));
  s.addDay = () => addDay(s);
  s.composition = (group) => composition(s, group);
  s.editValue = async (row, d, raw) => {
    const key = s.key(D.dayKey(d.date, d.shift)),
      base = s.store.get(key),
      next = base.data
        ? D.copy(base.data)
        : D.createDay(s.config(), d.date, d.shift);
    if (
      row.kind !== "value" &&
      !next[row.kind].some((e) => e.id === row.entity)
    )
      throw Error(
        "Сначала добавьте эту технику или человека в состав выбранного дня",
      );
    D.setValue(row, next, raw);
    await s.save(
      key,
      next,
      base,
      "Таблица: " + row.name + " · " + D.display(d.date),
      "table",
    );
  };
  s.root.innerHTML = "<p>Открываем новый табель…</p>";
  const selectionKey = JSON.stringify([
    "tabel-v2-last-object",
    session.projectId,
    session.workspaceId,
    session.uid,
  ]);
  let lastObject = null, lastClosed = null;
  try {
    lastObject = localStorage.getItem(selectionKey);
    lastClosed = JSON.parse(localStorage.getItem(lastClosedKey(session.projectId, session.workspaceId)) || "null");
  } catch {}
  const remember = () => {
    if (s.object)
      try {
        localStorage.setItem(selectionKey, s.object.id);
      } catch {}
  };
  s.remember = remember;
  const objects = host.data().objects || [];
  s.defaultObject = (explicitRequest = false) => {
    let recentlyClosed = null;
    try { recentlyClosed = JSON.parse(localStorage.getItem(lastClosedKey(session.projectId, session.workspaceId)) || "null"); } catch {}
    const snap = host.data();
    return (snap.objects || []).find((o) => o.id === preferredObjectId({
      objects: snap.objects, requestObjectId: explicitRequest ? host.requestObjectId : null,
      shift: snap.shift, archive: snap.archive,
      recentlyClosed, lastObject: s.object?.id || lastObject,
    })) || null;
  };
  s.object = s.defaultObject(true);
  s.status = () => {
    const target = root.querySelector("[data-status]");
    if (!target) return;
    const jobs = s.store.state.jobs;
    target.textContent =
      (s.remote
        ? navigator.onLine
          ? s.store.uploadError
            ? "Ошибка отправки Firebase"
            : jobs.some((j) => j.status === "queued")
              ? "Ожидает отправки в Firebase"
              : s.store.error
                ? "Ошибка Firebase"
                : "Firebase подключён · очередь пуста"
          : "Офлайн"
        : "На устройстве: синхронизация Firebase не включена") +
      " · локально " +
      jobs.filter((j) => j.status === "queued").length +
      " · конфликты " +
      jobs.filter((j) => j.status === "conflict").length +
      (s.store.uploadError || s.store.error
        ? " · сервер: " + (s.store.uploadError || s.store.error)
        : "") +
      (s.store.uploading ? " · отправляется " + s.store.uploading.key : "");
  };
  s.store.listeners.add(s.status);
  const updateEquipmentCounts = () => {
    if (s.root.querySelector('[data-equipment-counts]')) s.updateEquipmentCounts?.();
  };
  globalThis.addEventListener('line-equipment-change', updateEquipmentCounts);
  s.store.listeners.add(updateEquipmentCounts);
  s.conflictUI = autoConflicts(s);
  async function loadObject() {
    if (!s.object || !s.remote) return;
    await s.store.pull(s.key("config"));
    await s.store.pullObject(s.object.id);
    await s.store.pullHistory(s.object.id);
  }
  s.select = async (id) => {
    if (s.grid?.snapshot) {
      s.gridPositions ||= {};
      s.gridPositions[s.object.id] = s.grid.snapshot();
    }
    s.unwatch?.();
    s.grid?.dispose();
    s.grid = null;
    s.object = (host.data().objects || []).find((o) => o.id === id) || s.object;
    s.generation++;
    remember();
    await host.prepare?.(s.store, s.object);
    await render(s);
    void synchronize();
  };
  remember();
  await host.prepare?.(s.store, s.object);
  await render(s);
  async function synchronize() {
    if (!s.remote || s.store.closed) return;
    if (account().permissions.edit) await s.store.prepareSync();
    const object = s.object?.id;
    await s.store.pull("_catalog/config");
    await s.store.pull("_defaults/config");
    void s.store.flush();
    await loadObject();
    if (s.store.closed || s.object?.id !== object) return;
    watch();
    void s.store.flush();
    s.incoming = true;
    await refreshIncoming();
  }
  if (s.remote) void synchronize();
  async function refreshIncoming() {
    if (!s.incoming || s.root.hidden) return;
    const active = document.activeElement;
    if (
      s.gridDragging ||
      document.querySelector("dialog.tn[open]") ||
      (s.view !== "table" &&
        s.root.contains(active) &&
        active?.matches("input:not([readonly]),textarea"))
    ) {
      clearTimeout(s.incomingTimer);
      s.incomingTimer = setTimeout(() => refreshIncoming().catch(error), 1000);
      return;
    }
    s.incoming = false;
    await render(s);
  }
  function watch() {
    s.unwatch?.();
    if (!s.object || !s.remote) return;
    const token = s.object.id,
      c = s.config(),
      from = c.start > D.add(s.day, -31) ? c.start : D.add(s.day, -31),
      to = D.add(s.day, 7);
    s.unwatch = s.remote.watch(
      token,
      from,
      to,
      async (records) => {
        if (s.object.id !== token) return;
        await s.store.accept(records);
        if (s.view === "history") await s.store.pullHistory(token);
        s.incoming = true;
        await refreshIncoming();
      },
      (e) => {
        s.store.error = e.message;
        s.status();
      },
    );
  }
  watch();
  // The host Firestore object-list subscription announces object edits.
  // Defer rendering when a form/cell is actively edited to prevent lost input.
  const refreshRenamedObject = () => {
    if (!s.object) return;
    const current = (host.data().objects || []).find(o => o.id === s.object.id);
    if (!current) return;
    if (current.name !== s.object.name) {
      s.object = { ...s.object, ...current };
      s.renamePending = true;
    }
    if (!s.renamePending || root.hidden || !root.isConnected) return;
    const select = root.querySelector('[data-object]');
    const option = [...(select?.options || [])].find(o => o.value === s.object.id);
    if (option) option.textContent = s.object.name;
    const focused = document.activeElement;
    if (s.gridDragging || document.querySelector('dialog.tn[open]') ||
        (root.contains(focused) && focused?.matches('input:not([readonly]),textarea,[contenteditable="true"]'))) {
      clearTimeout(s.renameTimer);
      s.renameTimer = setTimeout(refreshRenamedObject, 500);
      return;
    }
    s.renamePending = false;
    render(s).catch(error);
  };
  globalThis.addEventListener('samosval-objects-changed', refreshRenamedObject);
  const observer = new MutationObserver(() => {
    root.hidden = !container.classList.contains("active");
  });
  observer.observe(container, { attributes: true, attributeFilter: ["class"] });
  return {
    async settings(id) {
      if (id && s.object?.id !== id) await s.select(id);
      return s.openSettings();
    },
    refresh() {
      s.incoming = true;
      return refreshIncoming();
    },
    notice(text) {
      s.store.error = text;
      s.status();
    },
    async connect() {
      if (s.store.closed) return;
      account();
      if (!s.remote) {
        s.remote = firestoreRemote(host, guard);
        s.store.remote = s.remote;
      }
      void s.store.flush();
      await synchronize();
    },
    async show() {
      account();
      root.hidden = false;
      s.foreignWriteConsents.clear();
      s.view = "shift";
      s.day = D.today();
      const preferred = s.defaultObject();
      if (preferred && preferred.id !== s.object?.id) await s.select(preferred.id);
      else if (!s.object && preferred) {
        s.object = preferred;
        await host.prepare?.(s.store, s.object);
        void synchronize();
      }
      await render(s);
      s.conflictUI.check();
    },
    async dispose() {
      s.foreignWriteConsents.clear();
      globalThis.removeEventListener('line-equipment-change', updateEquipmentCounts);
      globalThis.removeEventListener('samosval-objects-changed', refreshRenamedObject);
      clearTimeout(s.renameTimer);
      s.unwatch?.();
      observer.disconnect();
      s.conflictUI.dispose();
      s.grid?.dispose();
      document.querySelectorAll("dialog.tn").forEach((el) => el.close());
      root.remove();
      clearTimeout(s.incomingTimer);
      await s.store.close();
    },
  };
}
async function render(s) {
  // Rebuilding the shift DOM must not move the operator away from their card.
  // Scope the position to this object, date, shift and subtab; navigation resets it.
  const shiftContext = JSON.stringify([s.object?.id, s.day, s.shift, s.shiftTab]);
  const previousContent = s.root.querySelector("[data-shift-content]");
  const shiftPosition = s.view === "shift" &&
    s.root.dataset.shiftContext === shiftContext && previousContent
      ? { top: previousContent.scrollTop, left: previousContent.scrollLeft }
      : null;
  const rendering = (s.rendering = (s.rendering || 0) + 1);
  if (s.grid) await s.grid.finish?.();
  if (rendering !== s.rendering) return;
  s.remember?.();
  if (s.grid?.snapshot) {
    s.gridPositions ||= {};
    s.gridPositions[s.object.id] = s.grid.snapshot();
  }
  s.grid?.dispose();
  s.grid = null;
  const c = s.object ? s.config() : null;
  s.root.classList.toggle("tn-table", s.view === "table");
  s.root.dataset.view = s.view;
  s.root.dataset.shiftContext = s.view === "shift" ? shiftContext : "";
  s.root.innerHTML = `<header class="tn-header">${btn("×", "exit", 'class="tn-exit" aria-label="Закрыть табель"')}<select data-object aria-label="Объект" ${s.view === "request" && s.requestLocked ? "disabled" : ""}>${[...new Map([...(s.object ? [s.object] : []), ...(s.host.data().objects || [])].map((o) => [o.id, o])).values()].map((o) => `<option value="${esc(o.id)}" ${o.id === s.object?.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>${btn("＋ Объект", "object", s.view === "request" && s.requestLocked ? "disabled" : "")}${btn("⚙", "settings-menu", 'aria-label="Настройки объекта"')}</header><nav>${[
    ["request", "Заявки"],
    ["shift", "Смена"],
    ["table", "Таблица"],
    ["catalog", "Справочник"],
    ["history", "История"],
  ]
    .map(([id, label]) =>
      btn(label, "view", `data-view="${id}" aria-pressed="${s.view === id}"`),
    )
    .join(
      "",
    )}</nav><p role="alert"></p><main></main><footer class="tn-status"><span data-status></span>${btn("↻", "sync", 'aria-label="Синхронизировать"')}${btn("Конфликты", "conflicts")}</footer>`;
  s.root.querySelector(".tn-status").before(s.root.querySelector("nav"));
  s.root.querySelector("[data-action=exit]").onclick = () => {
    s.foreignWriteConsents.clear();
    s.root.hidden = true;
    s.host.leave();
  };
  s.root.querySelector("[data-action=object]").onclick = () => newObject(s);
  s.root.querySelector("[data-object]").onchange = (e) =>
    s.select(e.target.value).catch(error);
  s.root.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (b.dataset.view === "shift") s.day = D.today();
        s.view = b.dataset.view;
        if (s.view === "history" && s.object)
          await s.store.pullHistory(s.object.id);
        render(s).catch(error);
      }),
  );
  s.root.querySelector("[data-action=sync]").onclick = async () => {
    await s.store.flush();
    if (s.object) {
      await s.store.pull(s.key("config"));
      await s.store.pull("_catalog/config");
      await s.store.pull("_defaults/config");
      await s.store.pullObject(s.object.id);
      await s.store.pullHistory(s.object.id);
    }
    await render(s);
  };
  s.root.querySelector("[data-action=conflicts]").onclick = () => conflicts(s);
  bind(s.root, "settings-menu", () => s.openSettings());
  s.status();
  const main = s.root.querySelector("main");
  if (!s.object) {
    main.innerHTML = "<p>Создайте объект из заявки, чтобы начать.</p>";
    return;
  }
  try {
    s.require(
      s.view === "history"
        ? "history"
        : s.view === "catalog"
          ? "settings"
          : s.view,
    );
    if (s.view === "table") {
      const module = await import("./grid.mjs");
      if (rendering !== s.rendering || !main.isConnected) return;
      const grid = await module.mount(s, main);
      if (rendering !== s.rendering || !main.isConnected) grid.dispose();
      else s.grid = grid;
      return;
    }
    if (s.view === "request") request(s, main);
    if (s.view === "shift") await shift(s, main);
    if (s.view === "shift") {
      const counts = document.createElement("div");
      counts.className = "tn-counts";
      counts.dataset.equipmentCounts = '';
      const updateCounts = () => {
        const days = s.days().filter(d => d.date === s.day), list = days.flatMap(d => d.people);
        const snapshot = s.host.data();
        counts.innerHTML = `<span>Техника: <b>${D.equipmentCount(days, arrivals(snapshot, s.object.id, s.day).rows, s.config(), snapshot.trucks || [])}</b></span><span>Рабочие: <b>${new Set(list.filter(p => p.group === "worker").map(p => p.id)).size}</b></span><span>ИТР: <b>${new Set(list.filter(p => p.group === "itr").map(p => p.id)).size}</b></span>`;
      };
      s.updateEquipmentCounts = updateCounts;
      updateCounts();
      main.prepend(counts);
      if (rendering === s.rendering && shiftPosition) {
        const content = main.querySelector("[data-shift-content]");
        if (content) {
          content.scrollTop = shiftPosition.top;
          content.scrollLeft = shiftPosition.left;
        }
      }
    }

    if (s.view === "settings") {
      s.openSettings();
      main.innerHTML =
        "<p>Настройки объекта открываются в шести отдельных окнах.</p>";
    }
    if (s.view === "catalog")
      await (await import("./catalog.mjs")).mount(s, main);
    if (s.view === "history") history(s, main);
  } catch (e) {
    main.innerHTML = "<p>" + esc(e.message) + "</p>";
  }
}
function newObject(s) {
  dialog(
    "Новый объект",
    field("Название", input("name", "", 'required maxlength="180"')) +
      field("Начало", input("start", D.today(), 'type="date" required')),
    async (form) => {
      if (!s.host.createObject)
        throw Error("Оболочка не предоставляет создание объектов");
      const name = String(form.get("name")).trim();
      await s.confirmForeignWrite("__new__:" + name, name);
      const active = s.host.data().shift;
      const object = await s.host.createObject(name, form.get("start"));
      if (active?.isActive && s.host.data().shift?.id === active.id &&
          s.host.data().shift?.objectId === active.objectId)
        s.foreignWriteConsents.add(JSON.stringify([active.id, active.objectId, object.id]));
      s.object = object;
      const saved = s.store.get("_defaults/config").data;
      const c = saved
        ? {
            ...D.copy(saved),
            objectId: object.id,
            name: object.name,
            start: form.get("start"),
            end: "",
            acl: {},
            request: { ...saved.request, date: D.add(D.today(), 1) },
          }
        : D.config(object);
      await s.saveConfig(c, s.store.get(s.key("config")));
      await render(s);
    },
  );
}
function request(s, main) {
  const base = s.store.get(s.key("config")),
    c = s.config();
  main.innerHTML = `<form class="tn-request"><div class="tn-request-date">${field("Дата заявки", input("date", c.request.date, 'type="date" required'))}${field("Смена", `<select name="shift"><option value="day">Дневная</option><option value="night" ${c.request.shift === "night" ? "selected" : ""}>Ночная</option></select>`)}</div><div class="tn-tools">${btn("＋ Добавить технику", "choose-equipment")}${btn("＋ ИТР", "add-itr")}</div><h3>Техника в заявке</h3>${
    R.selectedEquipment(c)
      .map(
        (e) =>
          `<label class="tn-check"><input type="checkbox" name="equipment" value="${esc(e.id)}" checked>${esc(e.name)}</label>`,
      )
      .join("") || "<p>Добавьте нужную технику из справочника.</p>"
  }<section class="tn-trucks"><h3>Самосвалы</h3><div data-truck-groups></div>${btn("＋ Группа самосвалов", "truck-group")}</section><h3>ИТР</h3>${c.people
    .filter((p) => p.group === "itr")
    .map(
      (p) =>
        `<label class="tn-check"><input type="checkbox" name="people" value="${esc(p.id)}" ${c.request.people.includes(p.id) ? "checked" : ""}>${esc(p.name)}</label>`,
    )
    .join(
      "",
    )}${field("Ответственный ИТР", '<select name="responsibleId"></select>')}${field("Станция метро для развозки", input("metro", c.request.metro || "", 'autocomplete="off" placeholder="Начните вводить название"'))}<div data-stations class="tn-stations" hidden></div>${field("Время подачи развозки", input("pickupTime", c.request.pickupTime || "07:00", 'type="time"'))}${field("Примечание к заявке", input("note", c.request.note))}<button type="submit">Сохранить заявку</button></form><div class="tn-tools">${btn("Поделиться заявкой", "send-request")}${btn("Заказ обеда", "lunch")}${btn("Отправить отчёт", "report")}${btn("Начать / добавить смену", "add-day")}</div><p class="tn-hint">Рабочие учитываются в табеле. В заявке выбираются техника и ИТР.</p>`;
  const form = main.querySelector("form"),
    select = form.elements.responsibleId;
  const groupRoot = form.querySelector("[data-truck-groups]");
  function addTruckGroup(g = { count: 1, mode: "local", trips: 1 }) {
    const row = document.createElement("div");
    row.className = "tn-truck-group";
    row.innerHTML =
      field(
        "Количество самосвалов",
        input(
          "truckCount",
          g.count,
          'type="number" min="1" max="10000" required',
        ),
      ) +
      field(
        "Тип",
        `<select name="truckMode"><option value="local">По месту</option><option value="central" ${g.mode === "central" ? "selected" : ""}>Централизация</option></select>`,
      ) +
      `<div data-central>${field("Рейсы на каждый", input("truckTrips", g.trips || 1, 'type="number" min="1" max="1000"'))}<output data-truck-total></output></div>` +
      btn("× Убрать", "remove-group");
    const update = () => {
      const central = row.querySelector("[name=truckMode]").value === "central";
      row.querySelector("[data-central]").hidden = !central;
      row.querySelector("[name=truckTrips]").required = central;
      row.querySelector("[name=truckTrips]").disabled = !central;
      row.querySelector("[data-truck-total]").textContent =
        `${Number(row.querySelector("[name=truckCount]").value) * Number(row.querySelector("[name=truckTrips]").value) * 40} тонн · 40 т/рейс`;
    };
    row.oninput = update;
    row.onchange = update;
    row.querySelector("[data-action=remove-group]").onclick = () =>
      row.remove();
    groupRoot.append(row);
    update();
  }
  (c.request.trucks || []).forEach(addTruckGroup);
  bind(main, "truck-group", () => addTruckGroup());
  const updateResponsible = () => {
    const id = select.value || c.request.responsibleId;
    const ids = new FormData(form).getAll("people");
    const people = c.people.filter(
      (p) => p.group === "itr" && ids.includes(p.id),
    );
    select.innerHTML =
      '<option value="">Выберите ответственного</option>' +
      people
        .map(
          (p) =>
            `<option value="${esc(p.id)}" ${p.id === id || people.length === 1 ? "selected" : ""}>${esc(p.name)}</option>`,
        )
        .join("");
  };
  form
    .querySelectorAll("[name=people]")
    .forEach((el) => (el.onchange = updateResponsible));
  updateResponsible();
  const metro = form.elements.metro,
    results = main.querySelector("[data-stations]");
  metro.oninput = () => {
    results.hidden = false;
    results.innerHTML =
      R.searchStations(metro.value)
        .map((name) => btn(esc(name), "station", `data-name="${esc(name)}"`))
        .join("") || "<p>Станция не найдена</p>";
    results.querySelectorAll("button").forEach(
      (b) =>
        (b.onclick = () => {
          metro.value = b.dataset.name;
          results.hidden = true;
        }),
    );
  };
  metro.onfocus = metro.oninput;
  async function saveRequest() {
    const f = new FormData(form),
      next = D.copy(c);
    next.request = {
      ...next.request,
      equipment: f.getAll("equipment"),
      people: f.getAll("people"),
      responsibleId: f.get("responsibleId"),
      metro: String(f.get("metro")).trim(),
      pickupTime: f.get("pickupTime"),
      date: D.date(f.get("date")),
      shift: f.get("shift"),
      note: f.get("note"),
    };
    next.request.trucks = R.truckGroups(
      [...groupRoot.children].map((row) => ({
        count: row.querySelector("[name=truckCount]").value,
        mode: row.querySelector("[name=truckMode]").value,
        trips: row.querySelector("[name=truckTrips]").value,
      })),
    );
    if (next.request.metro && !R.stations.includes(next.request.metro))
      throw Error("Выберите станцию метро из списка");
    await s.saveConfig(next, base, "request");
    await s.store.save(
      "_defaults/config",
      next,
      s.store.get("_defaults/config"),
      "Последний состав заявки",
    );
    return next;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await saveRequest();
      await render(s);
    } catch (e) {
      error(e);
    }
  };
  bind(main, "choose-equipment", () => {
    const el = dialog(
      "Техника из справочника",
      '<input data-search placeholder="Поиск техники">' +
        c.equipment
          .map(
            (e) =>
              `<label class="tn-check"><input type="checkbox" name="equipment" value="${esc(e.id)}" ${new FormData(form).getAll("equipment").includes(e.id) ? "checked" : ""}>${esc(e.name)}</label>`,
          )
          .join("") +
        btn("＋ Новая техника", "new-equipment"),
      async (f) => {
        form.querySelectorAll("[name=equipment]").forEach((x) => x.remove());
        for (const id of f.getAll("equipment")) {
          const x = document.createElement("input");
          x.type = "hidden";
          x.name = "equipment";
          x.value = id;
          form.append(x);
        }
        await saveRequest();
        await render(s);
      },
    );
    el.querySelector("[data-search]").oninput = (e) =>
      el
        .querySelectorAll(".tn-check")
        .forEach(
          (row) =>
            (row.hidden = !row.textContent
              .toLowerCase()
              .includes(e.target.value.toLowerCase())),
        );
    bind(el, "new-equipment", () => {
      el.close();
      addEquipment(s);
    });
  });
  bind(main, "add-itr", () => addPerson(s, "itr"));
  bind(main, "add-day", s.addDay);
  bind(main, "report", () => dailyReport(s));
  bind(main, "defaults", () =>
    dialog(
      "Состав новых объектов",
      "<p>Сохранить состав этой заявки для новых объектов?</p>",
      async () => {
        await saveRequest();
        s.require("settings", "edit");
        await s.store.save(
          "_defaults/config",
          s.config(),
          s.store.get("_defaults/config"),
          "Шаблон нового объекта",
        );
      },
    ),
  );
  bind(main, "send-request", async () => {
    const next = await saveRequest();
    await render(s);
    message(
      "Заявка",
      `Заявка на ${D.display(next.request.date)}\nОбъект: ${next.name}\nСмена: ${next.request.shift === "night" ? "ночная" : "дневная"}\nТехника:\n${
        R.selectedEquipment(next)
          .map((e) => "— " + e.name)
          .join("\n") || "не выбрана"
      }${next.request.trucks?.length ? "\n" + R.trucksText(next.request.trucks) : ""}\nИТР:\n${
        R.selectedITR(next)
          .map((p) => "— " + p.name)
          .join("\n") || "не выбраны"
      }\nМетро: ${next.request.metro || "не выбрано"}\nРазвозка к: ${next.request.pickupTime || "не указано"}\n${next.request.note}`,
    );
  });
  bind(main, "lunch", async () => {
    const next = await saveRequest();
    await render(s);
    const x = R.lunch(next, s.object);
    const el = dialog(
      "Заказ обеда",
      `<p>Адрес: ${esc(x.address)}</p><div data-lunch-rows></div>${field("Количество рабочих", input("workers", 0, 'type="number" inputmode="numeric" min="0" max="10000" step="1"'))}<label class="tn-check"><input name="mechanic" type="checkbox">Слесарь</label><label class="tn-check"><input name="spare" type="checkbox">Запасной обед</label><p>Всего: <b data-total></b></p><p>Ответственный: ${esc(x.person?.name || "не выбран")}</p><p>Телефон: ${esc(x.phone || "Добавьте номер в справочник ИТР")}</p>`,
      async (f) => {
        if (!x.person) throw Error("Выберите ответственного ИТР в заявке");
        if (!x.phone)
          throw Error("Добавьте телефон ответственного в справочник ИТР");
        message(
          "Заказ обеда",
          R.lunchText(next, s.object, D.display(next.request.date), {
            mechanic: f.has("mechanic"),
            spare: f.has("spare"),
            workers: f.get("workers"),
          }),
        );
      },
    );
    const update = () => {
      const f = new FormData(el.querySelector("form")),
        result = R.lunch(next, s.object, {
          mechanic: f.has("mechanic"),
          spare: f.has("spare"),
          workers: f.get("workers"),
        });
      el.querySelector("[data-lunch-rows]").innerHTML = result.rows
        .map((row) => `<p>${esc(row.name)} — ${row.count} чел.</p>`)
        .join("");
      el.querySelector("[data-total]").textContent = result.total;
    };
    el.querySelectorAll("input").forEach(
      (i) =>
        (i.oninput = () => {
          try {
            update();
            el.querySelector("[role=alert]").textContent = "";
          } catch (e) {
            error(e);
          }
        }),
    );
    update();
    el.querySelector("[type=submit]").textContent = "Подготовить текст";
  });
}

function bind(root, action, fn) {
  root
    .querySelector("[data-action=" + action + "]")
    ?.addEventListener("click", () => Promise.resolve().then(fn).catch(error));
}
function addEquipment(s) {
  const el = dialog(
    "Добавить технику в базу",
    field("Контрагент (для наёмной)", input("contractor")) +
      field("Название", input("name", "", "required")) +
      field("Госномер / устойчивый номер", input("plate")) +
      field(
        "Собственность",
        '<select name="ownership"><option value="own">Своя</option><option value="hired">Наёмная</option></select>',
      ) +
      field(
        "Подпись строки персонала",
        input("crewLabel", "", 'placeholder="Определится по названию"'),
      ) +
      field(
        "Категория техники",
        '<select name="kind"><option value="other">Другая техника</option><option value="water">Поливомойка</option><option value="mill">Фреза — 2 человека на обед</option><option value="brush">Щётка</option></select>',
      ) +
      colorField("color", "#e2e8f0", "Цвет техники — выбрать"),
    async (f) => {
      const c = s.config(),
        base = s.store.get(s.key("config"));
      const e = {
        id: D.uid(),
        name: String(f.get("name")).trim(),
        plate: String(f.get("plate")).trim(),
        ownership: f.get("ownership"),
        crewLabel: String(f.get("crewLabel")).trim(),
        kind: f.get("kind"),
        pump: false,
        contractor:
          f.get("ownership") === "hired"
            ? String(f.get("contractor") || "").trim()
            : "",
        contractorId:
          f.get("ownership") === "hired"
            ? String(f.get("contractor") || "")
                .trim()
                .toLocaleLowerCase()
            : "",
      };
      if (!e.name) throw Error("Введите название");
      const chosenColor = String(f.get("color") || "");
      e.color = /^#[0-9a-f]{6}$/i.test(chosenColor)
        ? chosenColor : D.equipmentColor(e);
      const catalogKey = "_catalog/config",
        catalogBase = s.store.get(catalogKey),
        catalog = catalogBase.data || { equipment: [], people: [] };
      catalog.equipment.push(e);
      if (e.contractor) {
        catalog.contractors ||= [];
        if (!catalog.contractors.some((x) => x.id === e.contractorId))
          catalog.contractors.push({ id: e.contractorId, name: e.contractor });
      }
      s.require("settings", "edit");
      await s.store.save(
        catalogKey,
        catalog,
        catalogBase,
        "Добавление техники в базу",
      );
      c.equipment.push(e);
      c.request.equipment.push(e.id);
      await s.saveConfig(c, base);
      await render(s);
    },
  );
  bindEquipmentOwnership(el);
  bindColorFields(el);
  return el;
}
function addPerson(s, group = "worker") {
  dialog(
    "Добавить человека",
    field("Телефон", input("phone", "", 'type="tel"')) +
      field("Фамилия и имя", input("name", "", "required")) +
      field(
        "Категория",
        `<select name="group" disabled><option value="worker">Рабочий</option><option value="itr" ${group === "itr" ? "selected" : ""}>ИТР</option></select>`,
      ),
    async (f) => {
      const c = s.config(),
        base = s.store.get(s.key("config"));
      const person = {
          id: D.uid(),
          name: String(f.get("name")).trim(),
          group,
          phone: String(f.get("phone") || "").trim(),
        },
        catalogKey = "_catalog/config",
        catalogBase = s.store.get(catalogKey),
        catalog = catalogBase.data || { equipment: [], people: [] };
      catalog.people.push(person);
      s.require("settings", "edit");
      await s.store.save(
        catalogKey,
        catalog,
        catalogBase,
        "Добавление человека в базу",
      );
      c.people.push(person);
      await s.saveConfig(c, base);
      await render(s);
    },
  );
}
async function addDay(s) {
  const c = s.config();
  const existing = s.store.get(s.key(D.dayKey(s.day, s.shift))).data;
  const el = dialog(
    "Добавить день / смену",
    `<div class="tn-tools">${[-2,-1,0,1].map((n,i) =>
      btn(["Позавчера","Вчера","Сегодня","Завтра"][i], "quick", `data-offset="${n}"`)).join("")}</div>
      ${field("Дата", input("date",s.day,'type="date" required'))}
      ${field("Смена",`<select name="shift"><option value="day" ${s.shift==="day"?"selected":""}>Дневная</option><option value="night" ${s.shift==="night"?"selected":""}>Ночная</option></select>`)}
      <label class="tn-check tn-day-off-choice"><input type="checkbox" name="dayOff" ${existing?.dayOff === true ? "checked" : ""}>Выходной день — без работы</label>
      <p class="tn-hint">Выходной создаёт отдельную дату без часов. Если смена уже существует, отметка меняется без удаления её данных. Суббота и воскресенье всегда выделяются в таблице.</p>`,
    async (f) => {
      const d = D.date(f.get("date")),
        shift = f.get("shift"),
        dayOff = f.has("dayOff"),
        key = s.key(D.dayKey(d, shift));
      await s.store.pull(key);
      const base = s.store.get(key);
      if (!base.data || base.data.deleted) {
        const created = D.createDay(c, d, shift,
          dayOff ? null : D.previousDay(s.days(), d, shift));
        if (dayOff) {
          created.equipment = [];
          created.people = [];
          created.values = {};
        }
        created.dayOff = dayOff;
        await s.save(key, created, base, "Создание " + (dayOff ? "выходного дня " : "смены ") + d);
      } else if (!!base.data.dayOff !== dayOff) {
        const updated = { ...D.copy(base.data), dayOff };
        await s.save(key, updated, base, dayOff ? "Отметка выходного дня" : "Снятие отметки выходного дня");
      }
      s.day = d;
      s.shift = shift;
      await render(s);
    },
  );
  // Match the checkbox to an existing shift when a different date is chosen.
  const syncDayOff = () => {
    const form = el.querySelector("form");
    const selectedDate = form.querySelector('[name="date"]').value;
    const selectedShift = form.querySelector('[name="shift"]').value;
    try {
      const day = s.store.get(s.key(D.dayKey(selectedDate, selectedShift))).data;
      form.querySelector('[name="dayOff"]').checked = day?.dayOff === true;
    } catch {
      form.querySelector('[name="dayOff"]').checked = false;
    }
  };
  el.querySelector('[name="date"]').addEventListener("change",syncDayOff);
  el.querySelector('[name="shift"]').addEventListener("change",syncDayOff);
  el.querySelectorAll("[data-offset]").forEach(
    (b) => (b.onclick = () => {
      el.querySelector('[name="date"]').value = D.add(D.today(),Number(b.dataset.offset));
      syncDayOff();
    }),
  );
}
async function shift(s, main) {
  const mod = await import("./shift-cards.mjs");
  await mod.mount(s, main);
}
function composition(s, group) {
  const c = s.config(),
    key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    d = base.data;
  if (!d) throw Error("Сначала создайте смену");

  dialog(
    "Состав только этой смены",
    `<h3>Техника</h3>${c.equipment.map((e) => `<label class="tn-check"><input type="checkbox" name="equipment" value="${e.id}" ${d.equipment.some((x) => x.id === e.id) ? "checked" : ""}>${esc(e.name)}</label>${D.isWater(e) && e.ownership === "own" ? `<label class="tn-check"><input type="checkbox" name="pump" value="${e.id}" ${(d.equipment.find((x) => x.id === e.id)?.pump ?? e.pump) ? "checked" : ""}>Помпа · ${esc(e.name)}</label>` : ""}`).join("")}<h3>Люди</h3>${c.people.map((p) => `<label class="tn-check"><input type="checkbox" name="people" value="${p.id}" ${d.people.some((x) => x.id === p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("")}<p>Исключение удалит строку из факта этой смены. Предыдущие значения сохранятся в истории.</p>`,
    async (f) => {
      const next = D.copy(d);
      next.equipment = c.equipment
        .filter((e) => f.getAll("equipment").includes(e.id))
        .map((e) => ({
          ...e,
          hours: null,
          crewHours: null,
          pumpHours: null,
          ...d.equipment.find((x) => x.id === e.id),
          pump:
            D.isWater(e) &&
            e.ownership === "own" &&
            f.getAll("pump").includes(e.id),
        }));
      next.people = c.people
        .filter((p) => f.getAll("people").includes(p.id))
        .map((p) => ({
          ...p,
          hours: null,
          ...d.people.find((x) => x.id === p.id),
        }));
      await s.save(key, next, base, "Состав смены");
      await render(s);
    },
  );
}
function settings(s, main) {
  const c = s.config(),
    base = s.store.get(s.key("config"));
  main.innerHTML = `<form><h3>Настройки объекта</h3>${field("Начало", input("start", c.start, 'type="date" required'))}${field("Завершение", input("end", c.end, 'type="date"'))}${field(
    "Новый лист",
    '<select name="newSheet">' +
      [
        ["ask", "Спрашивать"],
        ["blank", "Пустой"],
        ["template", "По шаблону"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${c.newSheet === v ? "selected" : ""}>${l}</option>`,
        )
        .join("") +
      "</select>",
  )}${field(
    "Количество техники",
    '<select name="countEquipment">' +
      [
        ["roster", "По фактическому составу"],
        ["hours", "Только с ненулевыми часами"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${c.countEquipment === v ? "selected" : ""}>${l}</option>`,
        )
        .join("") +
      "</select>",
  )}<p>Автоперенос объёмов «Линии» выключен. Материалы и работы вводятся самостоятельно.</p><button type="submit">Сохранить настройки</button></form><h3>Работы, план и остаток</h3>${c.works
    .map((w) => {
      const actual = s
        .days()
        .reduce((n, d) => n + (d.values[w.id]?.quantity || 0), 0);
      return `<p>${esc(w.name)} · ${esc(w.unit)} · план ${D.fmt(w.plan)} · факт ${D.fmt(actual)} · остаток ${D.fmt((w.plan || 0) - actual)}</p>`;
    })
    .join(
      "",
    )}${btn("＋ Вид работ", "work")}<h3>Материалы и направления</h3>${c.materials.map((m) => `<p>${esc(m.name)} · ${esc(m.unit)} · ${esc(m.direction)}</p>`).join("")}${btn("＋ Материал", "material")}<h3>Доступ</h3>${btn("Права по роли / UID", "acl")}<p>Права сервера обязательны. Новые коллекции не используют доступ старого табеля.</p>${btn("Экспорт резервной копии", "export")}`;
  main.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target),
        next = {
          ...c,
          start: D.date(f.get("start")),
          end: f.get("end"),
          newSheet: f.get("newSheet"),
          countEquipment: f.get("countEquipment"),
        };
      if (next.end && D.date(next.end) < next.start)
        throw Error("Завершение раньше начала");
      if (
        s
          .days()
          .some((d) => d.date < next.start || (next.end && d.date > next.end))
      )
        throw Error(
          "За границами нового периода есть смены. Данные не скрыты — выберите полный период.",
        );
      await s.saveConfig(next, base);
      await render(s);
    } catch (e) {
      error(e);
    }
  };
  for (const kind of ["work", "material"])
    bind(main, kind, () =>
      dialog(
        kind === "work" ? "Вид работ" : "Материал",
        field("Название", input("name", "", "required")) +
          field(
            "Единица",
            input("unit", kind === "work" ? "м²" : "м³", "required"),
          ) +
          (kind === "work"
            ? field("План", input("plan", "", 'inputmode="decimal"'))
            : field("Направление", input("direction")) +
              field(
                "Раздел",
                '<select name="section"><option value="granulate">Гранулят</option><option value="receipt">Поступление</option></select>',
              )),
        async (f) => {
          const next = s.config(),
            base = s.store.get(s.key("config"));
          next[kind === "work" ? "works" : "materials"].push({
            id: D.uid(),
            name: f.get("name"),
            unit: f.get("unit"),
            ...(kind === "work"
              ? { plan: D.numeric(f.get("plan")) }
              : { direction: f.get("direction"), section: f.get("section") }),
          });
          await s.saveConfig(next, base);
          await render(s);
        },
      ),
    );
  bind(main, "acl", () => {
    s.require("permissions", "edit");
    dialog(
      "Права объекта",
      field(
        "Роль или UID",
        '<select name="type"><option value="role">Роль</option><option value="user">UID</option></select>',
      ) +
        field("Идентификатор", input("id", "", "required")) +
        areas
          .map(
            (a) =>
              `<p>${esc(a)} <label><input type="checkbox" name="${a}.view">Просмотр</label><label><input type="checkbox" name="${a}.edit">Изменение</label></p>`,
          )
          .join(""),
      async (f) => {
        const next = s.config(),
          base = s.store.get(s.key("config"));
        next.acl[f.get("type") + ":" + f.get("id")] = Object.fromEntries(
          areas.flatMap((a) =>
            ["view", "edit"].map((m) => [a + "." + m, f.has(a + "." + m)]),
          ),
        );
        await s.saveConfig(next, base);
      },
    );
  });
  bind(main, "export", () => {
    const blob = new Blob([JSON.stringify(s.store.state, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "tabel-v2-backup-" + D.today() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
function conflicts(s) {
  return import("./conflict-view.mjs")
    .then((m) => m.showConflicts(s))
    .catch(error);
}
function history(s, main) {
  main.innerHTML =
    "<h3>История подтверждений и решений</h3>" +
    s.store.state.history
      .filter((h) => h.key.startsWith(s.object.id + "/"))
      .slice()
      .reverse()
      .map((h) => historyRows(h, s.config()))
      .join("");
}
async function dailyReport(s) {
  s.require("report");
  const el = dialog(
    "Ежедневный отчёт",
    '<div class="tn-tools">' +
      [0, -1, -2]
        .map((n, i) =>
          btn(
            ["Сегодня", "Вчера", "Позавчера"][i],
            "report-day",
            `data-offset="${n}"`,
          ),
        )
        .join("") +
      "</div>" +
      field("Дата", input("date", s.day, 'type="date"')) +
      field(
        "Смены",
        '<select name="shift"><option value="both">День и ночь</option><option value="day">Дневная</option><option value="night">Ночная</option></select>',
      ) +
      btn("Подготовить", "preview"),
  );
  el.querySelectorAll("[data-offset]").forEach(
    (b) =>
      (b.onclick = () =>
        (el.querySelector("[name=date]").value = D.add(
          D.today(),
          Number(b.dataset.offset),
        ))),
  );
  bind(el, "preview", async () => {
    const d = el.querySelector("[name=date]").value,
      type = el.querySelector("[name=shift]").value;
    const shifts = s
      .days()
      .filter((x) => x.date === d && (type === "both" || x.shift === type));
    const line = await (await import("./line.mjs")).lineReport(s, d, type);
    message(
      "Отчёт",
      D.report(s.config(), shifts, line, d) +
        (line.note ? "\n" + line.note : ""),
    );
  });
}
