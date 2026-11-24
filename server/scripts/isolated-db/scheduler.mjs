// Deterministic bounded scheduler for manifest entries. Serial and exclusive
// entries form barriers in manifest order; ordinary failures are recorded and
// do not prevent later entries from running.

function refuse(message) { throw new Error(`scheduler request is not approved: ${message}`); }

export async function scheduleManifestJobs({ entries, jobs = 1, runJob }) {
  if (!Array.isArray(entries) || typeof runJob !== 'function') refuse('entries and runJob are required');
  if (!Number.isInteger(jobs) || jobs < 1) refuse('jobs must be a positive integer');
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || seen.has(entry.file)) refuse('unique manifest file order is required');
    if (entry.serial === true && entry.exclusive === true) refuse('serial and exclusive cannot both be set');
    seen.add(entry.file);
  }

  const results = new Array(entries.length);
  let cursor = 0;
  while (cursor < entries.length) {
    const entry = entries[cursor];
    if (entry.serial === true || entry.exclusive === true) {
      const result = await execute(entry, cursor, runJob);
      results[cursor] = result;
      cursor += 1;
      continue;
    }

    const batch = [];
    while (cursor < entries.length && entries[cursor].serial !== true && entries[cursor].exclusive !== true && batch.length < jobs) {
      const index = cursor++;
      batch.push(execute(entries[index], index, runJob).then(result => { results[index] = result; }));
    }
    await Promise.all(batch);
  }
  return results;
}

async function execute(entry, index, runJob) {
  const startedAt = Date.now();
  try {
    const result = await runJob(entry);
    return { file: entry.file, status: result?.status ?? 'passed', result, startedAt, endedAt: Date.now() };
  } catch (error) {
    return {
      file: entry.file,
      status: 'failed',
      error: String(error?.message ?? error),
      code: typeof error?.code === 'string' ? error.code : undefined,
      startedAt,
      endedAt: Date.now(),
    };
  }
}
