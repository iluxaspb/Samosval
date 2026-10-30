import { sheetVisible } from "./sheet-access.mjs";
import { lineCalendarDate } from "./domain.mjs";
import { arrivals } from "./line.mjs";
import { equipmentCount, linkedFormulaDays } from "./table-domain.mjs";
import {storageScope,sameTableSession} from './backend.mjs';
let generation = 0;
async function readRecords(session) {
  const name = "samosval_tabel_v2_v1_" + storageScope(session);
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
  const token = ++generation;
  const session = host.session(),
    snapshot = host.snapshot(),
    objectId = snapshot.shift?.objectId;
  if (!session.view || !session.active || !objectId) {
    element.hidden = true;
    return;
  }
  try {
    const date = lineCalendarDate(snapshot.shift.startDate),
      records = await readRecords(session);
    if (
      token !== generation || !host.session().view || !host.session().active ||
      !sameTableSession(host.session(),session) ||
      host.snapshot().shift?.objectId !== objectId
    )
      return;
    const config = {equipment: [], ...records[objectId + "/config"]?.data};
    const dayRecords = Object.entries(records).filter(([key]) => key.startsWith(objectId + "/day:"));
    const rawDays = dayRecords.filter(([,r]) => r.data && !r.data.deleted).map(([,r]) => r.data)
      .sort((a,b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
    const days = linkedFormulaDays(config, rawDays, records[objectId + "/sheet:linked"]?.data,
      new Set(dayRecords.filter(([,r]) => r.data?.deleted).map(([,r]) => r.data.date)))
      .filter(d => d.date === date);
    if (
      !sheetVisible(
        {
          ...session,
          status: session.active ? "active" : "disabled",
          tabAccess: session.view,
        },
        records[objectId + "/config"]?.data,
        "linked",
      )
    ) {
      element.hidden = true;
      return;
    }
    let equipment = days.flatMap((d) => d.equipment),
      people = days.flatMap((d) => d.people);
    if (!days.length && session.provider!=='synology') {
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
    const total = equipmentCount(
      [{equipment}], line,
      config,
      snapshot.trucks || [],
    );
    element.hidden = false;
    element.textContent = `Техника: ${total} · Рабочие: ${new Set(people.filter((p) => p.group === "worker").map((p) => p.id)).size} · ИТР: ${new Set(people.filter((p) => p.group === "itr").map((p) => p.id)).size}`;
  } catch {
    if (token === generation) element.hidden = true;
  }
}
