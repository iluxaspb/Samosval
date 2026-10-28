import { dialog, esc, btn } from "./messages.mjs";
export function oldBrushes(config, days, registry) {
  const known = new Set(registry.filter((x) => !x.deleted).map((x) => x.id)),
    hidden = new Set(config.hiddenEquipmentIds || []),
    found = new Map();
  const brush = (e) =>
    /щ[её]тк|муп.?351/i.test(e.name || "") || e.kind === "brush";
  if (!registry.some((e) => !e.deleted && brush(e))) return [];
  for (const day of [{ equipment: config.equipment || [] }, ...days])
    for (const e of day.equipment || []) {
      if (
        known.has(e.id) ||
        hidden.has(e.id) ||
        !brush(e) ||
        e.ownership !== "hired" ||
        e.crewLabel
      )
        continue;
      const row = found.get(e.id) || {
        id: e.id,
        name: e.name,
        dates: [],
        hours: 0,
      };
      if (day.date) {
        row.dates.push(day.date);
        row.hours += Number(e.hours || 0);
      }
      found.set(e.id, row);
    }
  return [...found.values()];
}
export function cleanupBrush(s) {
  const c = s.config(),
    registry = [
      ...(s.host.catalog?.equipment || []),
      ...(s.store.get("_catalog/config").data?.equipment || []),
    ],
    rows = oldBrushes(c, s.days(), registry);
  if (!rows.length)
    return dialog(
      "Старые записи щётки",
      "<p>Подходящих старых записей не найдено. Ничего не изменено.</p>",
    );
  const el = dialog(
    "Убрать старую щётку из табеля?",
    `<p>Ниже записи без строки тракториста, которых нет в текущем справочнике техники. Действующую щётку из справочника они не заменяют.</p>${rows.map((r) => `<label class="tn-check"><input name="legacy" value="${esc(r.id)}" type="checkbox">${esc(r.name)} · смен: ${r.dates.length} · часов: ${r.hours}</label>`).join("")}<p>Выбранные старые записи исчезнут из состава, таблицы и отчётов этого объекта. Исходные смены и введённые часы сохранятся для истории и восстановления. Действующая щётка останется.</p>`,
    async (f) => {
      s.require("settings", "edit");
      const ids = f.getAll("legacy");
      if (!ids.length) throw Error("Отметьте старую лишнюю щётку");
      const next = s.config(),
        base = s.store.get(s.key("config"));
      next.hiddenEquipmentIds = [
        ...new Set([...(next.hiddenEquipmentIds || []), ...ids]),
      ];
      next.request.equipment = next.request.equipment.filter(
        (id) => !ids.includes(id),
      );
      await s.saveConfig(next, base);
      await s.refresh();
    },
  );
  el.querySelector("[type=submit]").textContent =
    "Убрать выбранную старую запись";
  return el;
}
