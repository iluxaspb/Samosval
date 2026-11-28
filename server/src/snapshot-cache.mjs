import {createHash} from 'node:crypto';

// Тяжёлые снимки (книга игр, журнал) собираются один раз на версию данных,
// а не на каждый опрос каждого телефона.
//
// Версия — монотонный счётчик изменений БД `reserve_outbox_cursor.last_sequence`.
// Его поднимает триггер `reserve_outbox_capture_row` на каждой записи любой
// таблицы данных (игры, линия, архив, настройки, табель, пользователи, права),
// поэтому «версия не изменилась» означает «данные те же». Пока версия та же,
// повторный опрос получает 304 без сборки мегабайт JSON и без запросов в БД,
// кроме одного дешёвого чтения счётчика.
//
// Раньше каждый GET собирал снимок целиком даже при условном запросе: 2,8 МБ
// игр и 3,5 МБ журнала на каждый опрос каждого клиента. Однопоточный Node
// тратил на это почти всё время, пул из 5 соединений переполнялся, и остальные
// запросы (табель, линия, погрузка, автомат) ждали по несколько секунд.
const ETAG_LIMIT = 2048;
const shared = new Map();  // имя → {версия, значение, текущая сборка}
const wanted = new Map();  // имя → самая новая версия, которую уже кто-то ждёт
const etags = new Map();   // "область@версия" → ETag готового ответа
const builds = new Map();  // "ответ:область@версия" → Promise

export async function dataVersion(pool) {
  try {
    const row = (await pool.query('SELECT last_sequence FROM reserve_outbox_cursor WHERE singleton=true')).rows[0];
    const value = Number(row?.last_sequence);
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  } catch {
    // Нет счётчика — не кэшируем вовсе: лучше дороже, чем устаревшие данные.
    return null;
  }
}

// Разделяемая часть снимка: одинаковая для всех пользователей и ролей.
// Собирается один раз на версию; параллельные запросы ждут одну сборку.
//
// Если во время сборки появилась более новая версия (пользователи пишут), то
// следующая сборка идёт сразу для самой новой запрошенной версии, а не для
// каждой промежуточной. Данные при этом только свежее: сборка читает базу
// после того, как версия уже была замечена, а счётчик версии не убывает.
// Пять одновременных вращений автомата дают две сборки вместо пяти.
export async function sharedValue(name, version, build) {
  const ask = Number(version);
  if (!wanted.has(name) || wanted.get(name) < ask) wanted.set(name, ask);
  for (;;) {
    const slot = shared.get(name);
    if (slot && slot.version !== null && slot.version >= ask) return slot.value;
    if (slot && slot.promise) {
      await slot.promise.catch(() => {});
      continue;
    }
    const target = Math.max(ask, wanted.get(name) ?? ask);
    const promise = Promise.resolve().then(build);
    const next = {version: null, value: undefined, promise};
    shared.set(name, next);
    try {
      const value = await promise;
      next.value = value;
      next.version = target;
      next.promise = null;
      return value;
    } catch (error) {
      if (shared.get(name) === next) shared.delete(name);
      throw error;
    }
  }
}

function remember(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

const headers = (etag) => ({'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: etag});

// Ответ, зависящий от версии данных: пока версия та же, повторный запрос с
// совпавшим If-None-Match получает 304 сразу, без сборки тела.
// build() обязан вернуть готовый текст ответа.
export async function sendVersioned(req, res, {scope, version, build}) {
  const key = scope + '@' + version;
  const known = etags.get(key);
  if (known && req.headers['if-none-match'] === known) {
    res.writeHead(304, headers(known));
    res.end();
    return;
  }
  const pendingKey = 'ответ:' + key;
  let pending = builds.get(pendingKey);
  if (!pending) {
    pending = Promise.resolve().then(build).then((text) => ({
      text,
      etag: '"' + createHash('sha256').update(text).digest('hex') + '"',
    }));
    builds.set(pendingKey, pending);
    pending.then(
      (entry) => {
        if (builds.get(pendingKey) === pending) builds.delete(pendingKey);
        remember(etags, key, entry.etag, ETAG_LIMIT);
      },
      () => {
        if (builds.get(pendingKey) === pending) builds.delete(pendingKey);
      },
    );
  }
  const {text, etag} = await pending;
  res.writeHead(200, headers(etag));
  res.end(text);
}

// Диагностика для health/админки и тестов.
export function snapshotCacheState() {
  return {shared: shared.size, etags: etags.size, inflight: builds.size};
}
