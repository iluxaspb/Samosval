// Cooperative agent bridge. Never pass credentials for the website to this command.
import { setTimeout as delay } from 'node:timers/promises';
const [action, chat] = process.argv.slice(2);
const origin = process.env.VIEW_ORIGIN;
if (!origin || !process.env.OPENCODE_PASSWORD || !['show', 'login', 'status', 'finish'].includes(action)) {
  throw Error('Use VIEW_ORIGIN, OPENCODE_PASSWORD and: node agent-browser.mjs show|login|status|finish /server/<key>/session/<id>');
}
const headers = { Authorization: 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64'), Origin: origin, 'Content-Type': 'application/json' };
async function request(action) {
  const r = await fetch(origin + '/__browser/handoff', { headers, ...(action ? { method: 'POST', body: JSON.stringify({ action, chat }) } : {}), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error(`Browser bridge HTTP ${r.status}`);
  return r.json();
}
if (action === 'status') console.log(JSON.stringify(await request()));
else {
  let state = await request(action);
  console.log(JSON.stringify(state));
  if (action === 'login') {
    console.log('Waiting for user login. Do not use MCP, inspect DOM, or capture screenshots until resume.');
    const until = Date.now() + 15 * 60 * 1000;
    while (Date.now() < until) {
      await delay(1000); state = await request();
      if (state.chat !== chat || state.phase === 'inactive') throw Error('Handoff cancelled; do not resume automation');
      if (state.phase === 'working') { console.log('User returned control. Login success has not been verified.'); process.exit(0); }
    }
    throw Error('Login wait expired; do not resume automation');
  }
}
