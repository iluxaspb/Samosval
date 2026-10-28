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
const sections=[["equipment","Техника"],["worker","Рабочие"],["itr","ИТР"],["works","Виды работ"],["materials","Материалы"]];
export async function mount(s, root) {
 const c=s.config(),registry=s.store.get("_catalog/config").data||{},section=s.catalogTab||"equipment",key=["worker","itr"].includes(section)?"people":section;
 const list=[...new Map([...(c[key]||[]),...(registry[key]||[])].map(x=>[x.id,x])).values()].filter(x=>key!=="people"||x.group===section);
 root.innerHTML=`<div class="tn-catalog-list"><h3>${sections.find(x=>x[0]===section)[1]}</h3><div class="tn-tools">${btn("＋ Добавить","add-catalog")}</div><input data-search placeholder="Поиск" aria-label="Поиск в справочнике">${rankChoices(list).map(x=>`<div class="tn-catalog-row"><span>${esc(x.name)}<small>${esc(x.plate||x.unit||x.phone||"")}</small></span>${btn("Изменить","edit-catalog",`data-id="${esc(x.id)}"`)}</div>`).join("")||"<p>Пока нет записей</p>"}</div><div class="tn-catalog-tabs">${sections.map(([id,label])=>btn(label,"catalog-tab",`data-tab="${id}" aria-pressed="${id===section}"`)).join("")}</div>`;
 root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{s.catalogTab=b.dataset.tab;s.refresh().catch(error);});
 root.querySelector('[data-search]').oninput=e=>root.querySelectorAll('.tn-catalog-row').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(e.target.value.toLowerCase()));
 root.querySelector('[data-action=add-catalog]').onclick=()=>Promise.resolve(key==="equipment"?s.addEquipment():key==="people"?s.addPerson(section):addDefinition(s,key)).catch(error);
 root.querySelectorAll('[data-action=edit-catalog]').forEach(b=>b.onclick=()=>editItem(s,key,list.find(x=>x.id===b.dataset.id)).catch(error));
}
async function editItem(s,key,item){
 s.require("settings","edit");
 const el=dialog("Изменить: "+item.name,field("Название",input("name",item.name,'required maxlength="180"'))+(key==="equipment"?field("Госномер / номер",input("plate",item.plate||item.number||""))+field("Собственность",`<select name="ownership"><option value="own">Своя</option><option value="hired" ${item.ownership==="hired"?"selected":""}>Наёмная</option></select>`)+field("Подпись персонала",input("crewLabel",item.crewLabel||""))+(D.isWater(item)?'<label class="tn-check"><input name="pump" type="checkbox" '+(item.pump?'checked':'')+'>Есть помпа</label>':""):key==="people"?field("Телефон",input("phone",item.phone||"",'type="tel"')):field("Единица",input("unit",item.unit,'required'))+(key==="materials"?field("Направление",input("direction",item.direction||"")):key==="works"?field("План объекта",input("plan",D.fmt(item.plan),'inputmode="decimal"')):"")),async f=>{
  const next={...item,name:String(f.get("name")).trim()};if(!next.name)throw Error("Введите название");
  if(key==="equipment")Object.assign(next,{plate:String(f.get("plate")).trim(),ownership:f.get("ownership"),crewLabel:String(f.get("crewLabel")).trim(),kind:D.isWater(item)?"water":item.kind,pump:D.isWater(item)&&f.get("ownership")!=="hired"&&f.has("pump")});
  if(key==="people")next.phone=String(f.get("phone")).trim();
  if(["works","materials"].includes(key)){next.unit=String(f.get("unit")).trim();if(!next.unit)throw Error("Введите единицу");if(next.unit!==item.unit&&s.days().some(d=>d.values[item.id]?.quantity!=null))throw Error("После ввода объёмов единицу менять нельзя");}
  if(key==="works")next.plan=D.numeric(f.get("plan"));if(key==="materials")next.direction=String(f.get("direction")).trim();
  const catalogKey="_catalog/config",base=s.store.get(catalogKey),catalog=base.data||{equipment:[],people:[],works:[],materials:[]};catalog[key]=[...(catalog[key]||[]).filter(x=>x.id!==item.id),next];await s.store.save(catalogKey,catalog,base,"Редактирование справочника: "+next.name);
  const c=s.config(),before=s.store.get(s.key("config"));c[key]=[...c[key].filter(x=>x.id!==item.id),next];await s.saveConfig(c,before);await s.refresh();
 });return el;
}
