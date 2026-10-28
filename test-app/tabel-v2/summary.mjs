import { countEquipment, lineCalendarDate } from "./domain.mjs";
import { arrivals } from "./line.mjs";
let pending = null;
async function readRecords(session) {
  const name =
    "samosval_tabel_v2_v1_" +
    session.projectId +
    "_" +
    session.workspaceId +
    "_" +
    session.uid;
  return new Promise((resolve) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onerror = () => resolve({});
    r.onsuccess = () => {
      const db = r.result,
        t = db.transaction("state"),
        q = t.objectStore("state").get("main");
      q.onsuccess = () => resolve(q.result?.records || {});
      q.onerror = () => resolve({});
      t.oncomplete = () => db.close();
    };
  });
}
export async function updateHeader(host, element) {
  if (pending) return;
  const session = host.session(),
    snapshot = host.snapshot(),
    objectId = snapshot.shift?.objectId;
  if (!session.view || !session.active || !objectId) {
    element.hidden = true;
    return;
  }
  pending = true;
  try {
    const date = lineCalendarDate(snapshot.shift.startDate),
      records = await readRecords(session);
    if (
      host.session().uid !== session.uid ||
      host.snapshot().shift?.objectId !== objectId
    )
      return;
    const days = Object.entries(records)
      .filter(
        ([key, r]) =>
          key.startsWith(objectId + "/day:") && r.data?.date === date,
      )
      .map(([, r]) => r.data);
    let equipment = days.flatMap((d) => d.equipment),
      people = days.flatMap((d) => d.people);
    if (!days.length) {
      const raw = localStorage.getItem(
        JSON.stringify([
          "tabel-v2-draft",
          1,
          session.projectId,
          session.workspaceId,
          session.uid,
          objectId,
        ]),
      );
      if (raw) {
        try {
          const saved = JSON.parse(raw),
            old = (saved.shifts || [])
              .map(([, d]) => d)
              .filter((d) => d.date === date);
          equipment = old.flatMap((d) => d.settings.equipment);
          people = old.flatMap((d) => [
            ...(d.settings.workers || []).map((id) => ({
              id,
              group: "worker",
            })),
            ...(d.settings.itr || []).map((id) => ({ id, group: "itr" })),
          ]);
        } catch {}
      }
    }
    const line = arrivals(snapshot, objectId, date).rows.map((e) => ({
      ...e,
      number: e.plate,
    }));
    const total = countEquipment(
      equipment.map((e) => ({ ...e, number: e.plate || e.number })),
      line,
      snapshot.trucks || [],
    );
    element.hidden = false;
    element.textContent = `Техника: ${total} · Рабочие: ${new Set(people.filter((p) => p.group === "worker").map((p) => p.id)).size} · ИТР: ${new Set(people.filter((p) => p.group === "itr").map((p) => p.id)).size}`;
  } catch {
    element.hidden = true;
  } finally {
    pending = false;
  }
}
