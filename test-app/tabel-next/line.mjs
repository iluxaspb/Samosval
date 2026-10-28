// Read-only adapter. A positive arrival counts even with no load or after departure.
import { add } from "./domain.mjs";
export function arrivals(
  snapshot,
  objectId,
  day,
  events = [],
  confirmed = false,
) {
  const trucks = new Map((snapshot.trucks || []).map((t) => [t.id, t]));
  const rows = [];
  let uncertain = false;
  const calendar = (ts) =>
    Number.isFinite(Number(ts))
      ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
          new Date(Number(ts)),
        )
      : "";
  for (const e of [...(snapshot.audit || []), ...events]) {
    if (
      e.objectId !== objectId ||
      (e.date || e.startDate || calendar(e.timestamp)).slice(0, 10) !== day ||
      e.eventType !== "arrive"
    )
      continue;
    if (!String(e.text || "").includes("Прибытие на линию")) {
      if (!String(e.text || "").includes("Снято прибытие")) uncertain = true;
      continue;
    }
    const t = trucks.get(e.truckId);
    if (!t && typeof e.isGAI !== "boolean") uncertain = true;
    rows.push({
      id: e.truckId,
      plate: t?.number || t?.plate || e.truckName,
      arrived: true,
      isGAI: !!(t?.isGAI || e.isGAI),
    });
  }
  const shift = snapshot.shift;
  if (
    shift?.objectId === objectId &&
    String(shift.startDate || "").slice(0, 10) === day
  )
    for (const [id, status] of Object.entries(snapshot.statuses || {})) {
      if (status.shiftId !== shift.id || !status.arriveTimestamp) continue;
      const t = trucks.get(id);
      if (!t) uncertain = true;
      rows.push({
        id,
        plate: t?.number || t?.plate,
        arrived: true,
        isGAI: !!t?.isGAI,
      });
    }
  for (const archive of snapshot.archive || []) {
    if (
      archive.objectId !== objectId ||
      String(archive.startDate || archive.date || "").slice(0, 10) !== day
    )
      continue;
    for (const log of archive.logs || []) {
      if (!log.arrivalTimestamp) continue;
      const t = trucks.get(log.truckId);
      if (!t && typeof log.isGAI !== "boolean") uncertain = true;
      rows.push({
        id: log.truckId,
        plate: t?.number || t?.plate || log.truckName,
        arrived: true,
        isGAI: !!(log.isGAI || t?.isGAI),
      });
    }
  }
  return { rows, complete: confirmed && !uncertain };
}
export async function lineReport(s, day, type) {
  let events = [],
    confirmed = false;
  try {
    if (s.ctx.refs?.audit) {
      const start = Date.parse(day + "T00:00:00+03:00"),
        end = Date.parse(add(day, 1) + "T00:00:00+03:00");
      const snapshot = await s.ctx.refs.audit
        .where("timestamp", ">=", start)
        .where("timestamp", "<", end)
        .orderBy("timestamp")
        .limit(3000)
        .get({ source: "server" });
      events = snapshot.docs.map((d) => d.data());
      confirmed = snapshot.size < 3000;
    }
  } catch {
    /* Cached history remains visibly incomplete. */
  }
  const result = arrivals(s.host.data(), s.object.id, day, events, confirmed);
  if (type !== "both") {
    result.complete = false;
    result.rows = [];
    result.note =
      "Разделение прибытий «Линии» по дневной/ночной смене требует проверенного соответствия ID смен. Для общего числа самосвалов выберите «День и ночь».";
  }
  return result;
}
