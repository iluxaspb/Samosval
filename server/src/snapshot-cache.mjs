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
const SHARED_LIMIT = 6;
const ETAG_LIMIT = 2048;
const shared = new Map();  // "имя@версия" → разделяемая часть снимка
const etags = new Map();   // "область@версия" → ETag готового ответа
const builds = new Map();  // "имя@версия" / "ответ:область@версия" → Promise

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
export async function sharedValue(name, version, build) {
  const key = name + '@' + version;
  if (shared.has(key)) {
    const value = shared.get(key);
    shared.delete(key);
    shared.set(key, value); // обновляем порядок вытеснения
    return value;
  }
  let pending = builds.get(key);
  if (!pending) {
    pending = Promise.resolve().then(build);
    builds.set(key, pending);
    pending.then(
      (value) => {
        if (builds.get(key) === pending) builds.delete(key);
        remember(shared, key, value, SHARED_LIMIT);
      },
      () => {
        if (builds.get(key) === pending) builds.delete(key);
      },
    );
  }
  return pending;
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
