import test from 'node:test';
import assert from 'node:assert/strict';
import {moscowTime} from '../src/moscow-time.mjs';

// timeStr уходит в приложение строкой и должен совпадать байт-в-байт с прежним
// `new Date(x).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'})`: иначе в
// журнале и карточках поедет формат даты. Замена нужна только ради скорости
// (готовый Intl.DateTimeFormat вместо нового на каждый вызов).
test('moscowTime совпадает с прежним toLocaleString байт-в-байт', () => {
  const stamps = [0, 1795819096778, 1764000000000, 1795999999999, 1730412000000,
    1000000000000, 1, 253402300799000, 946684800000];
  for (const stamp of stamps) {
    const old = new Date(stamp).toLocaleString('ru-RU', {timeZone: 'Europe/Moscow'});
    assert.equal(moscowTime(stamp), old, 'момент ' + stamp);
  }
});

test('moscowTime принимает Date и число одинаково', () => {
  const stamp = 1795819096778;
  assert.equal(moscowTime(new Date(stamp)), moscowTime(stamp));
  assert.match(moscowTime(stamp), /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
});
