import * as D from "./table-domain.mjs";
import { lineCalendarDate } from "./domain.mjs";
export function normalizedObject(object, fallback = D.today()) {
  let start = fallback;
  try {
    if (object.startDate) start = lineCalendarDate(object.startDate);
  } catch {}
  return { ...object, startDate: start };
}
export function convertLegacy(saved, object, catalog) {
  const shifts = (saved?.shifts || []).map(([, d]) => d),
    dates = shifts.map((d) => d.date).sort();
  const c = D.config(normalizedObject(object, dates[0] || D.today()));
  const st = saved?.settings || {};
  c.equipment = (st.equipment || []).map((e) => ({
    ...e,
    ownership: e.ownership === "hired" ? "hired" : "own",
    pump: !!e.pumpEnabled,
    plate: e.number || e.plate || "",
  }));
  c.people = catalog.people.filter((p) =>
    [...(st.workers || []), ...(st.itr || [])].includes(p.id),
  );
  c.request.equipment = c.equipment.map((e) => e.id);
  c.request.people = c.people.map((p) => p.id);
  c.works = st.works || [];
  c.materials = (st.destinations || []).map((direction, i) => ({
    id: "legacy-material-" + i,
    name: st.material || "Материал",
    unit: "м³",
    direction,
    section: "granulate",
  }));
  c.currentMaterial = st.material || "";
  c.destinations = st.destinations || [];
  const records = shifts.map((d) => ({
    key: object.id + "/" + D.dayKey(d.date, d.kind),
    data: {
      date: d.date,
      shift: d.kind,
      closed: !!d.closed,
      planned: d.date > D.today(),
      equipment: (d.settings.equipment || []).map((e) => ({
        ...e,
        ownership: e.ownership === "hired" ? "hired" : "own",
        pump: !!e.pumpEnabled,
        plate: e.number || e.plate || "",
        hours: d.hours[e.id]?.machineHours ?? null,
        crewHours: d.hours[e.id]?.crewHours ?? null,
        pumpHours: d.hours[e.id]?.pumpHours ?? null,
      })),
      people: catalog.people
        .filter((p) =>
          [...(d.settings.workers || []), ...(d.settings.itr || [])].includes(
            p.id,
          ),
        )
        .map((p) => ({ ...p, hours: null })),
      values: Object.fromEntries(
        Object.entries(d.workActual || {}).map(([id, quantity]) => [
          id,
          { quantity },
        ]),
      ),
    },
  }));
  return { config: c, records, usage: saved?.usage || {} };
}
export async function migrate(host, store, object, catalog) {
  if (!object || store.get(object.id + "/config").data) return;
  const a = host.session(),
    key = JSON.stringify([
      "tabel-v2-draft",
      1,
      a.projectId,
      a.workspaceId,
      a.uid,
      object.id,
    ]);
  const raw = localStorage.getItem(key);
  if (!raw) return;
  let saved;
  try {
    saved = JSON.parse(raw);
    if (!saved.settings || !Array.isArray(saved.shifts)) throw Error();
  } catch {
    throw Error(
      "Старый черновик повреждён. Исходная запись сохранена; автоматический перенос остановлен.",
    );
  }
  const converted = convertLegacy(saved, object, catalog);
  await store.serialize(async () => {
    if (store.state.records[object.id + "/config"]?.data) return;
    store.state.records[object.id + "/config"] = {
      revision: 0,
      data: converted.config,
    };
    for (const r of converted.records)
      store.state.records[r.key] = { revision: 0, data: r.data };
    store.state.records[object.id + "/migration"] = {
      revision: 0,
      data: { source: key, time: Date.now() },
    };
    await store.persist();
  });
}
