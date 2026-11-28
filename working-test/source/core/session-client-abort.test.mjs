// Возврат на экран обрывает текущие чтения (abortInflight) — это наша команда,
// а не сбой связи. Клиент обязан отличать её от настоящего таймаута: иначе
// после каждого пробуждения телефона в индикатор синхронизации попадает
// «api-timeout: response-headers», и экран показывает «Ошибка загрузки: nas»
// без реальной причины (жалоба владельца 28.11.2026).
//
// Запуск: node --test working-test/source/core/session-client-abort.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNasClient } from '../../synology/session-client.mjs';

const never = () => new Promise(() => {});

function client(options = {}) {
  return createNasClient({
    baseUrl: 'https://samosval-test.iluxa.pro',
    workspaceId: 'main_workspace',
    getUser: () => ({ uid: 'one', getIdToken: async () => 'token' }),
    fetchImpl: never,
    ...options
  });
}

test('abortInflight: собственный обрыв — api-aborted, а не api-timeout', async () => {
  const nas = client();
  const pending = nas.readSession().then(() => 'resolved', error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  nas.abortInflight();
  const error = await pending;
  assert.equal(error.code, 'api-aborted', 'обрыв по команде клиента не выдаётся за таймаут');
  assert.equal(error.retryable, true, 'чтение можно повторить сразу');
  assert.equal(error.uncertain, false, 'чтение не пишет данные — неопределённости нет');
  assert.equal(error.phase, 'response-headers', 'фаза сохраняется для диагностики');
});

test('настоящий таймаут остаётся api-timeout', async () => {
  const nas = client({ timeoutMs: 30 });
  await assert.rejects(nas.readSession(), { code: 'api-timeout' });
});

test('stop() по-прежнему закрывает сеанс кодом session-changed', async () => {
  const nas = client();
  const pending = nas.readSession().then(() => 'resolved', error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  nas.stop();
  const error = await pending;
  assert.equal(error.code, 'session-changed', 'остановка клиента не маскируется под таймаут');
});
