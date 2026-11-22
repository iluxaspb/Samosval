// Регрессионный тест панели длинных ошибок (18-line-ui.js).
// Короткие ошибки остаются toast (2,5 с); длинные (более ~60 символов)
// и ошибки транзакций (отказ погрузки из-за защитного интервала, конфликты
// отмены undoLastAction, ошибки синхронизации) показываются в панели снизу,
// которая закрывается ТОЛЬКО кнопкой «Понятно» — не по таймеру и не по клику
// мимо панели. Панель одна на приложение; повторная ошибка заменяет текст.
// Запуск: node --test working-test/source/core/error-panel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const lineUi = readFileSync(join(here, '18-line-ui.js'), 'utf8');
const replay = readFileSync(join(here, '16-offline-replay.js'), 'utf8');
const nas = readFileSync(join(here, '21-nas-runtime.js'), 'utf8');
const css = readFileSync(join(here, '..', 'styles', 'style-04.css'), 'utf8');

test('showError маршрутизирует: длинные сообщения идут в панель, короткие — в toast', () => {
  const idx = lineUi.indexOf('function showError(msg)');
  const body = lineUi.slice(idx, lineUi.indexOf('function resetToast', idx));
  assert.match(body, /String\(msg\)\.length > 60/, 'длинные сообщения (более 60 символов) направляются в панель');
  assert.match(body, /showErrorPanel\(`⚠️ \$\{escapeHtml\(msg\)\}`\)/, 'текст панели экранируется');
  assert.match(body, /showToastEl\(`⚠️ \$\{escapeHtml\(msg\)\}`\s*,\s*true\)/, 'короткие сообщения остаются toast-ошибкой');
});

test('панель закрывается только кнопкой «Понятно»: без таймеров и клика мимо', () => {
  const idx = lineUi.indexOf('function showErrorPanel(html)');
  const body = lineUi.slice(idx, lineUi.indexOf('function showError(msg)', idx));
  assert.ok(idx >= 0, 'есть функция showErrorPanel');
  assert.ok(body.includes('Понятно'), 'закрытие только по кнопке «Понятно»');
  assert.match(body, /classList\.remove\('open'\)/, 'закрытие снимает класс open');
  assert.doesNotMatch(body, /setTimeout|setInterval/, 'панель не закрывается по таймеру');
  assert.equal((body.match(/addEventListener/g) || []).length, 1, 'единственный слушатель — на кнопке «Понятно», закрытия по клику мимо нет');
});

test('панель одна на приложение: повторная ошибка заменяет текст', () => {
  const idx = lineUi.indexOf('function showErrorPanel(html)');
  const body = lineUi.slice(idx, lineUi.indexOf('function showError(msg)', idx));
  assert.match(body, /getElementById\('errorPanel'\)/, 'панель переиспользуется по id');
  assert.match(body, /querySelector\('\.error-panel-text'\)\.innerHTML = html/, 'повторная ошибка заменяет текст');
});

test('ошибки транзакций идут в панель, а не только в toast', () => {
  assert.match(lineUi, /showErrorPanel\('Действие не отменено: '/, 'конфликты отмены undoLastAction — панель');
  assert.match(replay, /showErrorPanel\('⚠️ '\+escapeHtml\(offlineReasonLabel\(result\.reason\)\)\)/, 'отказ погрузки (защитный интервал) при офлайн-воспроизведении — панель');
  assert.match(nas, /showErrorPanel\('⚠️ '\+escapeHtml\(offlineReasonLabel\(result\.reason\)\)\)/, 'отказ действия на Ubuntu-сервере — панель');
});

test('панель стилизована в style-04.css на переменных темы, без inline-стилей', () => {
  assert.match(css, /\.error-panel\s*\{/, 'есть базовый класс .error-panel');
  assert.match(css, /\.error-panel\.open/, 'есть состояние open');
  assert.match(css.slice(css.indexOf('.error-panel {'), css.indexOf('.error-panel-text')), /var\(--danger\)/, 'оформление на существующих переменных');
  const panelBody = lineUi.slice(lineUi.indexOf('function showErrorPanel'), lineUi.indexOf('function showError(msg)'));
  assert.doesNotMatch(panelBody, /\.style\./, 'инлайн-стили в JS не ставятся');
});
