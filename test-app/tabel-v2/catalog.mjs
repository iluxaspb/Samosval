import * as D from "./table-domain.mjs";
import { rankChoices } from "./domain.mjs";
import { esc, btn, input, field, dialog, error } from "./messages.mjs";
export async function addDefinition(s, kind, selectedId) {
  s.require("settings", "edit");
  const c = s.config(),
    registry = s.store.get("_catalog/config").data || {
      equipment: [],
      people: [],
      works: [],
      materials: [],
    },
    list = registry[kind] || [];
  const el = dialog(
    kind === "works" ? "Вид работ" : "Материал",
    `${
      list.length
        ? field(
            "Из справочника",
            `<input name="search" placeholder="Поиск ранее добавленных"><select name="existing"><option value="">Новая запись</option>${rankChoices(
              list,
            )
              .map(
                (x) =>
                  `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.unit)}</option>`,
              )
              .join("")}</select>`,
          )
        : ""
    }${field("Наименование", input("name", "", "required"))}${field("Единица", input("unit", kind === "works" ? "м²" : "м³", "required"))}${kind === "works" ? field("План объекта", input("plan", "", 'inputmode="decimal"')) : field("Направление", input("direction")) + field("Раздел", '<select name="section"><option value="receipt">Поступление</option><option value="granulate">Гранулят</option></select>')}`,
    async (f) => {
      const name = String(f.get("name")).trim(),
        unit = String(f.get("unit")).trim();
      if (!name || !unit) throw Error("Укажите название и единицу");
      const existing =
        list.find((x) => x.id === f.get("existing")) ||
        list.find(
          (x) => x.name.toLowerCase() === name.toLowerCase() && x.unit === unit,
        );
      const item = { id: existing?.id || D.uid(), name, unit };
      const base = s.store.get("_catalog/config"),
        next = base.data || {
          equipment: [],
          people: [],
          works: [],
          materials: [],
        };
      next[kind] = [
        ...(next[kind] || []).filter((x) => x.id !== item.id),
        item,
      ];
      await s.store.save("_catalog/config", next, base, "Справочник: " + name);
      const config = s.config(),
        before = s.store.get(s.key("config"));
      if (!config[kind].some((x) => x.id === item.id))
        config[kind].push({
          ...item,
          ...(kind === "works"
            ? { plan: D.numeric(f.get("plan")) }
            : {
                direction: String(f.get("direction") || ""),
                section: f.get("section"),
              }),
        });
      await s.saveConfig(config, before);
      await s.refresh();
    },
  );
  const select = el.querySelector("[name=existing]");
  if (select) {
    select.onchange = () => {
      const item = list.find((x) => x.id === select.value);
      if (item) {
        el.querySelector("[name=name]").value = item.name;
        el.querySelector("[name=unit]").value = item.unit;
      }
    };
    el.querySelector("[name=search]").oninput = (e) => {
      const ids = new Set(rankChoices(list, e.target.value).map((x) => x.id));
      [...select.options].forEach(
        (o) => (o.hidden = !!o.value && !ids.has(o.value)),
      );
    };
  }
  return el;
}
export async function mount(s, root) {
  const c = s.config(),
    registry = s.store.get("_catalog/config").data || {};
  root.innerHTML = `<div class="tn-tools">${btn("＋ Техника", "equipment")}${btn("＋ Рабочий / ИТР", "person")}${btn("＋ Вид работ", "works")}${btn("＋ Материал", "materials")}</div><input data-search placeholder="Поиск по всем справочникам" aria-label="Поиск в справочнике">${[
    ["equipment", "Техника"],
    ["people", "Рабочие и ИТР"],
    ["works", "Виды работ"],
    ["materials", "Материалы"],
  ]
    .map(([key, label]) => {
      const list = [
        ...new Map(
          [...(registry[key] || []), ...c[key]].map((x) => [x.id, x]),
        ).values(),
      ];
      return `<h3>${label}</h3>${
        rankChoices(list)
          .map(
            (x) =>
              `<div class="tn-catalog-row">${esc(x.name)} ${key === "people" && x.group === "itr" ? btn(esc(x.phone || "Добавить телефон"),"phone",`data-person="${esc(x.id)}"`) : ""}<small>${esc(x.plate || x.number || x.unit || { worker: "Рабочий", itr: "ИТР" }[x.group] || "")}</small></div>`,
          )
          .join("") || "<p>Пока нет записей</p>"
      }`;
    })
    .join("")}`;
  root.querySelectorAll("[data-person]").forEach(b=>b.onclick=()=>{
    const person=c.people.find(p=>p.id===b.dataset.person);
    if(!person) return;
    dialog("Телефон ИТР: "+person.name,field("Телефон",input("phone",person.phone || "",'type="tel" required')),async f=>{
      s.require("settings","edit");
      const next=s.config(), before=s.store.get(s.key("config"));
      next.people=next.people.map(p=>p.id===person.id ? {...p,phone:String(f.get("phone")).trim()} : p);
      const key="_catalog/config", base=s.store.get(key), registry=base.data || {equipment:[],people:[]};
      registry.people=[...registry.people.filter(p=>p.id!==person.id),{...person,phone:String(f.get("phone")).trim()}];
      await s.store.save(key,registry,base,"Телефон ИТР");
      await s.saveConfig(next,before);await s.refresh();
    });
  });
  root.querySelector("[data-search]").oninput = (e) =>
    root
      .querySelectorAll(".tn-catalog-row")
      .forEach(
        (row) =>
          (row.hidden = !row.textContent
            .toLowerCase()
            .includes(e.target.value.toLowerCase())),
      );
  for (const [action, fn] of [
    ["equipment", s.addEquipment],
    ["person", s.addPerson],
    ["works", () => addDefinition(s, "works")],
    ["materials", () => addDefinition(s, "materials")],
  ])
    root.querySelector(`[data-action="${action}"]`).onclick = () =>
      Promise.resolve(fn()).catch(error);
}
