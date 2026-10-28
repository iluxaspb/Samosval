import { copy, uid } from "./domain.mjs";
// All local snapshots and pending operations are committed in one IndexedDB transaction.
export class Store {
  constructor(name, remote, actor) {
    this.name = name;
    this.remote = remote;
    this.actor = actor;
    this.listeners = new Set();
    this.state = { records: {}, jobs: [], history: [] };
    this.chain = Promise.resolve();
    this.error = "";
    this.closed = false;
  }
  async open() {
    this.db = await new Promise((ok, no) => {
      const r = indexedDB.open("samosval_tabel_next_v1_" + this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("state");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    this.state = await new Promise((ok, no) => {
      const r = this.db.transaction("state").objectStore("state").get("main");
      r.onsuccess = () => ok(r.result || this.state);
      r.onerror = () => no(r.error);
    });
    this.channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(this.name)
        : null;
    if (this.channel) this.channel.onmessage = () => this.reload();
    this.online = () => this.flush();
    globalThis.addEventListener?.("online", this.online);
    this.timer = setInterval(() => this.flush(), 15000);
    return this;
  }
  async reload() {
    await this.chain;
    this.state = await new Promise((ok, no) => {
      const r = this.db.transaction("state").objectStore("state").get("main");
      r.onsuccess = () => ok(r.result || this.state);
      r.onerror = () => no(r.error);
    });
    this.emit();
  }
  async persist() {
    await new Promise((ok, no) => {
      const t = this.db.transaction("state", "readwrite");
      t.objectStore("state").put(this.state, "main");
      t.oncomplete = ok;
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error || Error("Не удалось сохранить"));
    });
    this.channel?.postMessage("change");
    this.emit();
  }
  serialize(fn) {
    const task = async () => {
      await this.reloadQuiet();
      const before = copy(this.state);
      try {
        return await fn();
      } catch (e) {
        this.state = before;
        throw e;
      }
    };
    const run = () =>
      globalThis.navigator?.locks
        ? navigator.locks.request("tabel-next:" + this.name, task)
        : task();
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
  async reloadQuiet() {
    this.state = await new Promise((ok, no) => {
      const r = this.db.transaction("state").objectStore("state").get("main");
      r.onsuccess = () => ok(r.result || this.state);
      r.onerror = () => no(r.error);
    });
  }
  emit() {
    this.listeners.forEach((fn) => fn());
  }
  get(key) {
    return copy(this.state.records[key] || { revision: 0, data: null });
  }
  list(prefix) {
    return Object.entries(this.state.records)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, ...copy(v) }));
  }
  async save(key, data, base, label) {
    if (new TextEncoder().encode(JSON.stringify(data)).length > 700000)
      throw Error(
        "Запись превышает 700 КБ. Разделите свободную таблицу на несколько листов.",
      );
    return this.serialize(async () => {
      const current = this.get(key);
      if (
        (current.localId !== base.localId ||
          current.revision !== base.revision) &&
        JSON.stringify(current.data) !== JSON.stringify(base.data)
      ) {
        const conflict = {
          id: uid(),
          key,
          data: copy(data),
          before: base,
          remote: current,
          status: "conflict",
          label,
          author: this.actor(),
          time: Date.now(),
        };
        this.state.jobs.push(conflict);
        await this.persist();
        return false;
      }
      const job = {
        id: uid(),
        key,
        data: copy(data),
        before: current,
        status: "queued",
        label,
        author: this.actor(),
        time: Date.now(),
      };
      this.state.jobs.push(job);
      this.state.records[key] = {
        ...current,
        data: copy(data),
        localId: job.id,
      };
      await this.persist();
      return true;
    });
  }
  async accept(records) {
    await this.serialize(async () => {
      for (const [key, row] of records)
        if (
          !this.state.jobs.some((j) => j.key === key) &&
          (row.revision || 0) >= (this.state.records[key]?.revision || 0)
        )
          this.state.records[key] = row;
      await this.persist();
    });
  }
  async pull(key) {
    if (!this.remote) return;
    try {
      const row = await this.remote.read(key);
      await this.serialize(async () => {
        if (
          !this.state.jobs.some((j) => j.key === key) &&
          (row.revision || 0) >= (this.state.records[key]?.revision || 0)
        ) {
          this.state.records[key] = row;
          await this.persist();
        }
      });
      this.error = "";
    } catch (e) {
      this.error = e.message;
      this.emit();
    }
  }
  async flush() {
    if (
      this.busy ||
      this.closed ||
      !this.remote ||
      globalThis.navigator?.onLine === false
    )
      return;
    this.busy = true;
    try {
      await this.serialize(async () => {
        for (const job of [...this.state.jobs]) {
          if (
            job.status !== "queued" ||
            this.state.jobs.some(
              (j) => j.key === job.key && j.status === "conflict",
            )
          )
            continue;
          try {
            const result = await this.remote.commit(job);
            if (result.conflict) {
              job.status = "conflict";
              job.remote = result.current;
              await this.persist();
              continue;
            }
            this.state.jobs = this.state.jobs.filter((j) => j.id !== job.id);
            this.state.history.push({
              ...job,
              confirmed: Date.now(),
              after: result,
            });
            const next = this.state.jobs.find(
              (j) => j.key === job.key && j.before.localId === job.id,
            );
            if (next) next.before = { ...result, localId: job.id };
            if (this.state.records[job.key].localId === job.id)
              this.state.records[job.key] = result;
            await this.persist();
            this.error = "";
          } catch (e) {
            this.error = e.message;
            this.emit();
            break;
          }
        }
      });
    } finally {
      this.busy = false;
    }
  }
  async resolve(id, choice) {
    await this.serialize(async () => {
      const job = this.state.jobs.find((j) => j.id === id);
      if (!job) return;
      const related = this.state.jobs.filter((j) => j.key === job.key),
        latest = related.at(-1);
      for (const version of related)
        this.state.history.push({
          ...version,
          resolution: choice,
          resolvedAt: Date.now(),
        });
      this.state.jobs = this.state.jobs.filter((j) => j.key !== job.key);
      if (choice === "mine") {
        const replacement = {
          ...latest,
          before: copy(job.remote),
          status: "queued",
          id: uid(),
        };
        delete replacement.remote;
        this.state.jobs.push(replacement);
        this.state.records[job.key] = {
          ...job.remote,
          data: copy(replacement.data),
          localId: replacement.id,
        };
      } else this.state.records[job.key] = copy(job.remote);
      await this.persist();
    });
    await this.flush();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    globalThis.removeEventListener?.("online", this.online);
    await this.chain;
    this.channel?.close();
    this.db?.close();
  }
}
export const recordIdFor = (key) => {
  if (
    !/^[A-Za-z0-9_-]+\/(?:config|day:\d{4}-\d{2}-\d{2}:(?:day|night)|sheet:[A-Za-z0-9_-]+)$/.test(
      key,
    )
  )
    throw Error("Некорректный ключ нового табеля");
  return key.replace(/[/:]/g, "~");
};
export function firestoreRemote(host, guard) {
  const collection = host.workspace.collection("tabelNextRecords"),
    receipts = host.workspace.collection("tabelNextOperations");
  const ref = (key) => collection.doc(recordIdFor(key));
  return {
    async read(key) {
      const s = await ref(key).get({ source: "server" });
      return s.exists ? s.data() : { revision: 0, data: null };
    },
    watch(objectId, from, to, onData, onError) {
      const field = globalThis.firebase?.firestore?.FieldPath.documentId();
      if (!field || !collection.orderBy) return () => {};
      const prefix = objectId + "~day~";
      const query = collection
        .orderBy(field)
        .startAt(prefix + from)
        .endAt(prefix + to + "\uf8ff")
        .limit(750);
      return query.onSnapshot((snapshot) => {
        if (!snapshot.metadata.fromCache)
          onData(snapshot.docs.map((d) => [d.data().key, d.data()]));
      }, onError);
    },
    async commit(job) {
      guard(job);
      return host
        .transaction(async (tx) => {
          const receipt = await tx.get(receipts.doc(job.id));
          if (receipt.exists) return receipt.data().after;
          const s = await tx.get(ref(job.key)),
            current = s.exists ? s.data() : { revision: 0, data: null };
          if (current.revision !== job.before.revision)
            return { conflict: true, current };
          const after = {
            recordId: recordIdFor(job.key),
            key: job.key,
            objectId: job.key.split("/")[0],
            revision: current.revision + 1,
            data: job.data,
            author: host.session().uid,
            authorName: host.session().name,
            time: Date.now(),
            operationId: job.id,
          };
          tx.set(ref(job.key), after);
          tx.set(receipts.doc(job.id), {
            key: job.key,
            objectId: after.objectId,
            before: current,
            after,
            author: after.author,
            time: after.time,
          });
          return after;
        })
        .catch(async (error) => {
          if (["permission-denied", "aborted"].includes(error.code)) {
            try {
              const latest = await ref(job.key).get({ source: "server" }),
                current = latest.exists
                  ? latest.data()
                  : { revision: 0, data: null };
              if (current.revision !== job.before.revision)
                return { conflict: true, current };
            } catch {
              /* A revoked read permission must not be bypassed. */
            }
          }
          throw error;
        });
    },
  };
}
