import { onlinePolicy } from "./online-policy.mjs";
import { mount } from "./workspace.mjs";
import { normalizedObject, migrate } from "./migration.mjs";
import { esc, field, input, dialog } from "./messages.mjs";
let opened = null;
export async function open(
  host,
  settingsOnly = false,
  { requestFirst = false } = {},
) {
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
  let requestObject = null;
  if (requestFirst && !host.shift) {
    if (!document.querySelector("[data-tabel-v2-css]")) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = new URL("./workspace.css", import.meta.url);
      l.dataset.tabelV2Css = "";
      document.head.append(l);
    }
    requestObject = await pickRequestObject(host);
    if (!requestObject) return null;
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
      objects: [
        ...new Map(
          [
            ...(host.objects || []),
            ...(requestObject ? [requestObject] : []),
          ].map((o) => [o.id, normalizedObject(o)]),
        ).values(),
      ],
      shift: host.shift || null,
    }),
    requestObjectId: requestObject?.id,
    workspace: host.workspace,
    catalog,
    transaction: host.transaction,
    documentId: host.documentId,
    errors,
    prepare: (store, object) => migrate(host, store, object, catalog),
    createObject: host.createObject,
    leave: () => {
      void opened?.dispose();
      opened = null;
      container.remove();
    },
  };
  let remoteEnabled = false;
  if (host.transaction) {
    try {
      remoteEnabled = await onlinePolicy(host);
      if (!remoteEnabled)
        errors.push(
          "Firebase Табеля 2 ещё не включён: сначала опубликуйте правила доступа и настройку синхронизации. Данные сохранены на устройстве.",
        );
    } catch (e) {
      errors.push("Не удалось проверить подключение Firebase: " + e.message);
    }
  }
  const runtime = await mount({ ledgerHost, refs: host.refs }, container, {
    remoteEnabled,
  });
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

async function pickRequestObject(host) {
  return new Promise((resolve) => {
    let result = null;
    const objects = host.objects || [];
    const el = dialog(
      "Адрес для заявки",
      field(
        "Выберите адрес",
        '<select name="object"><option value="">Выберите объект</option>' +
          objects
            .map(
              (o) =>
                `<option value="${esc(o.id)}">${esc(o.address || o.name)}</option>`,
            )
            .join("") +
          '<option value="__new">＋ Новый адрес</option></select>',
      ) +
        "<div data-new hidden>" +
        field("Новый адрес", input("name", "", 'maxlength="180"')) +
        field(
          "Дата начала работ",
          input(
            "start",
            new Date().toLocaleDateString("sv-SE", {
              timeZone: "Europe/Moscow",
            }),
            'type="date"',
          ),
        ) +
        "</div>",
      async (f) => {
        const current = host.session();
        if (!current.active || !current.view) throw Error("Нет доступа");
        if (f.get("object") === "__new") {
          const name = String(f.get("name")).trim();
          if (!name) throw Error("Введите адрес");
          if (!host.createObject) throw Error("Нет права добавлять объекты");
          result = await host.createObject(name, f.get("start"));
        } else {
          result = objects.find((o) => o.id === f.get("object"));
          if (!result) throw Error("Выберите адрес");
        }
      },
    );
    el.classList.add("tn-picker");
    el.querySelector("[type=submit]").textContent = "Открыть заявку";
    el.querySelector("[name=object]").onchange = (e) => {
      const fresh = e.target.value === "__new";
      el.querySelector("[data-new]").hidden = !fresh;
      el.querySelector("[name=name]").required = fresh;
    };
    el.addEventListener("close", () => resolve(result), { once: true });
  });
}
