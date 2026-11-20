// Регрессионный тест (1.7.12): живая синхронизация табеля между пользователями.
// Сценарий: два клиента (Store + createTabelRemote над моком fetch).
// 1) клиент A коммитит значение → клиент B получает его через watch-цикл
//    без перезагрузки; 2) активная правка B не затёрта чужой записью;
// 3) grid.refresh обязан перекрашивать ячейки даже когда записи
//    sheet:linked на сервере нет (первопричина бага 1.7.11).
// Запуск: node --test working-test/source/core/32-tabel-live-sync.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Store } from "../../tabel-v2/store.mjs";
import { createTabelRemote } from "../../synology/tabel-remote.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Мок сервера табеля: in-memory записи с revision, пагинация не нужна.
function tabelServer() {
  const records = new Map();
  let revision = 0;
  const validRecord = (row) =>
    row && Number.isSafeInteger(row.revision) && row.revision >= 0 &&
    (row.data === null || (row.data && typeof row.data === "object"));
  const commit = (job) => {
    const current = records.get(job.key) || { revision: 0, data: null };
    if (job.before.revision !== current.revision)
      return { conflict: true, current };
    revision += 1;
    const next = {
      revision,
      data: job.data,
      authorName: "author",
    };
    records.set(job.key, next);
    return { operationId: job.id, key: job.key, ...next };
  };
  return {
    commit,
    list: (objectId) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(objectId + "/"))
        .map(([key, row]) => [key, row]),
    dump: () => records,
  };
}

// fetch-мок поверх tabelServer для createTabelRemote.
function serverFetch(server) {
  return async (url, options) => {
    const target = new URL(url);
    if (options?.method === "POST") {
      const job = JSON.parse(options.body);
      return ok(commitShape(server.commit(job)));
    }
    const params = target.searchParams;
    if (params.get("key")) {
      const row = server.dump().get(params.get("key"));
      if (!row) return ok({ record: { revision: 0, data: null } });
      return ok({ record: row });
    }
    return ok({ rows: server.list(params.get("objectId")), cursor: null });
  };
}
function commitShape(result) {
  return result.conflict
    ? { conflict: true, current: result.current }
    : result;
}
const ok = (value) => ({
  ok: true,
  status: 200,
  json: async () => value,
  headers: { get: () => null },
});

const OBJECT = "site-a";
const DAY_KEY = OBJECT + "/day:2026-11-14:day";
const CONFIG_KEY = OBJECT + "/config";

function client(server, uid) {
  const remote = createTabelRemote({
    baseUrl: "https://api.test",
    getIdToken: async () => "token-" + uid,
    fetchImpl: serverFetch(server),
    pollMs: 1000,
  });
  const store = new Store("live-sync-" + uid, remote, () => ({ uid, name: uid }));
  // Индексы браузера заменены памятью: тестируется логика, не I/O.
  store.reloadQuiet = async () => {};
  store.persist = async () => {};
  return { remote, store, uid };
}

const dayData = (quantity) => ({
  date: "2026-11-14",
  shift: "day",
  values: { hours: { quantity } },
  equipment: [],
  people: [],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("живой watch-цикл: значение пользователя A доезжает до Store пользователя B без перезагрузки", async () => {
  const server = tabelServer();
  server.commit({
    id: "seed",
    key: CONFIG_KEY,
    data: { name: "Адрес А", start: "2026-11-01" },
    before: { revision: 0, data: null },
  });
  const a = client(server, "user-a");
  const b = client(server, "user-b");

  // B открыл таблицу: первая вычитка + подписка watch.
  await b.store.accept(await b.remote.list(OBJECT));
  const received = [];
  const stop = b.remote.watch(OBJECT, "2026-11-01", "2026-11-21", async (records) => {
    received.push(records.map(([key]) => key));
    await b.store.accept(records);
  });

  // A вводит число в ячейку и уходит из неё: save → flush → commit.
  const base = a.store.get(DAY_KEY);
  assert.equal(
    await a.store.save(DAY_KEY, dayData(8), base, "Таблица: часы"),
    true,
  );
  await a.store.flush();

  // Ждём следующий poll-цикл watch (pollMs=1000).
  for (let i = 0; i < 30 && !received.flat().includes(DAY_KEY); i++)
    await sleep(200);
  stop();

  assert.ok(
    received.flat().includes(DAY_KEY),
    "watch должен был доставить запись дня пользователю B",
  );
  assert.equal(
    b.store.get(DAY_KEY).data?.values?.hours?.quantity,
    8,
    "значение A видно у B без перезагрузки",
  );
  assert.ok(b.store.get(DAY_KEY).revision >= 1, "запись у B имеет серверную ревизию");
});

test("активная правка B не затирается входящей записью A по тому же ключу", async () => {
  const server = tabelServer();
  const a = client(server, "user-a");
  const b = client(server, "user-b");

  // Оба стартуют с ревизии 0. A успел закоммитить первым.
  const baseA = a.store.get(DAY_KEY);
  assert.equal(await a.store.save(DAY_KEY, dayData(5), baseA, "A: часы"), true);
  await a.store.flush();

  // B ввёл своё значение (задание в очереди, ещё не отправлено).
  const baseB = b.store.get(DAY_KEY);
  assert.equal(await b.store.save(DAY_KEY, dayData(3), baseB, "B: часы"), true);
  assert.equal(b.store.get(DAY_KEY).data.values.hours.quantity, 3);

  // Watch-цикл приносит подтверждённую запись A в Store B.
  await b.store.accept(await b.remote.list(OBJECT));

  assert.equal(
    b.store.get(DAY_KEY).data.values.hours.quantity,
    3,
    "локальный ввод B сохранён: accept не затирает ключ с очередным заданием",
  );
  assert.ok(
    b.store.state.jobs.some((j) => j.key === DAY_KEY && j.status === "queued"),
    "очередь B не тронута",
  );
  // Отправка B на сервер вызывает конфликт ревизий — последний сохранённый
  // выигрывает через механизм conflict, а не молчаливое затирание.
  await b.store.flush();
  assert.ok(
    b.store.state.jobs.some((j) => j.key === DAY_KEY && j.status === "conflict"),
    "расхождение ревизий видно как конфликт",
  );
});

test("grid.refresh перекрашивает ячейки даже без записи sheet:linked (первопричина бага)", () => {
  const source = readFileSync(
    path.join(here, "../../tabel-v2/grid.mjs"),
    "utf8",
  );
  const start = source.indexOf("    async refresh() {");
  const end = source.indexOf("    finish: () =>");
  assert.ok(start > 0 && end > start, "метод refresh найден в grid.mjs");
  const body = source.slice(start, end);
  // До 1.7.12 пересчёт allDays и refreshVisibleCells были заперты внутри
  // if (current?.data) — при отсутствии sheet:linked обновление терялось.
  const ifBlock = body.match(/if \(current\?\.data\) \{([\s\S]*?)\n      \}/);
  assert.ok(ifBlock, "блок if (current?.data) найден");
  assert.ok(
    !ifBlock[1].includes("refreshVisibleCells"),
    "точечная перекраска не должна зависеть от наличия записи sheet:linked",
  );
  assert.ok(
    /allDays = s\.days\(\);/.test(body),
    "refresh обязан пересчитывать дни из store",
  );
  assert.ok(
    body.includes("refreshVisibleCells();"),
    "refresh обязан точечно обновлять ячейки",
  );
});

test("интервал опроса табеля снижен с 10 до 5 секунд", () => {
  const source = readFileSync(
    path.join(here, "../../synology/tabel-remote.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /pollMs=5000/,
    "клиент табеля по умолчанию опрашивает сервер каждые 5 секунд",
  );
});
