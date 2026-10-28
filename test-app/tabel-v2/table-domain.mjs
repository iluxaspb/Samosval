import { countEquipment } from "./domain.mjs";
export const VERSION = "2.1.0-test.1";
export const copy = (x) => structuredClone(x);
export const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
export function date(s) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    new Date(s + "T12:00:00Z").toISOString().slice(0, 10) !== s
  )
    throw Error("Некорректная дата");
  return s;
}
export function add(s, n) {
  const d = new Date(date(s) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const display = (s) => date(s).split("-").reverse().join(".");
export function days(a, b) {
  const out = [];
  date(a);
  date(b);
  for (let d = a; d <= b; d = add(d, 1)) {
    if (out.length === 3660) throw Error("Период превышает 10 лет");
    out.push(d);
  }
  return out;
}
export const monday = (s) =>
  add(s, -((new Date(date(s) + "T12:00:00Z").getUTCDay() + 6) % 7));
export function weeks(a, b) {
  const out = [];
  for (let d = monday(a); d <= b; d = add(d, 7))
    out.push({
      id: d,
      start: d < a ? a : d,
      end: add(d, 6) > b ? b : add(d, 6),
    });
  return out;
}
export function numeric(raw, max = 1e9) {
  const s = String(raw ?? "")
    .trim()
    .replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(s) || Number(s) > max)
    throw Error(
      "Введите число от 0 до " + max + " (до трёх знаков после запятой)",
    );
  return Number(s);
}
export const fmt = (n) =>
  n == null
    ? ""
    : Number(n).toLocaleString("ru-RU", {
        maximumFractionDigits: 3,
        useGrouping: false,
      });
export const uid = () => crypto.randomUUID();
export function config(object) {
  return {
    schema: 1,
    objectId: object.id,
    name: object.name,
    start: object.startDate?.slice(0, 10) || today(),
    end: "",
    equipment: [],
    people: [],
    works: [],
    materials: [],
    request: {
      equipment: [],
      people: [],
      date: add(today(), 1),
      note: "",
      lunch: "",
      lunchNote: "",
    },
    newSheet: "ask",
    countEquipment: "roster",
    acl: {},
    period: "all",
    volumeSource: "manual",
  };
}
export const dayKey = (d, shift) => "day:" + date(d) + ":" + shift;
export function createDay(c, d, shift = "day") {
  date(d);
  if (d < c.start || (c.end && d > c.end))
    throw Error("Дата вне периода объекта");
  if (!["day", "night"].includes(shift)) throw Error("Неизвестная смена");
  return {
    date: d,
    shift,
    closed: false,
    planned: d > today(),
    equipment: c.equipment
      .filter((e) => c.request.equipment.includes(e.id))
      .map((e) => ({
        ...copy(e),
        hours: null,
        crewHours: null,
        pumpHours: null,
      })),
    people: c.people
      .filter((p) => c.request.people.includes(p.id))
      .map((p) => ({ ...copy(p), hours: null })),
    values: {},
  };
}
export const shiftLabel = (d) =>
  d.shift === "night"
    ? Number(d.date.slice(-2)) + "/" + Number(add(d.date, 1).slice(-2))
    : String(Number(d.date.slice(-2)));
export function crewLabel(e) {
  return (
    e.crewLabel ||
    (/фрез/i.test(e.name)
      ? "Машинисты фрезы"
      : /тракт|щ[её]т|мтз/i.test(e.name)
        ? "Тракторист"
        : /полив/i.test(e.name)
          ? "Водитель поливомойки"
          : "Машинисты / водители")
  );
}
export function rows(c, shifts) {
  const result = [],
    machines = new Map(
      c.equipment
        .filter((e) => c.request.equipment.includes(e.id))
        .map((e) => [e.id, e]),
    ),
    people = new Map(
      c.people
        .filter((p) => c.request.people.includes(p.id))
        .map((p) => [p.id, p]),
    );
  for (const d of shifts) {
    for (const e of d.equipment)
      machines.set(e.id, { ...e, pump: e.pump || machines.get(e.id)?.pump });
    for (const p of d.people) people.set(p.id, p);
  }
  const section = (name) =>
    result.push({
      id: "section:" + name,
      name,
      section: true,
      color: "#000000",
    });
  const equipment = (e) => {
    const color =
      e.ownership === "hired"
        ? "#ffdc70"
        : /фрез/i.test(e.name)
          ? "#00e5e5"
          : /тракт|щ[её]т/i.test(e.name)
            ? "#bf9600"
            : "#a4c2f4";
    result.push({
      id: e.id + ":hours",
      name: e.name,
      kind: "equipment",
      entity: e.id,
      field: "hours",
      color,
    });
    if (e.ownership !== "hired") {
      result.push({
        id: e.id + ":crewHours",
        name: crewLabel(e),
        kind: "equipment",
        entity: e.id,
        field: "crewHours",
        color,
      });
      if (e.pump)
        result.push({
          id: e.id + ":pumpHours",
          name: "Помпа · " + e.name,
          kind: "equipment",
          entity: e.id,
          field: "pumpHours",
          color,
        });
    }
  };
  section("Своя техника");
  [...machines.values()]
    .filter((e) => e.ownership !== "hired")
    .forEach(equipment);
  section("Поступление");
  [...machines.values()]
    .filter((e) => e.ownership === "hired")
    .forEach(equipment);
  const material = (m, i) =>
    result.push({
      id: m.id,
      name: m.name + " · " + m.unit + (m.direction ? " · " + m.direction : ""),
      kind: "value",
      entity: m.id,
      color:
        m.section === "receipt"
          ? "#ffdc70"
          : ["#ff9900", "#ffff00", "#00ee00"][i % 3],
    });
  c.materials.filter((m) => m.section === "receipt").forEach(material);
  section("Гранулят");
  c.materials.filter((m) => m.section !== "receipt").forEach(material);
  section("Объём работ");
  c.works.forEach((w) =>
    result.push({
      id: w.id,
      name: w.name + " · " + w.unit,
      kind: "value",
      entity: w.id,
      color: "#a4c2f4",
    }),
  );
  for (const [group, label] of [
    ["itr", "ИТР"],
    ["worker", "Рабочие"],
  ]) {
    section(label);
    [...people.values()]
      .filter((p) => p.group === group)
      .forEach((p) =>
        result.push({
          id: p.id,
          name: p.name,
          kind: "people",
          entity: p.id,
          field: "hours",
          color: "#fce5cd",
        }),
      );
  }
  return result;
}
export function value(row, d) {
  if (!d) return null;
  if (row.kind === "value") return d.values[row.entity]?.quantity ?? null;
  const e = d[row.kind].find((e) => e.id === row.entity);
  if (row.field === "pumpHours" && !e?.pump) return null;
  return e?.[row.field] ?? null;
}
export function setValue(row, d, raw) {
  if (d.closed)
    throw Error("Смена закрыта. Сначала откройте её для исправления.");
  if (d.date > today())
    throw Error(
      "Будущая смена — план. Фактические часы и объёмы вводятся после наступления дня.",
    );
  const n = numeric(
    raw,
    row.kind === "people" || row.field === "hours" || row.field === "pumpHours"
      ? 24
      : 1e9,
  );
  if (row.kind === "value") {
    d.values[row.entity] = { ...d.values[row.entity], quantity: n };
    return;
  }
  const e = d[row.kind].find((e) => e.id === row.entity);
  if (!e)
    throw Error("Этой строки нет в составе смены. Добавьте её через «Состав».");
  if (row.field === "pumpHours" && !e.pump)
    throw Error("Помпа выключена в этой смене");
  e[row.field] = n;
}
export function plate(s) {
  return String(s || "")
    .toUpperCase()
    .replace(
      /[АВЕКМНОРСТУХ]/g,
      (c) =>
        ({
          А: "A",
          В: "B",
          Е: "E",
          К: "K",
          М: "M",
          Н: "H",
          О: "O",
          Р: "P",
          С: "C",
          Т: "T",
          У: "Y",
          Х: "X",
        })[c],
    )
    .replace(/[^A-Z0-9]/g, "");
}
export function equipmentCount(shifts, line, c) {
  const equipment = shifts.flatMap((d) =>
    d.equipment.filter((e) => c.countEquipment !== "hours" || e.hours > 0),
  );
  const normalize = (e) => ({ ...e, number: e.plate || e.number });
  return countEquipment(
    equipment.map(normalize),
    line.map(normalize),
    c.equipment.map(normalize),
  );
}
export function report(
  c,
  shifts,
  line = { rows: [], complete: false },
  d = today(),
) {
  const worked = (g) => {
    const all = shifts.flatMap((s) => s.people.filter((p) => p.group === g));
    return !all.length
      ? "не заполнено"
      : new Set(all.filter((p) => p.hours > 0).map((p) => p.id)).size +
          (all.some((p) => p.hours === null)
            ? " (есть незаполненные часы)"
            : "");
  };
  return (
    "Отчёт за " +
    display(d) +
    "\nОбъект: " +
    c.name +
    "\nСмены: " +
    shifts.map((s) => (s.shift === "night" ? "ночная" : "дневная")).join(", ") +
    "\nВыполненные работы:\n" +
    (c.works
      .map((w) => {
        const v = shifts
          .map((s) => s.values[w.id]?.quantity)
          .filter((n) => n != null);
        return (
          "— " +
          w.name +
          ": " +
          (v.length
            ? fmt(v.reduce((a, b) => a + b, 0)) + " " + w.unit
            : "не заполнено")
        );
      })
      .join("\n") || "не заполнено") +
    "\nИТР: " +
    worked("itr") +
    "\nРабочие: " +
    worked("worker") +
    "\nТехника: " +
    (shifts.some((s) => s.equipment.length) || line.rows.length
      ? equipmentCount(shifts, line.rows, c) + " ед."
      : "не заполнено") +
    (line.complete
      ? ""
      : "\nВнимание: история прибытий «Линии» неполная; количество техники требует проверки.")
  );
}
export const colName = (n) => {
  let s = "";
  for (n++; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const cell = (r, c) => colName(c) + (r + 1);
export function coords(k) {
  const m = /^([A-Z]+)([1-9]\d*)$/i.exec(k);
  if (!m) throw Error("#ССЫЛКА!");
  let c = 0;
  for (const s of m[1].toUpperCase()) c = c * 26 + s.charCodeAt(0) - 64;
  return { r: Number(m[2]) - 1, c: c - 1 };
}
export function range(a, b) {
  const p = coords(a),
    q = coords(b),
    out = [];
  if ((Math.abs(p.r - q.r) + 1) * (Math.abs(p.c - q.c) + 1) > 10000)
    throw Error("Диапазон больше 10000 ячеек");
  for (let r = Math.min(p.r, q.r); r <= Math.max(p.r, q.r); r++)
    for (let c = Math.min(p.c, q.c); c <= Math.max(p.c, q.c); c++)
      out.push(cell(r, c));
  return out;
}
export function formula(
  cells,
  key,
  size = { rows: 200, cols: 40 },
  stack = new Set(),
  memo = new Map(),
) {
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return "#ЦИКЛ!";
  if (stack.size > 100) return "#ГЛУБИНА!";
  const p = coords(key);
  if (p.r >= size.rows || p.c >= size.cols) return "#ССЫЛКА!";
  const raw = String(cells[key]?.raw ?? "");
  if (!raw.startsWith("="))
    return /^-?\d+(?:[.,]\d+)?$/.test(raw)
      ? Number(raw.replace(",", "."))
      : raw;
  stack.add(key);
  let result;
  try {
    const src = raw
        .slice(1)
        .toUpperCase()
        .replace(/СУММ/g, "SUM")
        .replace(/−/g, "-"),
      tokens =
        src.match(/\s+|\d+(?:[.,]\d+)?|[A-Z]+[1-9]\d*|SUM|[()+*/:\-]/g) || [];
    if (tokens.join("") !== src || tokens.length > 500)
      throw Error("#ФОРМУЛА!");
    const t = tokens.filter((x) => x.trim());
    let i = 0;
    const ref = (k) => {
      const n = formula(cells, k, size, new Set(stack), memo);
      if (n === "") return 0;
      if (typeof n !== "number")
        throw Error(String(n).startsWith("#") ? n : "#ЗНАЧ!");
      return n;
    };
    function atom() {
      const a = t[i++];
      if (a === "-" || a === "+") return (a === "-" ? -1 : 1) * atom();
      if (a === "(") {
        const v = expr();
        if (t[i++] !== ")") throw Error("#ФОРМУЛА!");
        return v;
      }
      if (a === "SUM") {
        if (t[i++] !== "(") throw Error("#ФОРМУЛА!");
        const from = t[i++];
        if (t[i++] !== ":") throw Error("#ФОРМУЛА!");
        const to = t[i++];
        if (t[i++] !== ")") throw Error("#ФОРМУЛА!");
        return range(from, to).reduce((n, k) => n + ref(k), 0);
      }
      if (/^[A-Z]+\d+$/.test(a || "")) return ref(a);
      if (/^\d+(?:[.,]\d+)?$/.test(a || "")) return Number(a.replace(",", "."));
      throw Error("#ФОРМУЛА!");
    }
    function term() {
      let v = atom();
      while (["*", "/"].includes(t[i])) {
        const op = t[i++],
          b = atom();
        if (op === "/" && b === 0) throw Error("#ДЕЛ/0!");
        v = op === "*" ? v * b : v / b;
      }
      return v;
    }
    function expr() {
      let v = term();
      while (["+", "-"].includes(t[i])) {
        const op = t[i++],
          b = term();
        v = op === "+" ? v + b : v - b;
      }
      return v;
    }
    result = expr();
    if (i !== t.length || !Number.isFinite(result)) throw Error("#ФОРМУЛА!");
  } catch (e) {
    result = e.message.startsWith("#") ? e.message : "#ФОРМУЛА!";
  }
  stack.delete(key);
  memo.set(key, result);
  return result;
}
export function translate(raw, dr, dc) {
  return String(raw).startsWith("=")
    ? raw.replace(/\b([A-Z]+[1-9]\d*)\b/gi, (k) => {
        const p = coords(k);
        return p.r + dr < 0 || p.c + dc < 0
          ? "#ССЫЛКА!"
          : cell(p.r + dr, p.c + dc);
      })
    : raw;
}
export function allowed(actor, c, area, mode = "view") {
  if (!actor?.uid || actor.status !== "active" || !actor.tabAccess)
    return false;
  if (actor.role === "admin") return true;
  if (actor.hostPermissions)
    return actor.permissions?.[mode === "view" ? "view" : "edit"] === true;
  return (
    actor.permissions?.[mode === "view" ? "view" : "edit"] === true &&
    (c.acl?.["user:" + actor.uid]?.[area + "." + mode] === true ||
      c.acl?.["role:" + actor.role]?.[area + "." + mode] === true)
  );
}
export function describeChange(before, after) {
  if (!before?.equipment || !after?.equipment)
    return "Изменяется запись целиком; точные поля приведены ниже.";
  const out = [];
  for (const kind of ["equipment", "people"]) {
    const a = new Map(before[kind].map((e) => [e.id, e])),
      b = new Map(after[kind].map((e) => [e.id, e]));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(id),
        next = b.get(id);
      if (!old || !next) {
        out.push((next ? "Добавлено: " : "Исключено: ") + (next || old).name);
        continue;
      }
      for (const field of kind === "people"
        ? ["hours"]
        : ["hours", "crewHours", "pumpHours"])
        if (old[field] !== next[field])
          out.push(
            next.name +
              " · " +
              {
                hours: "часы",
                crewHours: "часы персонала",
                pumpHours: "часы помпы",
              }[field] +
              ": " +
              (fmt(old[field]) || "не заполнено") +
              " → " +
              (fmt(next[field]) || "не заполнено"),
          );
    }
  }
  for (const id of new Set([
    ...Object.keys(before.values || {}),
    ...Object.keys(after.values || {}),
  ]))
    if (JSON.stringify(before.values[id]) !== JSON.stringify(after.values[id]))
      out.push(
        "Материал / работа " +
          id +
          ": " +
          fmt(before.values[id]?.quantity) +
          " → " +
          fmt(after.values[id]?.quantity),
      );
  return (
    out.join("\n") || "Часы и состав совпадают; изменены другие поля записи."
  );
}
