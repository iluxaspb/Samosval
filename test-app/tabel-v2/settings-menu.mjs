import * as D from "./table-domain.mjs";
import { rankChoices } from "./domain.mjs";
import { esc, btn, input, field, dialog, error } from "./messages.mjs";
const labels = {
  equipment: "Техника",
  workers: "Рабочие",
  itr: "ИТР",
  materials: "Материалы",
  plan: "Плановые объёмы работ",
  actual: "Объёмы работ за смену",
};
export function openSettings(s) {
  if (!s.object) throw Error("Выберите или создайте объект в заявках");
  s.require("settings");
  const el = dialog(
    "Настройки объекта",
    `<p>${esc(s.object.name)}</p><div class="tn-settings-menu">${Object.entries(
      labels,
    )
      .map(([key, label]) => btn(label, key))
      .join(
        "",
      )}</div>${field("Дата начала объекта", input("objectStart", s.config().start, 'type="date"'))}${btn("Сохранить дату начала", "save-start")}`,
  );
  for (const key of Object.keys(labels))
    el.querySelector(`[data-action="${key}"]`).onclick = () => {
      el.close();
      openCategory(s, key).catch(error);
    };
  el.querySelector("[data-action=save-start]").onclick = async () => {
    try {
      const c = s.config(),
        base = s.store.get(s.key("config")),
        start = D.date(el.querySelector("[name=objectStart]").value);
      if (s.days().some((d) => d.date < start))
        throw Error("До этой даты уже есть смены. Их нельзя скрывать.");
      c.start = start;
      await s.saveConfig(c, base);
      el.close();
      await s.refresh();
    } catch (e) {
      error(e);
    }
  };
  return el;
}
export async function openCategory(s, kind) {
  const c = s.config(),
    configBase = s.store.get(s.key("config")),
    date = s.day,
    shift = s.shift,
    key = s.key(D.dayKey(date, shift)),
    base = s.store.get(key),
    day = base.data || D.createDay(c, date, shift);
  let selected = new Set(),
    choices = [];
  let html = `<p class="tn-hint">${esc(c.name)} · ${D.display(date)} · ${shift === "night" ? "Ночь" : "День"}</p>`;
  if (["equipment", "workers", "itr"].includes(kind)) {
    choices = rankChoices(
      kind === "equipment"
        ? c.equipment
        : c.people.filter(
            (p) => p.group === (kind === "workers" ? "worker" : "itr"),
          ),
      "",
      c.usage || {},
    );
    selected = new Set(
      (kind === "equipment"
        ? day.equipment
        : day.people.filter(
            (p) => p.group === (kind === "workers" ? "worker" : "itr"),
          )
      ).map((x) => x.id),
    );
    html += `<input data-search placeholder="Поиск" aria-label="Поиск"><div data-choices></div>`;
    if (kind === "equipment")
      html += day.equipment
        .map(
          (e) =>
            `<section class="tn-item">${field(e.name + " · часы", input(e.id + ":hours", D.fmt(e.hours), 'inputmode="decimal"'))}${e.ownership === "hired" ? "" : field(D.crewLabel(e) + " · часы", input(e.id + ":crewHours", D.fmt(e.crewHours), 'inputmode="decimal"')) + `<label class="tn-check"><input name="pump" value="${e.id}" type="checkbox" ${e.pump ? "checked" : ""}>Помпа · ${esc(e.name)}</label>` + (e.pump ? field("Часы помпы", input(e.id + ":pumpHours", D.fmt(e.pumpHours), 'inputmode="decimal"')) : "")}</section>`,
        )
        .join("");
  } else if (kind === "materials") {
    html +=
      field(
        "Текущий материал с Линии",
        input("currentMaterial", c.currentMaterial || ""),
      ) +
      field(
        "Направления через запятую",
        input("destinations", (c.destinations || []).join(", ")),
      ) +
      c.materials
        .map(
          (m) =>
            `<div class="tn-item">${esc(m.name)} · ${esc(m.unit)} · ${esc(m.direction)}${field("За смену", input("material:" + m.id, D.fmt(day.values[m.id]?.quantity), 'inputmode="decimal"'))}</div>`,
        )
        .join("") +
      btn("＋ Добавить материал", "add-material");
  } else if (kind === "plan")
    html +=
      c.works
        .map(
          (w) =>
            `<section class="tn-item">${field("Наименование", input(w.id + ":name", w.name))}${field("Единица", input(w.id + ":unit", w.unit))}${field("Общий план", input(w.id + ":plan", D.fmt(w.plan), 'inputmode="decimal"'))}</section>`,
        )
        .join("") + btn("＋ Добавить работу", "add-work");
  else
    html += `<div class="tn-tools">${[-2, -1, 0].map((n, i) => btn(["Позавчера", "Вчера", "Сегодня"][i], "quick", `data-offset="${n}"`)).join("")}</div>${field("Дата выполнения", input("actualDate", date, 'type="date"'))}${field("Смена выполнения", `<select name="actualShift"><option value="day" ${shift === "day" ? "selected" : ""}>День</option><option value="night" ${shift === "night" ? "selected" : ""}>Ночь</option></select>`)}${c.works.map((w) => field(w.name + " · " + w.unit, input("work:" + w.id, D.fmt(day.values[w.id]?.quantity), 'inputmode="decimal"'))).join("")}`;
  const el = dialog(labels[kind], html, async (f) => {
    s.require("settings", "edit");
    if (kind !== "plan" && kind !== "actual" && day.closed)
      throw Error("Смена закрыта. Откройте её перед изменением.");
    const next = D.copy(c);
    let target = D.copy(day),
      targetKey = key,
      targetBase = base;
    if (["equipment", "workers", "itr"].includes(kind)) {
      if (kind === "equipment") {
        target.equipment = c.equipment
          .filter((e) => selected.has(e.id))
          .map((e) => ({
            ...e,
            hours: null,
            crewHours: null,
            pumpHours: null,
            ...day.equipment.find((x) => x.id === e.id),
            pump:
              e.ownership !== "hired" &&
              (f.getAll("pump").includes(e.id) ||
                (!day.equipment.some((x) => x.id === e.id) && e.pump)),
          }));
        next.request.equipment = [...selected];
        for (const e of target.equipment)
          for (const field of ["hours", "crewHours", "pumpHours"]) {
            const raw = f.get(e.id + ":" + field);
            if (raw !== null && raw !== D.fmt(e[field]))
              D.setValue(
                { kind: "equipment", entity: e.id, field },
                target,
                raw,
              );
          }
      } else {
        const group = kind === "workers" ? "worker" : "itr";
        target.people = [
          ...day.people.filter((p) => p.group !== group),
          ...c.people
            .filter((p) => p.group === group && selected.has(p.id))
            .map((p) => ({
              ...p,
              hours: day.people.find((x) => x.id === p.id)?.hours ?? null,
            })),
        ];
        next.request.people = [
          ...next.request.people.filter(
            (id) => c.people.find((p) => p.id === id)?.group !== group,
          ),
          ...selected,
        ];
      }
      next.usage = { ...next.usage };
      for (const id of selected)
        next.usage[id] = {
          count: (next.usage[id]?.count || 0) + 1,
          lastSelected: Date.now(),
        };
    } else if (kind === "materials") {
      next.currentMaterial = String(f.get("currentMaterial")).trim();
      next.destinations = String(f.get("destinations"))
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const m of c.materials) {
        const raw = f.get("material:" + m.id);
        if (raw !== D.fmt(day.values[m.id]?.quantity))
          D.setValue({ kind: "value", entity: m.id }, target, raw);
      }
    } else if (kind === "plan") {
      next.works = c.works.map((w) => ({
        ...w,
        name: String(f.get(w.id + ":name")).trim(),
        unit: String(f.get(w.id + ":unit")).trim(),
        plan: D.numeric(f.get(w.id + ":plan")),
      }));
      if (
        next.works.some(
          (w) =>
            w.unit !== c.works.find((x) => x.id === w.id).unit &&
            s.days().some((d) => d.values[w.id]?.quantity != null),
        )
      )
        throw Error(
          "Единицу нельзя менять после ввода факта. Добавьте новый вид работ.",
        );
      if (next.works.some((w) => !w.name || !w.unit))
        throw Error("Укажите наименование и единицу");
    } else {
      const d = D.date(f.get("actualDate")),
        sh = f.get("actualShift");
      targetKey = s.key(D.dayKey(d, sh));
      targetBase = s.store.get(targetKey);
      target = targetBase.data || D.createDay(c, d, sh);
      target = D.copy(target);
      for (const w of c.works)
        D.setValue(
          { kind: "value", entity: w.id },
          target,
          f.get("work:" + w.id),
        );
      s.day = d;
      s.shift = sh;
    }
    if (kind !== "plan")
      await s.save(targetKey, target, targetBase, "Настройки: " + labels[kind]);
    await s.saveConfig(next, configBase);
    await s.refresh();
  });
  if (choices.length) {
    const draw = () => {
      const filtered = new Set(
        rankChoices(choices, el.querySelector("[data-search]").value).map(
          (x) => x.id,
        ),
      );
      el.querySelector("[data-choices]").innerHTML = choices
        .filter((x) => filtered.has(x.id))
        .map(
          (x) =>
            `<label class="tn-check"><input type="checkbox" data-id="${esc(x.id)}" ${selected.has(x.id) ? "checked" : ""}>${esc(x.name)} ${esc(x.number || x.plate || "")}</label>`,
        )
        .join("");
      el.querySelectorAll("[data-id]").forEach(
        (i) =>
          (i.onchange = () =>
            i.checked
              ? selected.add(i.dataset.id)
              : selected.delete(i.dataset.id)),
      );
    };
    draw();
    el.querySelector("[data-search]").oninput = draw;
  }
  for (const [action, kind] of [
    ["add-material", "materials"],
    ["add-work", "works"],
  ])
    el.querySelector(`[data-action="${action}"]`)?.addEventListener(
      "click",
      () => {
        el.close();
        s.addDefinition(kind).catch(error);
      },
    );
  if (kind === "actual") {
    const refresh = () => {
      const d = el.querySelector("[name=actualDate]").value,
        sh = el.querySelector("[name=actualShift]").value,
        target = s.store.get(s.key(D.dayKey(d, sh))).data;
      for (const w of c.works)
        el.querySelector(`[name="work:${w.id}"]`).value = D.fmt(
          target?.values[w.id]?.quantity,
        );
    };
    el.querySelector("[name=actualDate]").onchange = refresh;
    el.querySelector("[name=actualShift]").onchange = refresh;
    el.querySelectorAll("[data-offset]").forEach(
      (b) =>
        (b.onclick = () => {
          el.querySelector("[name=actualDate]").value = D.add(
            D.today(),
            Number(b.dataset.offset),
          );
          refresh();
        }),
    );
  }
  return el;
}
