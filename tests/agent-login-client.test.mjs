import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

function loginFlag(embedded, search) {
  const expr = app.match(/const AGENT_LOGIN_LIVE = ([^\n]+);/)[1];
  return vm.runInContext(expr, vm.createContext({ IS_EMBEDDED_APP: embedded, location: { search }, URLSearchParams }));
}

test('the LiveChat login is ON for everyone; adding agentLogin=0 to the address turns it off without a deploy', () => {
  assert.equal(loginFlag(true, '?account=lc1'), true, 'the real widget');
  assert.equal(loginFlag(true, ''), true);
  assert.equal(loginFlag(false, ''), true, 'the preview');
  assert.equal(loginFlag(false, '?agentLogin=1'), true);
  assert.equal(loginFlag(true, '?account=lc1&agentLogin=0'), false, 'the emergency off switch');
  assert.equal(loginFlag(false, '?agentLogin=0'), false);
});

test('the department switches were left alone', () => {
  assert.match(app, /const DEPARTMENT_TABS_LIVE = false;/);
  assert.match(app, /const DEPARTMENT_SEPARATION_ENABLED = false;/);
  assert.match(app, /const AUTOMATIC_DEPARTMENT_DETECTION = false;/);
});

test('with the login on, an older self-chosen name is not trusted and the boot waits for the login', () => {
  assert.match(app, /let selectedAgent = AGENT_LOGIN_LIVE \? "" : \(localStorage\.getItem\(AGENT_KEY\) \|\| ""\);/);
  const boot = app.slice(app.indexOf('const optionsReady = refreshDropdownOptions();'));
  const login = boot.indexOf('if (AGENT_LOGIN_LIVE) await requireAgentLogin();');
  assert.ok(login > -1);
  assert.ok(login < boot.indexOf('openSettingsPanel();'), 'before the manual name panel could open');
});

test('once the name comes from the login, Settings shows it read-only and the Save button cannot change it', () => {
  const panel = app.slice(app.indexOf('function openSettingsPanel'), app.indexOf('function renderDiagnosticsLog'));
  assert.match(panel, /agentLocked\s*\n?\s*\? `<div class="input settings-text" id="agentLockedName">/);
  assert.match(panel, /if \(agentLocked\) \{ overlay\.remove\(\); return; \}/);
});

// ---- requireAgentLogin, driven with fakes ---------------------------------------------------------
function harness({ configured = '', stored = {}, serverReplies }) {
  const session = new Map(Object.entries(stored));
  const calls = { posted: [], panels: [], bound: [], picked: [], dropped: [] };
  const handlers = {};
  const context = vm.createContext({
    JSON, Date, Promise, Boolean, URL, location: { origin: 'https://app.test' }, CONFIGURED_LIVECHAT_ACCOUNT: configured,
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) },
    escapeHtml: (s) => String(s ?? ''),
    fetch: async (url, options) => {
      if (url === '/livechat-oauth-config') {
        return { json: async () => ({ clients: [{ key: 'lc1', clientId: 'c1' }, { key: 'lc2', clientId: 'c2' }], redirectUri: 'https://app.test/blast/oauth.html' }) };
      }
      const body = JSON.parse(options.body);
      calls.posted.push(body);
      const reply = serverReplies.shift();
      if (reply instanceof Error) throw reply;
      return { json: async () => reply };
    },
    agentLoginPanel: (html) => {
      calls.panels.push(html);
      return { querySelector: (sel) => ({ addEventListener: (ev, fnc) => { handlers[sel] = fnc; }, disabled: false, className: '', textContent: '' }) };
    },
    applyBoundAgent: (name, key) => calls.bound.push([name, key]),
    pickAgentName: async (key, token, available) => { calls.picked.push([key, token, available]); },
    connectLiveChatLogin: async () => ({ accountKey: 'lc1', token: 'fresh', expiresAt: Date.now() + 3600_000 }),
  });
  vm.runInContext([fn('liveChatAgentTokens'), fn('dropLiveChatToken'), fn('postAgentLogin'), fn('requireAgentLogin')].join('\n'), context);
  return { context, calls, handlers, session, run: () => vm.runInContext('requireAgentLogin()', context) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const future = String(Date.now() + 3600_000);

test('a login the server already knows gets its name straight away, with no panel', async () => {
  const h = harness({ stored: { 'ca-livechat-agent-token:lc1': 'tok', 'ca-livechat-agent-token-expiry:lc1': future }, serverReplies: [{ ok: true, bound: true, name: '96 Teh' }] });
  await h.run();
  assert.deepEqual(h.calls.bound, [['96 Teh', 'lc1']]);
  assert.deepEqual(h.calls.posted, [{ accountKey: 'lc1', agentToken: 'tok' }]);
  assert.equal(h.calls.panels.length, 0);
});

test('a new login goes to the one-time name choice with the names the server offered', async () => {
  const h = harness({ stored: { 'ca-livechat-agent-token:lc2': 'tok2', 'ca-livechat-agent-token-expiry:lc2': future }, serverReplies: [{ ok: true, bound: false, available: ['96 Mexha'] }] });
  await h.run();
  assert.deepEqual(h.calls.picked, [['lc2', 'tok2', ['96 Mexha']]]);
  assert.deepEqual(h.calls.bound, []);
});

test('a widget installed in one LiveChat account ignores a login stored for the other', async () => {
  const h = harness({ configured: 'lc2', stored: { 'ca-livechat-agent-token:lc1': 'wrong', 'ca-livechat-agent-token-expiry:lc1': future, 'ca-livechat-agent-token:lc2': 'right', 'ca-livechat-agent-token-expiry:lc2': future }, serverReplies: [{ ok: true, bound: true, name: 'A' }] });
  await h.run();
  assert.deepEqual(h.calls.posted.map((p) => [p.accountKey, p.agentToken]), [['lc2', 'right']]);
});

test('an expired login is dropped, the agent is asked to connect again, and the new login is used', async () => {
  const h = harness({ stored: { 'ca-livechat-agent-token:lc1': 'old', 'ca-livechat-agent-token-expiry:lc1': future }, serverReplies: [{ ok: false, loginExpired: true, error: 'LiveChat login expired' }, { ok: true, bound: true, name: '96 Edwin' }] });
  const done = h.run();
  await tick(); await tick();
  assert.equal(h.session.has('ca-livechat-agent-token:lc1'), false, 'the stale token is gone');
  assert.match(h.calls.panels.at(-1), /Connect LiveChat/);
  assert.match(h.calls.panels.at(-1), /LiveChat login expired/);
  await h.handlers['#agentLoginConnect']();
  await done;
  assert.deepEqual(h.calls.posted.map((p) => p.agentToken), ['old', 'fresh']);
  assert.deepEqual(h.calls.bound, [['96 Edwin', 'lc1']]);
});

test('an unreachable server offers Try again without throwing the stored login away', async () => {
  const h = harness({ stored: { 'ca-livechat-agent-token:lc1': 'tok', 'ca-livechat-agent-token-expiry:lc1': future }, serverReplies: [new Error('offline'), { ok: true, bound: true, name: 'X' }] });
  const done = h.run();
  await tick(); await tick();
  assert.match(h.calls.panels.at(-1), /Try again/);
  assert.equal(h.session.get('ca-livechat-agent-token:lc1'), 'tok');
  await h.handlers['#agentLoginConnect']();
  await done;
  assert.deepEqual(h.calls.bound, [['X', 'lc1']]);
});
