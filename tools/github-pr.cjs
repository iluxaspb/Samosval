#!/usr/bin/env node
'use strict';
// Credentials stay in memory and are obtained from Git's existing helper.
const cp = require('node:child_process');
const fs = require('node:fs');
const REPO = 'iluxaspb/Samosval';
function git(args, options = {}) {
  return cp.execFileSync('git', args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }).trim();
}
function credential() {
  const text = git(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
  const fields = Object.fromEntries(text.split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (!fields.password) throw new Error('Git credential helper не вернул учётные данные.');
  return fields.password;
}
function validateBranch(branch) {
  if (!branch || branch === 'root' || branch === 'docs/opencode-project-rules-20261031') {
    throw new Error('Нужна отдельная ветка задачи, не root и не ветка PR #73.');
  }
}
function validateChanges(files) {
  if (!files?.length || files.length >= 300) throw new Error('Пустой или слишком большой diff.');
  const protectedPath = /^(?:index\.html$|sw\.js$|manifest\.json$|firebase\.json$|\.firebaserc$|app\/|server\/|nas-preview\/)|\.rules$|(?:^|\/)(?:\.env(?:\..*)?$|[^/]*\.(?:key|pem)$|[^/]*credentials[^/]*$)/i;
  for (const file of files) {
    if ([file.filename, file.previous_filename].filter(Boolean).some(name => protectedPath.test(name))) {
      throw new Error('Защищённые файлы требуют отдельного согласования.');
    }
  }
}
async function request(token, endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status} (${method}).`);
  return response.json();
}
async function main(args = process.argv.slice(2)) {
  const mode = args[0] || 'check';
  if (!['check', 'plan', 'create'].includes(mode)) throw new Error('Режимы: check | plan | create "заголовок" файл-описания');
  if ((mode !== 'create' && args.length > 1) || (mode === 'create' && args.length !== 3)) {
    throw new Error('Использование: node tools/github-pr.cjs check|plan либо create "заголовок" файл-описания');
  }
  const remote = git(['remote', 'get-url', 'origin']);
  if (!['https://github.com/iluxaspb/Samosval.git', 'https://github.com/iluxaspb/Samosval',
    'git@github.com:iluxaspb/Samosval.git'].includes(remote)) throw new Error('Неожиданный origin; операция остановлена.');
  const branch = git(['branch', '--show-current']);
  const token = credential();
  const api = (endpoint, method, body) => request(token, endpoint, method, body);
  const repo = await api(`/repos/${REPO}`);
  const user = await api('/user');
  const rules = await api(`/repos/${REPO}/pulls/73`);
  if (repo.default_branch !== 'root') throw new Error('Основная ветка отличается от root.');
  console.log(JSON.stringify({ mode, repository: REPO, login: user.login, branch,
    base: repo.default_branch, pushPermission: !!repo.permissions?.push,
    rulesPR: { number: 73, state: rules.state, url: rules.html_url } }, null, 2));
  if (mode === 'check') return;
  validateBranch(branch);
  const prs = await api(`/repos/${REPO}/pulls?state=open&head=${encodeURIComponent('iluxaspb:' + branch)}&base=root`);
  if (prs.length) {
    console.log('PR уже существует: ' + prs.map(pr => pr.html_url).join(', ')); return;
  }
  if (mode === 'plan') {
    console.log('Только чтение. Создание: node tools/github-pr.cjs create "заголовок" файл-описания'); return;
  }
  if (!repo.permissions?.push) throw new Error('Нет права push.');
  if (git(['status', '--porcelain'])) throw new Error('Перед созданием PR рабочее дерево должно быть чистым.');
  const head = git(['rev-parse', 'HEAD']);
  const remoteHead = await api(`/repos/${REPO}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (remoteHead.object.sha !== head) throw new Error('Сначала push проверенного коммита: удалённая ветка отличается от HEAD.');
  const comparison = await api(`/repos/${REPO}/compare/root...${encodeURIComponent(branch)}`);
  if (!comparison.ahead_by) throw new Error('Нет изменений для PR.');
  validateChanges(comparison.files);
  const title = args[1].trim();
  const body = fs.readFileSync(args[2], 'utf8').trim();
  if (!title || body.length < 80) throw new Error('Нужны заголовок и содержательное описание: файлы, причина, проверки, риски.');
  for (const section of ['## Причина', '## Изменённые файлы', '## Проверки', '## Риски']) {
    if (!body.includes(section)) throw new Error('Отсутствует обязательный раздел описания.');
  }
  const pr = await api(`/repos/${REPO}/pulls`, 'POST', { title, body, head: branch, base: 'root', draft: true });
  console.log('Создан draft PR: ' + pr.html_url);
}
module.exports = { validateBranch, validateChanges, main };
if (require.main === module) main().catch(() => {
  // Never print subprocess output, API payloads or credential-bearing errors.
  console.error('Операция не выполнена. Проверьте origin, авторизацию, ветку, чистоту дерева, push и аргументы. Секретные ответы скрыты.');
  process.exitCode = 1;
});
