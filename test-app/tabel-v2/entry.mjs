import { mount } from "./workspace.mjs";
import { normalizedObject, migrate } from "./migration.mjs";
let opened = null;
export async function open(host, settingsOnly = false) {
  const initial = host.session();
  if (
    initial.projectId !== "samosval-offline" ||
    !initial.uid ||
    !initial.active ||
    !initial.view
  )
    throw Error("Нет доступа к табелю");
  if (settingsOnly && !initial.objectId)
    throw Error(
      "Выберите объект для его настроек. Заявки доступны через «Табель 2».",
    );
  if (opened) {
    await opened.dispose();
    opened = null;
  }
  const container = document.createElement("div");
  container.className = "active";
  document.body.append(container);
  const errors = [];
  const read = async (name) => {
    try {
      const snap = await host.workspace.collection(name).get();
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id }))
        .filter((x) => !x.deleted);
    } catch (e) {
      errors.push("Не загружен общий справочник " + name + ": " + e.message);
      return [];
    }
  };
  const [equipment, people] = await Promise.all([
    read("timesheetEquipment"),
    read("timesheetPeople"),
  ]);
  const catalog = {
    equipment: equipment.map((e) => ({
      ...e,
      ownership: e.ownership === "hired" ? "hired" : "own",
      pump: !!e.pumpEnabled,
      plate: e.number || e.plate || "",
    })),
    people,
  };
  const ledgerHost = {
    session: () => {
      const a = host.session();
      return {
        ...a,
        name: a.name || a.uid,
        role: a.role || "operator",
        status: a.active ? "active" : "disabled",
        tabAccess: a.view,
        permissions: { view: a.view, edit: a.edit },
        hostPermissions: true,
      };
    },
    data: () => ({
      ...host.snapshot?.(),
      objects: (host.objects || []).map((o) => normalizedObject(o)),
      shift: host.shift || null,
    }),
    workspace: host.workspace,
    catalog,
    errors,
    prepare: (store, object) => migrate(host, store, object, catalog),
    createObject: host.createObject,
    leave: () => {
      void opened?.dispose();
      opened = null;
      container.remove();
    },
  };
  const runtime = await mount({ ledgerHost, refs: host.refs }, container);
  let timer;
  opened = {
    async dispose() {
      clearInterval(timer);
      await runtime.dispose();
      container.remove();
    },
  };
  timer = setInterval(() => {
    const a = host.session();
    if (a.uid !== initial.uid || !a.active || !a.view) {
      void opened?.dispose();
      opened = null;
    }
  }, 500);
  if (settingsOnly) runtime.settings();
  return opened;
}
