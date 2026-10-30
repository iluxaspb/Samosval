import {storageScope,sameTableSession,connectTable} from "./backend.mjs";
import { onlinePolicy } from "./online-policy.mjs";
import { mount } from "./workspace.mjs";
import { normalizedObject, migrate } from "./migration.mjs";
import { esc, field, input, dialog } from "./messages.mjs";
let opened = null, opening=Promise.resolve();
export function open(...args){const result=opening.then(()=>openInner(...args));opening=result.catch(()=>{});return result;}
async function openInner(
  host,
  settingsOnly = false,
  { requestFirst = false, backgroundMode=false } = {},
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
      "Выберите объект для его настроек. Заявки доступны через «Табель».",
    );
  if (opened) {
    if(opened.scope===storageScope(initial) && opened.runtimeId===initial.runtimeId && !requestFirst){if(!backgroundMode)await opened.show(settingsOnly);return opened;}
    await opened.dispose(); opened = null;
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
  container.className = "active";container.hidden=backgroundMode;
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
  const cacheKey=initial.provider==='synology'?JSON.stringify(['tabel-v2-catalog',storageScope(initial)]):JSON.stringify(['tabel-v2-catalog',initial.projectId,initial.workspaceId,initial.uid]);
  let cached={equipment:[],people:[]};try{cached=JSON.parse(localStorage.getItem(cacheKey))||cached;}catch{}
  const catalog={equipment:cached.equipment||[],people:cached.people||[]};
  const background=async()=>{
    if(initial.provider==='synology'){
      if(!sameTableSession(initial,host.session()))throw Error('Сеанс табеля изменился');
      if(typeof host.readCatalog!=='function')throw Error('Справочник Synology не подключён');
      const value=await host.readCatalog();
      if(!sameTableSession(initial,host.session()))throw Error('Сеанс табеля изменился');
      catalog.equipment=value.equipment;catalog.people=value.people;
      try{localStorage.setItem(cacheKey,JSON.stringify(catalog));}catch{}
      return true;
    }
    const [equipment,people]=await Promise.all([read('timesheetEquipment'),read('timesheetPeople')]);
    if(!errors.length){catalog.equipment=equipment.map(e=>({...e,ownership:e.ownership==='hired'?'hired':'own',pump:!!e.pumpEnabled,plate:e.number||e.plate||''}));catalog.people=people;try{localStorage.setItem(cacheKey,JSON.stringify(catalog));}catch{}}
    return host.transaction ? onlinePolicy(host) : false;
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
    requestObjectId: requestObject?.id || (settingsOnly ? initial.objectId : null),
    workspace: host.workspace,
    remoteFactory:host.remoteFactory,
    presenceRemote:host.presenceRemote,
    registerPresenceLeave:host.registerPresenceLeave,
    catalog,
    users: () => host.users?.() || [],
    transaction: host.transaction,
    documentId: host.documentId,
    errors,
    prepare: (store, object) => initial.provider==='synology'?undefined:migrate(host, store, object, catalog),
    createObject: host.createObject,
    leave: () => {
      container.hidden = true;
    },
  };
  const runtime=await mount({ledgerHost,refs:host.refs},container,{remoteEnabled:false});
  let disposed=false;
  const connect=()=>{if(disposed)return;void connectTable(host,runtime,background,()=>disposed).catch(e=>{if(!disposed)runtime.notice('На устройстве · ошибка подключения сервера: '+e.message);});};
  connect();globalThis.addEventListener('online',connect);
  let timer;
  opened = {
    uid:initial.uid,scope:storageScope(initial),runtimeId:initial.runtimeId,
    async show(settings=false){container.hidden=false;await runtime.show();if(settings)await runtime.settings(host.session().objectId);},
    hide(){container.hidden=true;},
    async dispose() {
      disposed=true;globalThis.removeEventListener("online",connect);
      clearInterval(timer);
      await runtime.dispose();
      container.remove();
    },
  };
  timer = setInterval(() => {
    const a = host.session();
    if (!sameTableSession(a,initial) || !a.active || !a.view) {
      void opened?.dispose();
      opened = null;
    }
  }, 500);
  if (settingsOnly) runtime.settings();
  return opened;
}

// Start the same durable queue even when the user stays on the Line after a reload.
export async function background(host){if(opened?.scope===storageScope(host.session())&&opened?.runtimeId===host.session().runtimeId)return;await open(host,false,{backgroundMode:true});}

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
