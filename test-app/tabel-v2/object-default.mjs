// Choosing an address never mutates a shift. An explicit request overrides
// defaults; otherwise the current Line or the latest closed shift wins.
export const lastClosedKey = (projectId, workspaceId) =>
  "tabel-v2-last-closed:" + projectId + ":" + workspaceId;

function closedTime(row) {
  const n = Number(row?.closedAt);
  if (Number.isFinite(n) && n > 0) return n;
  const str = String(row?.date || row?.startDate || "");
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(str);
  const iso = ru ? ru[3] + "-" + ru[2].padStart(2, "0") + "-" + ru[1].padStart(2, "0") : str;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function preferredObjectId({
  objects = [], requestObjectId = null, shift = null, archive = [],
  recentlyClosed = null, lastObject = null,
} = {}) {
  const known = new Set(objects.map((o) => o.id));
  if (known.has(requestObjectId)) return requestObjectId;
  if (shift?.isActive && known.has(shift.objectId)) return shift.objectId;
  const closed = (archive || [])
    .filter((row) => row && known.has(row.objectId))
    .map((row) => ({ id: row.objectId, timestamp: closedTime(row) }));
  if (recentlyClosed && known.has(recentlyClosed.objectId))
    closed.push({ id: recentlyClosed.objectId, timestamp: closedTime(recentlyClosed) });
  closed.sort((a, b) => b.timestamp - a.timestamp);
  if (closed.length) return closed[0].id;
  if (known.has(lastObject)) return lastObject;
  return objects[0]?.id || null;
}
