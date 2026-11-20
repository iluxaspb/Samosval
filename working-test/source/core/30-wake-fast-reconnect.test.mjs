import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createNasClient, NasClientError } from '../../synology/session-client.mjs';

// Проверяем тот самый файл, который уходит в сборку, а не его копию.
const runtimeFile = fileURLToPath(new URL('./21-nas-runtime.js', import.meta.url));
const runtime = readFileSync(runtimeFile, 'utf8');

// createNasClient фиксирует владельца при создании (guard: getUser()!==owner
// → session-changed), поэтому getUser обязан возвращать один и тот же объект.
const stableUser = { uid: 'uid-wake-test', getIdToken: async () => 'token' };
function user() {
  return stableUser;
}

// Симуляция «мёртвого сокета» после возврата из фона: fetch висит вечно
// и игнорирует сигнал прерывания, как это делает убитый системой сокет.
function hungFetch() {
  return () => new Promise(() => {});
}

test('probe прерывает зависший fetch собственным таймаутом, а не ждёт браузер', async () => {
  const client = createNasClient({ baseUrl: 'https://wake-test.invalid', getUser: user, fetchImpl: hungFetch(), timeoutMs: 20000 });
  const startedAt = Date.now();
  await assert.rejects(
    client.probe(1000),
    error => error instanceof NasClientError && error.code === 'api-timeout'
  );
  // Зависший запрос оборвался за секунды, а не за таймаут браузера (минуты).
  assert.ok(Date.now() - startedAt < 8000, 'probe не уложился в короткий дедлайн');
  client.stop();
});

test('после прерывания зависшего запроса следующий wake-запрос проходит', async () => {
  let hung = true;
  const client = createNasClient({
    baseUrl: 'https://wake-test.invalid',
    getUser: user,
    timeoutMs: 20000,
    fetchImpl: () => hung
      ? new Promise(() => {}) // мёртвый сокет из фона: никогда не отвечает
      : Promise.resolve(new Response(JSON.stringify({
          format: 'samosval-session', version: 1, source: 'ubuntu', workspaceId: 'main_workspace',
          identityReady: true, profile: null, permissions: { tabs: [], actions: [] }
        }), { headers: { 'Content-Type': 'application/json' } }))
  });
  await assert.rejects(client.probe(1000), error => error.code === 'api-timeout');
  // Новый wake: сеть починилась, свежий запрос обязан пройти.
  hung = false;
  const session = await client.probe(5000);
  assert.equal(session.identityReady, true);
  client.stop();
});

test('сброс зависших чтений освобождает и флаги серии обновления', () => {
  // Раньше nasDropHungReads не трогал nasActivityInFlight/nasActivityPending:
  // замороженная вкладка не выполняла finally, и каждый новый возврат из
  // фона уходил в «pending» — реальный запрос с abortInflight не запускался.
  const match = runtime.match(/function nasDropHungReads\(\)\{([^}]*)\}/);
  assert.ok(match, 'нет функции nasDropHungReads');
  assert.match(match[1], /nasActivityInFlight\s*=\s*false/, 'не сбрасывается nasActivityInFlight');
  assert.match(match[1], /nasActivityPending\s*=\s*false/, 'не сбрасывается nasActivityPending');
  assert.match(match[1], /nasActivityGate\s*=\s*null/, 'не сбрасывается nasActivityGate');
});

test('возврат из фона делает быструю проверку связи до полной серии', () => {
  assert.match(runtime, /function nasFastLinkCheck\(/, 'нет быстрой проверки связи');
  assert.match(runtime, /abortInflight/, 'быстрая проверка не прерывает мёртвые сокеты');
  assert.match(runtime, /nasFastLinkCheck\(epoch,client\);\s*void nasActiveRefresh\('visibilitychange'/, 'visibilitychange без быстрой проверки');
  assert.match(runtime, /nasFastLinkCheck\(epoch,client\);\s*void nasActiveRefresh\('resume'/, 'resume без быстрой проверки');
  assert.match(runtime, /nasFastLinkCheck\(epoch,client\);\s*void nasActiveRefresh\('pageshow'/, 'pageshow без быстрой проверки');
  assert.match(runtime, /offlineTransportRecovered\(\)/, 'успешная проверка не снимает «Работа локально»');
});

test('periodic poll по-прежнему не рвёт текущие запросы (правило 1.6.0)', () => {
  const pollBranch = runtime.match(/if\(reason==='poll'\)\{[\s\S]*?\}else\{/);
  assert.ok(pollBranch, 'нет отдельной ветки poll');
  assert.doesNotMatch(pollBranch[0], /abortInflight/, 'poll не должен вызывать abortInflight');
  // abortInflight остаётся только в пробуждении и быстрой проверке связи.
  for (const anchor of [/nasNetworkWake[\s\S]{0,600}abortInflight/, /nasFastLinkCheck[\s\S]{0,400}abortInflight/]) {
    assert.match(runtime, anchor);
  }
});

// Текстовые якоря держат всю цепочку быстрого восстановления на месте.
const pwaText = readFileSync(fileURLToPath(new URL('../src/pwa.js', import.meta.url)), 'utf8');

test('проверка новой версии запускается и по focus/pageshow (страховка iOS)', () => {
  assert.match(pwaText, /addEventListener\('visibilitychange'[\s\S]*?resume\(\)/);
  assert.match(pwaText, /window\.addEventListener\('focus',resume\)/, 'нет страховки по focus');
  assert.match(pwaText, /window\.addEventListener\('pageshow',resume\)/, 'нет страховки по pageshow');
  assert.match(pwaText, /checkForUpdates\(\);discoverPublishedUpdate\(\)/, 'resume не проверяет новую версию');
});
