import { copy, uid } from "./table-domain.mjs";
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
    this.uploadError = "";
    this.closed = false;
  }
  async open() {
    this.db = await new Promise((ok, no) => {
      const r = indexedDB.open("samosval_tabel_v2_v1_" + this.name, 1);
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
        ? navigator.locks.request("tabel-v2:" + this.name, task)
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
    if (new TextEncoder().encode(JSON.stringify(data)).length > 350000)
      throw Error(
        "Запись превышает 350 КБ. Уменьшите объём данных записи.",
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
  // Queue snapshots from the local-only releases before accepting server data.
  // An existing server revision becomes a visible conflict, never a silent overwrite.
  async prepareSync() {
    if (!this.remote) return;
    await this.serialize(async () => {
      let changed = false;
      for (const [key, row] of Object.entries(this.state.records)) {
        try { recordIdFor(key); } catch { continue; }
        if (!row.data || row.revision || this.state.jobs.some(j => j.key === key)) continue;
        const job = {id: uid(), key, data: copy(row.data),
          before: {revision: 0, data: null}, status: "queued",
          label: "Перенос локального табеля на сервер", author: this.actor(), time: Date.now()};
        this.state.jobs.push(job);
        row.localId = job.id;
        changed = true;
      }
      if (changed) await this.persist();
    });
  }
  async pullHistory(objectId) {
    if (!this.remote?.history) return;
    try {
      const rows = await this.remote.history(objectId);
      await this.serialize(async () => {
        const known = new Set(this.state.history.map(h => h.id));
        for (const h of rows) if (!known.has(h.id)) this.state.history.push(h);
        this.state.history.sort((a,b) => a.time - b.time);
        await this.persist();
      });
    } catch (e) { this.error = e.message; this.emit(); }
  }
  async pullObject(objectId) {
    if (!this.remote) return;
    try {
      await this.accept(await this.remote.list(objectId));
      this.error = "";
      this.emit();
    } catch (e) { this.error = e.message; this.emit(); }
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
        const blocked=new Set();
        let failure="";
        for (const job of [...this.state.jobs]) {
          if (
            blocked.has(job.key) || job.status !== "queued" ||
            this.state.jobs.some(
              (j) => j.key === job.key && j.status === "conflict",
            )
          )
            continue;
          try {
            this.uploading={key:job.key,started:Date.now()};this.emit();
            let timer;
            const result = await Promise.race([this.remote.commit(job),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Нет подтверждения Firebase за 25 секунд. Повтор будет с тем же ID операции.')),25000);})]).finally(()=>clearTimeout(timer));
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
            failure=job.key+': '+(e.code?e.code+' · ':'')+e.message;
            this.uploadError=failure;this.error=failure;
            blocked.add(job.key);
            console.error('[Табель Firebase]',failure);
            this.emit();
          }
        }
        this.uploadError=failure;
      });
    } finally {
      this.uploading=null;
      this.busy = false;this.emit();
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
// Firestore rejects undefined at any depth. Omit absent map fields; preserve array positions.
export function firestoreData(value) {
  if(Array.isArray(value))return value.map(item=>item===undefined?null:firestoreData(item));
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype)
    return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,firestoreData(v)]));
  return value;
}
export function firestoreRemote(host, guard) {
  const collection = host.workspace.collection("tabelNextRecords"),
    receipts = host.workspace.collection("tabelNextOperations");
  const ref = (key) => collection.doc(recordIdFor(key));
  return {
    async read(key) {
      const s = await ref(key).get({ source: "server" });
      return s.exists ? s.data() : { revision: 0, data: null };
    },
    async list(objectId) {
      const field = host.documentId?.() || globalThis.firebase.firestore.FieldPath.documentId();
      const prefix = objectId + "~";
      const base = collection.orderBy(field).startAt(prefix).endAt(prefix + "\uf8ff");
      const rows = [];
      let cursor = null;
      for (;;) {
        const query = (cursor ? base.startAfter(cursor) : base).limit(200);
        const snapshot = await query.get({source: "server"});
        rows.push(...snapshot.docs.map(d => [d.data().key, d.data()]));
        if (snapshot.docs.length < 200) return rows;
        cursor = snapshot.docs.at(-1);
      }
    },
    watch(objectId, from, to, onData, onError) {
      const field = host.documentId?.() || globalThis.firebase.firestore.FieldPath.documentId();
      // Include configuration, all past/future shifts, tombstones and independent sheets.
      const prefix = objectId + "~";
      const stop = collection.orderBy(field).startAt(prefix).endAt(prefix + "\uf8ff")
        .onSnapshot(snapshot => {
          if (!snapshot.metadata.fromCache)
            onData(snapshot.docs.map(d => [d.data().key, d.data()]));
        }, onError);
      const globals = ["_catalog/config", "_defaults/config"].map(key => ref(key).onSnapshot(snapshot => {
        if (!snapshot.metadata.fromCache && snapshot.exists) onData([[key, snapshot.data()]]);
      }, onError));
      return () => { stop(); globals.forEach(fn => fn()); };
    },
    async history(objectId) {
      const snapshot = await receipts.where("objectId", "==", objectId).get({source: "server"});
      return snapshot.docs.map(d => {
        const row = d.data();
        return {id:d.id, key:row.key, before:row.before, after:row.after, data:row.after.data,
          label:row.label || "Изменение табеля", time:row.time,
          author:{uid:row.author,name:row.after.authorName}, confirmed:row.time};
      });
    },
    async commit(job) {
      guard(job);
      if (new TextEncoder().encode(JSON.stringify(job.data)).length > 350000)
        throw Error("Запись превышает 350 КБ; локальная версия сохранена");
      return host
        .transaction(async (tx) => {
          guard(job);
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
            data: firestoreData(job.data),
            author: host.session().uid,
            authorName: host.session().name || host.session().uid,
            time: Date.now(),
            operationId: job.id,
          };
          tx.set(ref(job.key), after);
          tx.set(receipts.doc(job.id), {
            key: job.key,
            label: job.label || "Изменение табеля",
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
