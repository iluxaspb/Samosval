import * as R from "./request-domain.mjs";
import { arrivals } from "./line.mjs";
import * as D from "./table-domain.mjs";
import { Store, firestoreRemote } from "./store.mjs";
import { esc, btn, input, field, dialog, message, error } from "./messages.mjs";
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
    view: "request",
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
    if (!D.allowed(a, c, area, "edit"))
      throw Error("Нет права записи: " + area);
  };
  s.remote = remoteEnabled ? firestoreRemote(host, guard) : null;
  s.store = await new Store(
    session.projectId + "_" + session.workspaceId + "_" + session.uid,
    s.remote,
    () => ({ uid: account().uid, name: account().name }),
  ).open();
  s.key = (suffix) => s.object.id + "/" + suffix;
  s.config = () => {
    const c = s.store.get(s.key("config")).data || D.config(s.object),
      catalog = s.store.get("_catalog/config").data || {
        equipment: [],
        people: [],
      };
    c.equipment = [
      ...new Map(
        [
          ...(host.catalog?.equipment || []),
          ...catalog.equipment,
          ...c.equipment,
        ].map((e) => [e.id, e]),
      ).values(),
    ];
    c.people = [
      ...new Map(
        [...(host.catalog?.people || []), ...catalog.people, ...c.people].map(
          (e) => [e.id, e],
        ),
      ).values(),
    ];
    return c;
  };
  s.require = (area, mode = "view") => {
    if (!D.allowed(account(), s.config(), area, mode))
      throw Error("Нет права: " + area + "." + mode);
  };
  s.save = async (key, data, base, label, area = "shift") => {
    s.require(area, "edit");
    const ok = await s.store.save(key, data, base, label);
    if (!ok)
      throw Error(
        "Есть новая версия записи. Обе правки сохранены — откройте «Конфликты».",
      );
    void s.store.flush();
  };
  s.days = () =>
    s.store
      .list(s.key("day:"))
      .filter((r) => r.data)
      .map((r) => r.data)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift),
      );
  s.saveConfig = async (c, base, area = "settings") =>
    s.save(s.key("config"), c, base, "Настройки / заявка", area);
  s.refresh = () => render(s);
  s.addEquipment = () => addEquipment(s);
  s.addPerson = () => addPerson(s);
  s.openSettings = () =>
    import("./settings-menu.mjs").then((m) => m.openSettings(s));
  s.addDefinition = (kind) =>
    import("./catalog.mjs").then((m) => m.addDefinition(s, kind));
  s.addDay = () => addDay(s);
  s.composition = () => composition(s);
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
  const objects = host.data().objects || [];
  s.object =
    objects.find((o) => o.id === host.data().shift?.objectId) ||
    objects[0] ||
    null;
  s.status = () => {
    const target = root.querySelector("[data-status]");
    if (!target) return;
    const jobs = s.store.state.jobs;
    target.textContent =
      (s.remote
        ? navigator.onLine
          ? "Сеть"
          : "Офлайн"
        : "Локальный режим: правила сервера не подключены") +
      " · локально " +
      jobs.filter((j) => j.status === "queued").length +
      " · конфликты " +
      jobs.filter((j) => j.status === "conflict").length +
      (s.store.error ? " · сервер: " + s.store.error : "");
  };
  s.store.listeners.add(s.status);
  async function loadObject() {
    if (!s.object || !s.remote) return;
    await s.store.pull(s.key("config"));
    const c = s.config();
    const max = c.end && c.end < D.today() ? c.end : D.today();
    for (const d of D.days(c.start, max)) {
      for (const shift of ["day", "night"]) {
        if (s.store.error) break;
        await s.store.pull(s.key(D.dayKey(d, shift)));
      }
      if (s.store.error) break;
    }
  }
  s.select = async (id) => {
    s.unwatch?.();
    s.grid?.dispose();
    s.object = (host.data().objects || []).find((o) => o.id === id) || s.object;
    s.generation++;
    await s.store.pull("_catalog/config");
    await s.store.pull("_defaults/config");
    await host.prepare?.(s.store, s.object);
    await loadObject();
    await render(s);
    watch();
  };
  await s.store.pull("_catalog/config");
  await s.store.pull("_defaults/config");
  await host.prepare?.(s.store, s.object);
  await loadObject();
  await render(s);
  if (host.errors?.length) error(host.errors.join("\n"));
  void s.store.flush();
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
        const active = document.activeElement;
        if (
          !document.querySelector("dialog.tn") &&
          !s.root.contains(active) &&
          !s.root.hidden
        )
          await render(s);
      },
      (e) => {
        s.store.error = e.message;
        s.status();
      },
    );
  }
  watch();
  const observer = new MutationObserver(() => {
    root.hidden = !container.classList.contains("active");
  });
  observer.observe(container, { attributes: true, attributeFilter: ["class"] });
  return {
    settings: () => s.openSettings(),
    show() {
      account();
      root.hidden = false;
      s.status();
    },
    async dispose() {
      s.unwatch?.();
      observer.disconnect();
      s.grid?.dispose();
      document.querySelectorAll("dialog.tn").forEach((el) => el.close());
      root.remove();
      await s.store.close();
    },
  };
}
async function render(s) {
  s.grid?.dispose();
  s.grid = null;
  const c = s.object ? s.config() : null;
  s.root.classList.toggle("tn-table", s.view === "table");
  s.root.innerHTML = `<header class="tn-header">${btn("‹", "exit", 'aria-label="На линию"')}<select data-object aria-label="Объект">${[...new Map([...(s.host.data().objects || []), ...(s.object ? [s.object] : [])].map((o) => [o.id, o])).values()].map((o) => `<option value="${esc(o.id)}" ${o.id === s.object?.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select><span class="tn-version">Табель 2</span>${btn("＋ Объект", "object")}${btn("⚙", "settings-menu", 'aria-label="Настройки объекта"')}</header><nav>${[
    ["request", "Заявки"],
    ["shift", "Смена"],
    ["table", "Таблица"],
    ["catalog", "Справочник"],
    ["settings", "Настройки"],
    ["history", "История"],
  ]
    .map(([id, label]) =>
      btn(label, "view", `data-view="${id}" aria-pressed="${s.view === id}"`),
    )
    .join(
      "",
    )}</nav><p role="alert"></p><main></main><footer class="tn-status"><span data-status></span>${btn("↻", "sync", 'aria-label="Синхронизировать"')}${btn("Конфликты", "conflicts")}</footer>`;
  s.root.querySelector("[data-action=exit]").onclick = () => {
    s.root.hidden = true;
    s.host.leave();
  };
  s.root.querySelector("[data-action=object]").onclick = () => newObject(s);
  s.root.querySelector("[data-object]").onchange = (e) =>
    s.select(e.target.value).catch(error);
  s.root.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        s.view = b.dataset.view;
        render(s).catch(error);
      }),
  );
  s.root.querySelector("[data-action=sync]").onclick = async () => {
    await s.store.flush();
    if (s.object) {
      await s.store.pull(s.key("config"));
      for (const r of s.store.list(s.key("day:"))) await s.store.pull(r.key);
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
      s.grid = await (await import("./grid.mjs")).mount(s, main);
      return;
    }
    if (s.view === "request") request(s, main);
    if (s.view === "shift") shift(s, main);
    if (s.view !== "table" && s.view !== "settings") {
      const days = s.days().filter((d) => d.date === s.day),
        list = days.flatMap((d) => d.people);
      const counts = document.createElement("div");
      counts.className = "tn-counts";
      counts.innerHTML = `<span>Техника: <b>${D.equipmentCount(days, arrivals(s.host.data(), s.object.id, s.day).rows, s.config())}</b></span><span>Рабочие: <b>${new Set(list.filter((p) => p.group === "worker").map((p) => p.id)).size}</b></span><span>ИТР: <b>${new Set(list.filter((p) => p.group === "itr").map((p) => p.id)).size}</b></span>`;
      main.prepend(counts);
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
    error(e);
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
      const object = await s.host.createObject(
        String(form.get("name")).trim(),
        form.get("start"),
      );
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
  const base = s.store.get(s.key("config")), c = s.config();
  main.innerHTML = `<form class="tn-request">${field("Дата заявки",input("date",c.request.date,'type="date" required'))}${field("Смена",`<select name="shift"><option value="day">Дневная</option><option value="night" ${c.request.shift === "night" ? "selected" : ""}>Ночная</option></select>`)}<div class="tn-tools">${btn("＋ Добавить технику", "choose-equipment")}${btn("＋ ИТР", "add-itr")}${btn("Состав по умолчанию", "defaults")}</div><h3>Техника в заявке</h3>${R.selectedEquipment(c).map(e=>`<label class="tn-check"><input type="checkbox" name="equipment" value="${esc(e.id)}" checked>${esc(e.name)}</label>`).join("") || "<p>Добавьте нужную технику из справочника.</p>"}<h3>ИТР</h3>${c.people.filter(p=>p.group === "itr").map(p=>`<label class="tn-check"><input type="checkbox" name="people" value="${esc(p.id)}" ${c.request.people.includes(p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("")}${field("Ответственный ИТР",'<select name="responsibleId"></select>')}${field("Станция метро для развозки",input("metro",c.request.metro || "",'autocomplete="off" placeholder="Начните вводить название"'))}<div data-stations class="tn-stations" hidden></div>${field("Время подачи развозки",input("pickupTime",c.request.pickupTime || "",'type="time"'))}${field("Примечание к заявке",input("note",c.request.note))}<button type="submit">Сохранить заявку</button></form><div class="tn-tools">${btn("Поделиться заявкой", "send-request")}${btn("Заказ обеда", "lunch")}${btn("Отправить отчёт", "report")}${btn("Начать / добавить смену", "add-day")}</div><p class="tn-hint">Рабочие учитываются в табеле. В заявке выбираются техника и ИТР.</p>`;
  const form=main.querySelector("form"), select=form.elements.responsibleId;
  const updateResponsible=()=>{
    const id=select.value || c.request.responsibleId;
    const ids=new FormData(form).getAll("people");
    const people=c.people.filter(p=>p.group === "itr" && ids.includes(p.id));
    select.innerHTML='<option value="">Выберите ответственного</option>'+people.map(p=>`<option value="${esc(p.id)}" ${p.id===id || people.length===1 ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  };
  form.querySelectorAll('[name=people]').forEach(el=>el.onchange=updateResponsible);
  updateResponsible();
  const metro=form.elements.metro, results=main.querySelector("[data-stations]");
  metro.oninput=()=>{
    results.hidden=false;
    results.innerHTML=R.searchStations(metro.value).map(name=>btn(esc(name),"station",`data-name="${esc(name)}"`)).join("") || "<p>Станция не найдена</p>";
    results.querySelectorAll("button").forEach(b=>b.onclick=()=>{metro.value=b.dataset.name;results.hidden=true;});
  };
  metro.onfocus=metro.oninput;
  async function saveRequest(){
    const f=new FormData(form), next=D.copy(c);
    next.request={...next.request,equipment:f.getAll("equipment"),people:f.getAll("people"),responsibleId:f.get("responsibleId"),metro:String(f.get("metro")).trim(),pickupTime:f.get("pickupTime"),date:D.date(f.get("date")),shift:f.get("shift"),note:f.get("note")};
    if(next.request.metro && !R.stations.includes(next.request.metro)) throw Error("Выберите станцию метро из списка");
    await s.saveConfig(next,base,"request");
    return next;
  }
  form.onsubmit=async e=>{e.preventDefault();try{await saveRequest();await render(s);}catch(e){error(e);}};
  bind(main,"choose-equipment",()=>{
    const el=dialog("Техника из справочника",'<input data-search placeholder="Поиск техники">'+c.equipment.map(e=>`<label class="tn-check"><input type="checkbox" name="equipment" value="${esc(e.id)}" ${new FormData(form).getAll("equipment").includes(e.id) ? "checked" : ""}>${esc(e.name)}</label>`).join("")+btn("＋ Новая техника","new-equipment"),async f=>{
      form.querySelectorAll('[name=equipment]').forEach(x=>x.remove());
      for(const id of f.getAll("equipment")){const x=document.createElement("input");x.type="hidden";x.name="equipment";x.value=id;form.append(x);}
      await saveRequest();await render(s);
    });
    el.querySelector('[data-search]').oninput=e=>el.querySelectorAll('.tn-check').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(e.target.value.toLowerCase()));
    bind(el,"new-equipment",()=>{el.close();addEquipment(s);});
  });
  bind(main,"add-itr",()=>addPerson(s,"itr"));
  bind(main,"add-day",s.addDay);
  bind(main,"report",()=>dailyReport(s));
  bind(main,"defaults",()=>dialog("Состав новых объектов","<p>Сохранить состав этой заявки для новых объектов?</p>",async()=>{await saveRequest();s.require("settings","edit");await s.store.save("_defaults/config",s.config(),s.store.get("_defaults/config"),"Шаблон нового объекта");}));
  bind(main,"send-request",async()=>{
    const next=await saveRequest();await render(s);
    message("Заявка",`Заявка на ${D.display(next.request.date)}\nОбъект: ${next.name}\nСмена: ${next.request.shift === "night" ? "ночная" : "дневная"}\nТехника:\n${R.selectedEquipment(next).map(e=>"— "+e.name).join("\n") || "не выбрана"}\nИТР:\n${R.selectedITR(next).map(p=>"— "+p.name).join("\n") || "не выбраны"}\nМетро: ${next.request.metro || "не выбрано"}\nРазвозка к: ${next.request.pickupTime || "не указано"}\n${next.request.note}`);
  });
  bind(main,"lunch",async()=>{
    const next=await saveRequest();await render(s);
    const x=R.lunch(next,s.object);
    const el=dialog("Заказ обеда",`<p>Адрес: ${esc(x.address)}</p><div data-lunch-rows></div>${field("Количество рабочих",input("workers",0,'type="number" inputmode="numeric" min="0" max="10000" step="1"'))}<label class="tn-check"><input name="mechanic" type="checkbox">Слесарь</label><label class="tn-check"><input name="spare" type="checkbox">Запасной обед</label><p>Всего: <b data-total></b></p><p>Ответственный: ${esc(x.person?.name || "не выбран")}</p><p>Телефон: ${esc(x.phone || "Добавьте номер в справочник ИТР")}</p>`,async f=>{
      if(!x.person) throw Error("Выберите ответственного ИТР в заявке");
      if(!x.phone) throw Error("Добавьте телефон ответственного в справочник ИТР");
      message("Заказ обеда",R.lunchText(next,s.object,D.display(next.request.date),{mechanic:f.has("mechanic"),spare:f.has("spare"),workers:f.get("workers")}));
    });
    const update=()=>{const f=new FormData(el.querySelector("form")), result=R.lunch(next,s.object,{mechanic:f.has("mechanic"),spare:f.has("spare"),workers:f.get("workers")});el.querySelector('[data-lunch-rows]').innerHTML=result.rows.map(row=>`<p>${esc(row.name)} — ${row.count} чел.</p>`).join("");el.querySelector('[data-total]').textContent=result.total;};
    el.querySelectorAll('input').forEach(i=>i.oninput=()=>{try{update();el.querySelector('[role=alert]').textContent='';}catch(e){error(e);}});update();
    el.querySelector('[type=submit]').textContent="Подготовить текст";
  });
}

function bind(root, action, fn) {
  root
    .querySelector("[data-action=" + action + "]")
    ?.addEventListener("click", () => Promise.resolve().then(fn).catch(error));
}
function addEquipment(s) {
  dialog(
    "Добавить технику в базу",
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
      '<label class="tn-check"><input name="pump" type="checkbox">Есть помпа</label>',
    async (f) => {
      const c = s.config(),
        base = s.store.get(s.key("config"));
      const e = {
        id: D.uid(),
        name: String(f.get("name")).trim(),
        plate: String(f.get("plate")).trim(),
        ownership: f.get("ownership"),
        crewLabel: String(f.get("crewLabel")).trim(),
        pump: f.get("ownership") === "own" && f.has("pump"),
      };
      if (!e.name) throw Error("Введите название");
      const catalogKey = "_catalog/config",
        catalogBase = s.store.get(catalogKey),
        catalog = catalogBase.data || { equipment: [], people: [] };
      catalog.equipment.push(e);
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
}
function addPerson(s, group = "worker") {
  dialog(
    "Добавить человека",
    field("Телефон", input("phone", "", 'type="tel"')) + field("Фамилия и имя", input("name", "", "required")) +
      field(
        "Категория",
        `<select name="group" ${group === 'itr' ? 'disabled' : ''}><option value="worker">Рабочий</option><option value="itr" ${group === 'itr' ? 'selected' : ''}>ИТР</option></select>`,
      ),
    async (f) => {
      const c = s.config(),
        base = s.store.get(s.key("config"));
      const person = {
          id: D.uid(),
          name: String(f.get("name")).trim(),
          group: group === "itr" ? "itr" : f.get("group"),
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
  const el = dialog(
    "Добавить день / смену",
    `<div class="tn-tools">${[-2, -1, 0, 1].map((n, i) => btn(["Позавчера", "Вчера", "Сегодня", "Завтра"][i], "quick", `data-offset="${n}"`)).join("")}</div>${field("Дата", input("date", s.day, 'type="date" required'))}${field("Смена", `<select name="shift"><option value="day">Дневная</option><option value="night">Ночная</option></select>`)}<p>Будущий столбец — подготовка состава без фактических часов.</p>`,
    async (f) => {
      const d = f.get("date"),
        shift = f.get("shift"),
        key = s.key(D.dayKey(d, shift));
      await s.store.pull(key);
      const base = s.store.get(key);
      if (!base.data)
        await s.save(
          key,
          D.createDay(c, d, shift),
          base,
          "Создание смены " + d,
        );
      s.day = d;
      s.shift = shift;
      await render(s);
    },
  );
  el.querySelectorAll("[data-offset]").forEach(
    (b) =>
      (b.onclick = () =>
        (el.querySelector("[name=date]").value = D.add(
          D.today(),
          Number(b.dataset.offset),
        ))),
  );
}
function shift(s, main) {
  const c = s.config(),
    key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    d = base.data;
  main.innerHTML = `<div class="tn-tools"><input type="date" data-day value="${s.day}"><select data-shift><option value="day" ${s.shift === "day" ? "selected" : ""}>Дневная</option><option value="night" ${s.shift === "night" ? "selected" : ""}>Ночная</option></select>${[-2, -1, 0].map((n, i) => btn(["Позавчера", "Вчера", "Сегодня"][i], "quick", `data-offset="${n}"`)).join("")}${btn("＋ День", "add-day")}</div><h3>${D.display(s.day)}${d?.date > D.today() ? " · ПЛАН" : ""}</h3>${
    d
      ? `<div class="tn-tools">${btn("Состав", "composition")}</div><form data-facts>${[
          ["equipment", "Техника"],
          ["people", "Люди"],
        ]
          .map(
            ([kind, label]) =>
              `<h3>${label}</h3>${d[kind]
                .map((e) => {
                  const rows =
                    kind === "people"
                      ? [["hours", e.name]]
                      : [
                          ["hours", e.name],
                          ...(e.ownership === "hired"
                            ? []
                            : [
                                ["crewHours", D.crewLabel(e)],
                                ...(e.pump ? [["pumpHours", "Помпа"]] : []),
                              ]),
                        ];
                  return `<section class="tn-item">${rows.map(([field, label]) => `<label>${esc(label)}${input(kind + ":" + e.id + ":" + field, D.fmt(e[field]), 'inputmode="decimal" placeholder="часы" ' + "")}</label>`).join("")}${kind === "equipment" ? btn("Ввод за 5 дней", "multi", `data-id="${e.id}"`) : ""}</section>`;
                })
                .join("")}`,
          )
          .join(
            "",
          )}<h3>Материалы и объёмы работ</h3>${[...c.works, ...c.materials].map((w) => field(w.name + " · " + w.unit, input("value:" + w.id, D.fmt(d.values[w.id]?.quantity), 'inputmode="decimal" ' + "")) + (c.materials.some((m) => m.id === w.id) ? field("Направление", input("direction:" + w.id, d.values[w.id]?.direction ?? w.direction, d.closed ? "disabled" : "")) : "")).join("")}<button type="submit" >Сохранить факт</button></form>`
      : "<p>Смена пока не создана. Добавьте день здесь или в таблице.</p>"
  }`;
  main.querySelector("[data-day]").onchange = (e) => {
    s.day = e.target.value;
    render(s).catch(error);
  };
  main.querySelector("[data-shift]").onchange = (e) => {
    s.shift = e.target.value;
    render(s).catch(error);
  };
  main.querySelectorAll("[data-offset]").forEach(
    (b) =>
      (b.onclick = () => {
        s.day = D.add(D.today(), Number(b.dataset.offset));
        render(s).catch(error);
      }),
  );
  bind(main, "add-day", s.addDay);
  if (!d) return;
  bind(main, "composition", s.composition);

  main
    .querySelectorAll("[data-action=multi]")
    .forEach((b) => (b.onclick = () => multi(s, b.dataset.id).catch(error)));
  main.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const next = D.copy(d),
        f = new FormData(e.target);
      for (const [k, v] of f) {
        const parts = k.split(":");
        if (parts[0] === "direction")
          next.values[parts[1]] = {
            ...next.values[parts[1]],
            direction: String(v),
          };
        else
          D.setValue(
            { kind: parts[0], entity: parts[1], field: parts[2] },
            next,
            v,
          );
      }
      await s.save(key, next, base, "Факт смены " + d.date);
      await render(s);
    } catch (e) {
      error(e);
    }
  };
}
function composition(s) {
  const c = s.config(),
    key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    d = base.data;
  if (!d) throw Error("Сначала создайте смену");

  dialog(
    "Состав только этой смены",
    `<h3>Техника</h3>${c.equipment.map((e) => `<label class="tn-check"><input type="checkbox" name="equipment" value="${e.id}" ${d.equipment.some((x) => x.id === e.id) ? "checked" : ""}>${esc(e.name)}</label>${e.ownership === "own" ? `<label class="tn-check"><input type="checkbox" name="pump" value="${e.id}" ${(d.equipment.find((x) => x.id === e.id)?.pump ?? e.pump) ? "checked" : ""}>Помпа · ${esc(e.name)}</label>` : ""}`).join("")}<h3>Люди</h3>${c.people.map((p) => `<label class="tn-check"><input type="checkbox" name="people" value="${p.id}" ${d.people.some((x) => x.id === p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("")}<p>Исключение удалит строку из факта этой смены. Предыдущие значения сохранятся в истории.</p>`,
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
          pump: e.ownership === "own" && f.getAll("pump").includes(e.id),
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
async function multi(s, id) {
  const c = s.config(),
    end = s.day > D.today() ? D.today() : s.day,
    start = D.add(end, -4) < c.start ? c.start : D.add(end, -4),
    snapshots = D.days(start, end).map((date) => ({
      key: s.key(D.dayKey(date, s.shift)),
      ...s.store.get(s.key(D.dayKey(date, s.shift))),
    })),
    draftKey = s.key("draft:multi:" + id + ":" + s.shift),
    draft = s.store.get(draftKey).data || {};
  const el = dialog(
    "Часы техники за 5 дней",
    snapshots
      .map((r) => {
        const e = r.data?.equipment.find((x) => x.id === id);
        if (!e) return `<p>${r.key.split(":")[1]} — нет техники в смене</p>`;
        return `<h3>${D.display(r.data.date)}</h3>${[["hours", e.name], ...(e.ownership === "hired" ? [] : [["crewHours", D.crewLabel(e)], ...(e.pump ? [["pumpHours", "Помпа"]] : [])])].map(([field, label]) => fieldHTML(label, r.key + "|" + field, draft.values?.[r.key + "|" + field] ?? D.fmt(e[field]))).join("")}`;
      })
      .join(""),
    async (f) => {
      await saving;
      for (const r of snapshots) {
        if (!r.data?.equipment.some((e) => e.id === id)) continue;
        const base = draft.snapshots?.[r.key] || r,
          next = D.copy(base.data);
        for (const [k, v] of f) {
          const [key, field] = k.split("|");
          if (key === r.key)
            D.setValue({ kind: "equipment", entity: id, field }, next, v);
        }
        if (JSON.stringify(next) !== JSON.stringify(base.data))
          await s.save(r.key, next, base, "Многодневный ввод");
      }
      await s.store.serialize(async () => {
        delete s.store.state.records[draftKey];
        await s.store.persist();
      });
      await render(s);
    },
  );
  let saving = Promise.resolve();
  el.querySelectorAll("input").forEach(
    (i) =>
      (i.oninput = () => {
        const values = Object.fromEntries(
          new FormData(el.querySelector("form")),
        );
        saving = saving
          .then(() =>
            s.store.serialize(async () => {
              s.store.state.records[draftKey] = {
                revision: 0,
                data: {
                  values,
                  snapshots: Object.fromEntries(
                    snapshots.map((r) => [
                      r.key,
                      draft.snapshots?.[r.key] || r,
                    ]),
                  ),
                },
              };
              await s.store.persist();
            }),
          )
          .catch(error);
      }),
  );
}
const fieldHTML = (label, name, v) =>
  field(label, input(name, v, 'inputmode="decimal"'));
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
  const jobs = s.store.state.jobs.filter((j) => j.status === "conflict");
  if (!jobs.length) {
    dialog("Конфликты", "<p>Конфликтов нет.</p>");
    return;
  }
  const job = jobs[0];
  const el = dialog(
    "Конфликт — обе версии сохранены",
    `<p>Объект: ${esc(s.config().name)}<br>Запись: ${esc(job.key)}<br>Правка: ${esc(job.label)}<br>Вы: ${esc(job.author.name)} · ${new Date(job.time).toLocaleString("ru-RU")}<br>Текущая версия: ${esc(job.remote.authorName || job.remote.author || "нет автора")} · ${job.remote.time ? new Date(job.remote.time).toLocaleString("ru-RU") : "время неизвестно"}</p><p>Применение заменит всю запись, включая часы, состав и связанные итоги таблицы и отчёта. Обе версии останутся в истории.</p><p><b>Текущие данные → предлагаемая замена:</b></p><pre>${esc(D.describeChange(job.remote.data, job.data))}</pre><details><summary>Было → текущее → моё</summary><pre>${esc(JSON.stringify({ before: job.before.data, current: job.remote.data, mine: job.data }, null, 2))}</pre></details>${btn("Оставить существующее", "theirs")}${btn("Применить моё изменение", "mine")}`,
  );
  for (const choice of ["theirs", "mine"])
    bind(el, choice, async () => {
      s.require("shift", "edit");
      await s.store.resolve(job.id, choice);
      el.close();
      await render(s);
    });
}
function history(s, main) {
  main.innerHTML =
    "<h3>История подтверждений и решений</h3>" +
    s.store.state.history
      .filter((h) => h.key.startsWith(s.object.id + "/"))
      .slice()
      .reverse()
      .map(
        (h) =>
          `<details><summary>${esc(h.label)} · ${new Date(h.time).toLocaleString("ru-RU")} · ${esc(h.author?.name)}</summary><pre>${esc(JSON.stringify({ before: h.before?.data, after: h.data, resolution: h.resolution }, null, 2))}</pre></details>`,
      )
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
