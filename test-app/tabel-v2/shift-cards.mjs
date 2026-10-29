import { numberInput, bindNumericFields } from "./number-input.mjs";
import * as D from "./table-domain.mjs";
import { esc, btn, input, field, dialog, error } from "./messages.mjs";
const tabs = [
  ["equipment", "Техника"],
  ["worker", "Рабочие"],
  ["itr", "ИТР"],
  ["values", "Материалы и объёмы работ"],
];
export async function mount(s, root) {
  const c = s.config(),
    key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    d = base.data?.deleted
      ? null
      : s.days().find((d) => d.date === s.day && d.shift === s.shift) ||
        base.data;
  root.innerHTML = `<div class="tn-date-nav">${btn("‹", "prev-date", 'aria-label="Предыдущая дата"')}<input type="date" data-day value="${s.day}" aria-label="Дата смены"><select data-shift aria-label="Смена"><option value="day">Дневная</option><option value="night" ${s.shift === "night" ? "selected" : ""}>Ночная</option></select>${btn("›", "next-date", 'aria-label="Следующая дата"')}${btn("Сегодня", "today")}</div><div class="tn-tools">${btn("Начать / добавить смену", "add-day")}${d ? btn(s.shiftTab === "values" ? "Добавить материалы" : "Выбрать состав", s.shiftTab === "values" ? "add-materials" : "choose-roster") + btn("Удалить смену", "delete-shift", 'class="tn-danger"') : ""}</div><section data-shift-content></section><div class="tn-shift-tabs" role="tablist">${tabs.map(([id, label]) => btn(label, "shift-tab", `data-tab="${id}" role="tab" aria-selected="${s.shiftTab === id}"`)).join("")}</div>`;
  const navigate = async (date, shift = s.shift) => {
    s.day = D.date(date);
    s.shift = shift;
    await s.refresh();
  };
  root.querySelector("[data-day]").onchange = (e) =>
    navigate(e.target.value).catch(error);
  root.querySelector("[data-shift]").onchange = (e) =>
    navigate(s.day, e.target.value).catch(error);
  root.querySelector("[data-action=today]").onclick = () =>
    navigate(D.today()).catch(error);
  root
    .querySelector("[data-action=delete-shift]")
    ?.addEventListener("click", () => {
      s.require("shift", "edit");
      const el = dialog(
        "Удалить смену?",
        `<p>${esc(c.name)} · ${D.display(s.day)} · ${s.shift === "night" ? "Ночь" : "День"}</p><p>Смена исчезнет из таблицы и отчётов. Её данные сохранятся в истории.</p>`,
        async () => {
          await s.save(
            key,
            { ...D.copy(d), deleted: true },
            base,
            "Удаление смены",
          );
          await s.refresh();
        },
      );
      el.querySelector("[type=submit]").textContent = "Удалить";
      el.querySelector("[type=submit]").classList.add("tn-danger");
    });
  root.querySelector("[data-action=prev-date]").onclick = () =>
    navigate(D.add(s.day, -1)).catch(error);
  root.querySelector("[data-action=next-date]").onclick = () =>
    navigate(D.add(s.day, 1)).catch(error);
  root.querySelector("[data-action=add-day]").onclick = () =>
    s.addDay().catch(error);
  root.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        s.shiftTab = b.dataset.tab;
        s.refresh().catch(error);
      }),
  );
  root
    .querySelector("[data-action=choose-roster]")
    ?.addEventListener("click", () => choose(s).catch(error));
  root.querySelector('[data-action=add-materials]')
    ?.addEventListener('click', () => chooseMaterials(s).catch(error));
  const content = root.querySelector("[data-shift-content]");
  if (!d) {
    content.innerHTML =
      "<p>Смена пока не создана. Нажмите «Начать / добавить смену».</p>";
    return;
  }
  if (s.shiftTab === "values") {
    content.innerHTML = `<form data-values>${[
      ["materials", "Материалы"],
      ["works", "Объёмы работ"],
    ]
      .map(
        ([kind, label]) =>
          `<h3>${label}</h3>${(kind === "materials" ? D.materialsForShift(c, d) : c[kind]).map((x) => field(x.name + " · " + x.unit, input("value:" + x.id, D.fmt(d.values[x.id]?.quantity), 'inputmode="decimal"')) + (kind === "materials" ? field("Направление", input("direction:" + x.id, d.values[x.id]?.direction ?? x.direction)) : "")).join("")}`,
      )
      .join("")}<button type="submit">Сохранить</button></form>`;
    bindNumericFields(content);
    content.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const next = D.copy(d);
        for (const [name, raw] of new FormData(e.target)) {
          const [kind, id] = name.split(":");
          if (kind === "value")
            D.setValue({ kind: "value", entity: id }, next, raw);
          else next.values[id] = { ...next.values[id], direction: String(raw) };
        }
        await s.save(key, next, base, "Материалы и объёмы работ");
        await s.refresh();
      } catch (e) {
        error(e);
      }
    };
    return;
  }
  const equipment = s.shiftTab === "equipment";
  const list = equipment
    ? [
        ...d.equipment.filter(
          (e) => !(c.hiddenEquipmentIds || []).includes(e.id),
        ),
      ].sort((a, b) => D.equipmentOrder(a) - D.equipmentOrder(b))
    : d.people.filter((p) => p.group === s.shiftTab);
  if (!equipment) {
    content.innerHTML = `<div class="tn-people-table">${list.map((e) => `<div class="tn-person-row"><span>${esc(e.name)}</span>${btn(D.fmt(e.hours) || "—", "hours", `data-entity="${esc(e.id)}" data-field="hours" aria-label="${esc(e.name + " · Часы за смену")}"`)}</div>`).join("") || "<p>Состав не выбран.</p>"}</div>`;
  } else {
    content.innerHTML = `<div class="tn-cards">${list.map((e) => `<article class="tn-equipment-card" data-card="${esc(e.id)}" style="--tn-equipment-color:${D.equipmentColor(c.equipment.find((x) => x.id === e.id) || e)}"><button class="tn-card-title" type="button" data-open="${esc(e.id)}"><span class="tn-machine-name">${esc(e.name)}</span>${equipment ? "<small>Последние 5 дней ›</small>" : ""}</button><div class="tn-card-hours">${(equipment ? equipmentFields(e) : [["hours", "Часы за смену"]]).map(([field, label]) => `<label>${esc(label)}${btn(D.fmt(e[field]) || "—", "hours", `data-entity="${esc(e.id)}" data-field="${field}" aria-label="${esc(e.name + " · " + label)}"`)}</label>`).join("")}</div></article>`).join("") || "<p>Состав не выбран.</p>"}</div>`;
  }
  if (equipment)
    for (const e of list.filter((x) => x.ownership === "hired")) {
      const card = content.querySelector('[data-card="' + e.id + '"]');
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tn-contractor";
      b.textContent = e.contractor || "Без контрагента";
      card.querySelector(".tn-card-hours").append(b);
      b.onclick = () => {
        const registry = s.store.get("_catalog/config").data?.contractors || [];
        const el = dialog(
          "Контрагент этой смены",
          field(
            "Фирма",
            `<input name="contractor" list="tn-contractors" value="${esc(e.contractor || "")}"><datalist id="tn-contractors">${registry
              .filter((x) => !x.deleted)
              .map((x) => `<option value="${esc(x.name)}">`)
              .join("")}</datalist>`,
          ),
          async (f) => {
            const name = String(f.get("contractor")).trim(),
              next = D.copy(d),
              machine = next.equipment.find((x) => x.id === e.id);
            machine.contractor = name;
            machine.contractorId = name.toLocaleLowerCase();
            await s.save(key, next, base, "Контрагент за " + D.display(s.day));
            const catBase = s.store.get("_catalog/config"),
              cat = catBase.data || { equipment: [], people: [] };
            cat.contractors ||= [];
            if (
              name &&
              !cat.contractors.some((x) => x.id === machine.contractorId)
            ) {
              cat.contractors.push({ id: machine.contractorId, name });
              await s.store.save(
                "_catalog/config",
                cat,
                catBase,
                "Справочник контрагентов",
              );
            }
            await s.refresh();
          },
        );
      };
    }
  content.querySelectorAll("[data-open]").forEach(
    (b) =>
      (b.onclick = () => {
        if (equipment) multi(s, b.dataset.open).catch(error);
        else quick(s, "people", b.dataset.open, "hours").catch(error);
      }),
  );
  content
    .querySelectorAll("[data-entity]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          quick(
            s,
            equipment ? "equipment" : "people",
            b.dataset.entity,
            b.dataset.field,
          ).catch(error)),
    );
}
// Select existing catalog materials and/or create a new one for this object's
// specific date and shift. Keep entered volumes untouched on selection edits.
export async function chooseMaterials(s) {
  s.require('shift','edit');
  const c=s.config(), key=s.key(D.dayKey(s.day,s.shift)), base=s.store.get(key),
    day=base.data;
  if (!day || day.deleted) throw Error('Сначала начните смену');
  const registry=s.store.get('_catalog/config').data?.materials || [];
  const available=[...new Map([...registry,...c.materials].filter(x=>!x.deleted).map(x=>[x.id,x])).values()];
  const chosen=new Set(D.materialsForShift(c,day).map(m=>m.id));
  const el=dialog('Добавить материалы',
    '<p>Выберите материалы из базы для этой смены или создайте новый. Объёмы уже введённых материалов сохраняются.</p>'+
    '<input data-search placeholder="Поиск материала" aria-label="Поиск материала">'+
    '<div data-material-options>'+available.map(m=>
      `<label class="tn-check"><input type="checkbox" name="materialId" value="${esc(m.id)}" ${chosen.has(m.id)?'checked':''}>${esc(m.name)} · ${esc(m.unit||'м³')}</label>`
    ).join('')+'</div><h4>＋ Новый материал</h4>'+
    field('Название',input('newName','', 'maxlength="180" placeholder="Оставьте пустым, если новый не нужен"'))+
    field('Единица',input('newUnit','м³', 'maxlength="25"'))+
    field('Направление',input('newDirection','', 'maxlength="180"'))+
    field('Раздел','<select name="newSection"><option value="receipt">Поступление</option><option value="granulate">Гранулят</option></select>'),
    async f=>{
      s.require('shift','edit');
      const ids=new Set(f.getAll('materialId'));
      const name=String(f.get('newName')||'').trim();
      const unit=String(f.get('newUnit')||'').trim();
      const direction=String(f.get('newDirection')||'').trim();
      const section=f.get('newSection')==='granulate'?'granulate':'receipt';
      let newMaterial=null;
      if(name){
        s.require('settings','edit');
        if(name.length>180 || !unit || unit.length>25)throw Error('Укажите название и единицу нового материала');
        const existing=available.find(x=>x.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru') && (x.unit||'м³')===unit && (x.direction||'')===direction);
        newMaterial=existing || {id:D.uid(),name,unit,direction,section};
        ids.add(newMaterial.id);
      }
      if(newMaterial && !available.some(x=>x.id===newMaterial.id)){
        const catBase=s.store.get('_catalog/config'),catalog=catBase.data || {equipment:[],people:[],materials:[],works:[]};
        catalog.materials ||= [];
        if(!catalog.materials.some(x=>x.id===newMaterial.id))catalog.materials.push(newMaterial);
        const saved=await s.store.save('_catalog/config',catalog,catBase,'Новый материал: '+name);
        if(!saved)throw Error('Конфликт справочника: повторите добавление');
      }
      const configBase=s.store.get(s.key('config')),nextConfig=D.copy(s.config());
      for(const m of available){
        if(ids.has(m.id) && !nextConfig.materials.some(x=>x.id===m.id))
          nextConfig.materials.push({...m,assignedOnly:true});
      }
      if(newMaterial && !nextConfig.materials.some(x=>x.id===newMaterial.id))
        nextConfig.materials.push({...newMaterial,assignedOnly:true});
      const changed=JSON.stringify(nextConfig.materials)!==JSON.stringify(c.materials);
      if(changed)await s.saveConfig(nextConfig,configBase);
      const dayBase=s.store.get(key),nextDay=D.copy(dayBase.data||day);
      nextDay.materialIds=[...ids];
      const saved=await s.store.save(key,nextDay,dayBase,'Материалы состава смены');
      if(!saved)throw Error('Конфликт смены: повторите выбор материалов');
      await s.refresh();
    });
  const search=el.querySelector('[data-search]');
  search.oninput=()=>{
    const term=search.value.toLocaleLowerCase('ru');
    el.querySelectorAll('[data-material-options] label').forEach(label=>{
      label.hidden=!label.textContent.toLocaleLowerCase('ru').includes(term);
    });
  };
  return el;
}
function equipmentFields(e) {
  return [
    ["hours", "Техника"],
    ...(e.ownership === "hired"
      ? []
      : [
          ["crewHours", D.crewLabel(e)],
          ...(D.isWater(e) && e.pump ? [["pumpHours", "Помпа"]] : []),
        ]),
  ];
}
export async function quick(s, kind, id, field) {
  const key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    entry = base.data?.[kind].find((e) => e.id === id);
  if (!entry) throw Error("Нет в составе смены");
  return numberInput(
    entry.name + " · " + D.display(s.day),
    D.fmt(entry[field]),
    async (value) => {
      const next = D.copy(base.data);
      D.setValue({ kind, entity: id, field }, next, value);
      await s.save(key, next, base, "Часы смены");
      await s.refresh();
    },
  );
}
async function choose(s) {
  const c = s.config(),
    key = s.key(D.dayKey(s.day, s.shift)),
    base = s.store.get(key),
    d = base.data?.deleted ? null : base.data;
  if (!d) throw Error("Сначала начните смену");
  const equipment = s.shiftTab === "equipment",
    group = s.shiftTab === "itr" ? "itr" : "worker",
    kind = equipment ? "equipment" : "people",
    list = equipment ? c.equipment : c.people.filter((p) => p.group === group),
    selected = new Set(d[kind].map((x) => x.id));
  const el = dialog(
    "Состав: " + (equipment ? "техника" : group === "itr" ? "ИТР" : "рабочие"),
    '<input data-search placeholder="Поиск в базе">' +
      list
        .map(
          (e) =>
            `<div class="tn-roster-option"><label class="tn-check"><input type="checkbox" data-choice="${esc(e.id)}" ${selected.has(e.id) ? "checked" : ""}>${esc(e.name)}</label>${equipment && D.isWater(e) && e.ownership !== "hired"
              ? `<label class="tn-check"><input type="checkbox" data-pump="${esc(e.id)}" ${(d.equipment.find(x => x.id === e.id)?.pump ?? e.pump) ? "checked" : ""} ${selected.has(e.id) ? "" : "disabled"}>Помпа · ${esc(e.name)}</label>`
              : ""}</div>`,
        )
        .join(""),
    async () => {
      const next = D.copy(d),
        chosen = list
          .filter((e) => selected.has(e.id))
          .map((e) => ({
            ...e,
            hours: e.group === "itr" && s.day <= D.today() ? 12 : null,
            crewHours: null,
            pumpHours: null,
            ...d[kind].find((x) => x.id === e.id),
            ...(equipment ? {pump:D.isWater(e) && e.ownership !== "hired" &&
              !!el.querySelector('[data-pump="'+CSS.escape(e.id)+'"]')?.checked} : {}),
          }));
      next[kind] = equipment
        ? chosen
        : [...d.people.filter((p) => p.group !== group), ...chosen];
      await s.save(key, next, base, "Состав " + group);
      await s.refresh();
    },
  );
  el.querySelector("[data-search]").oninput = (e) =>
    el
      .querySelectorAll(".tn-check")
      .forEach(
        (x) =>
          (x.hidden = !x.textContent
            .toLowerCase()
            .includes(e.target.value.toLowerCase())),
      );
  el.querySelectorAll("[data-choice]").forEach((i) => {
    i.onchange = () => {
      if(i.checked)selected.add(i.dataset.choice);
      else selected.delete(i.dataset.choice);
      const pump=el.querySelector('[data-pump="'+CSS.escape(i.dataset.choice)+'"]');
      if(pump)pump.disabled=!i.checked;
    };
  });
}
export async function multi(s, id) {
  const c = s.config(),
    end = s.day,
    start = D.add(end, -4),
    dates = D.days(start, end),
    machine =
      c.equipment.find((e) => e.id === id) ||
      s
        .days()
        .flatMap((d) => d.equipment)
        .find((e) => e.id === id);
  if (!machine) throw Error("Техника не найдена");
  const snapshots = dates.map((date) => ({
      date,
      key: s.key(D.dayKey(date, s.shift)),
      ...s.store.get(s.key(D.dayKey(date, s.shift))),
    })),
    fields = equipmentFields(machine),
    draftKey = s.key("draft:multi:" + id + ":" + s.shift),
    draft = s.store.get(draftKey).data;
  let active = null,
    saving = Promise.resolve();
  const el = dialog(
    machine.name,
    `${D.isMill(machine) && machine.ownership !== "hired" ? `<label class="tn-check tn-double-crew"><input type="checkbox" data-double-crew ${(draft?.doubleCrew ?? machine.doubleCrew) ? "checked" : ""}>×2 · Два машиниста</label><p class="tn-hint">Удваиваются часы машинистов: 13 → 26, 14 → 28. Часы техники вводятся отдельно.</p>` : ""}<table class="tn-five-days"><thead><tr><th></th>${dates.map((date) => `<th>${D.display(date).slice(0, 5)}</th>`).join("")}</tr></thead><tbody>${fields
      .map(
        ([field, label]) =>
          `<tr><th>${esc(label)}</th>${snapshots
            .map((r) => {
              const e = r.data?.equipment.find((x) => x.id === id),
                name = r.key + "|" + field,
                enabled =
                  r.date >= c.start &&
                  (!c.end || r.date <= c.end) &&
                  r.date <= D.today();
              return `<td><input readonly inputmode="none" name="${esc(name)}" value="${esc(draft?.values?.[name] ?? D.fmt(e?.[field]))}" aria-label="${esc(label + " " + r.date)}" ${enabled ? "" : "disabled"}></td>`;
            })
            .join("")}</tr>`,
      )
      .join(
        "",
      )}</tbody></table><div class="tn-hour-row">${Array.from({ length: 14 }, (_, i) => btn(i + 1, "hour", `data-hour="${i + 1}"`)).join("")}</div>${btn("Очистить ячейку", "clear-cell")}<p class="tn-hint">Выберите ячейку, затем часы.</p>`,
    async () => {
      await saving;
      const f = new FormData(el.querySelector("form"));
      // Build and validate all days before saving any of them.
      const updates = [];
      for (const r of snapshots) {
        const changes = fields.filter(
          ([field]) =>
            f.get(r.key + "|" + field) !== null &&
            String(f.get(r.key + "|" + field)) !==
              D.fmt(r.data?.equipment.find((x) => x.id === id)?.[field]),
        );
        if (!changes.length) continue;
        const before = draft?.snapshots?.[r.key] || r,
          next = before.data
            ? D.copy(before.data)
            : D.createDay(c, r.date, s.shift);
        if (!next.equipment.some((e) => e.id === id))
          next.equipment.push({
            ...machine,
            hours: null,
            crewHours: null,
            pumpHours: null,
          });
        for (const [field] of changes)
          D.setValue(
            { kind: "equipment", entity: id, field },
            next,
            f.get(r.key + "|" + field),
          );
        updates.push({ r, before, next });
      }
      for (const { r, before, next } of updates)
        await s.save(r.key, next, before, "Часы техники за 5 дней");
      await s.store.serialize(async () => {
        delete s.store.state.records[draftKey];
        await s.store.persist();
      });
      await s.refresh();
    },
  );
  el.classList.add("tn-five-dialog");
  const cache = () => {
    const values = Object.fromEntries(new FormData(el.querySelector("form")));
    saving = saving
      .then(() =>
        s.store.serialize(async () => {
          s.store.state.records[draftKey] = {
            revision: 0,
            data: {
              values,
              doubleCrew: !!el.querySelector("[data-double-crew]")?.checked,
              snapshots:
                draft?.snapshots ||
                Object.fromEntries(snapshots.map((r) => [r.key, r])),
            },
          };
          await s.store.persist();
        }),
      )
      .catch(error);
  };
  el.querySelectorAll(".tn-five-days input:not(:disabled)").forEach((i) => {
    i.onpointerdown = (e) => e.preventDefault();
    i.onclick = () => {
      active = i;
      el.querySelectorAll(".tn-five-days input").forEach((x) =>
        x.classList.toggle("tn-active-cell", x === i),
      );
    };
  });
  el.querySelector("[data-double-crew]")?.addEventListener(
    "change",
    async (e) => {
      cache();
      try {
        const config = s.config(),
          before = s.store.get(s.key("config"));
        config.equipment = config.equipment.map((x) =>
          x.id === id ? { ...x, doubleCrew: e.target.checked } : x,
        );
        await s.saveConfig(config, before);
        const cb = s.store.get("_catalog/config"),
          cat = cb.data || { equipment: [], people: [] };
        cat.equipment = [
          ...(cat.equipment || []).filter((x) => x.id !== id),
          config.equipment.find((x) => x.id === id),
        ];
        await s.store.save("_catalog/config", cat, cb, "Два машиниста");
      } catch (err) {
        error(err);
      }
    },
  );
  el.querySelectorAll("[data-hour]").forEach(
    (b) =>
      (b.onclick = () => {
        if (!active) {
          error("Сначала выберите ячейку");
          return;
        }
        active.value = D.fiveDayHours(
          machine,
          active.name.split("|").at(-1),
          b.dataset.hour,
          !!el.querySelector("[data-double-crew]")?.checked,
        );
        cache();
      }),
  );
  el.querySelector("[data-action=clear-cell]").onclick = () => {
    if (active) {
      active.value = "";
      cache();
    }
  };
}
