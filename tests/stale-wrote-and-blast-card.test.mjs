import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../blast/web-adapter.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const constLine = (name) => app.match(new RegExp(`const ${name} = [^\\n]*;`))[0];

// ---- old "did not write" answers (made when the id and the email never matched) are not trusted ----
function wroteHarness(chat, reply) {
  const st = { c1: { chatUrl: 'https://my.livechatinc.com/chats/CHAT/THREAD', ...chat } };
  const fetched = [];
  const context = vm.createContext({
    JSON, Boolean, String, AGENT_LOGIN_LIVE: true, state: st, currentLiveChatAccount: 'lc1', liveChatAgentTokens: () => ({ lc1: 'tok' }), logDiagnostic() {},
    fetch: async () => { fetched.push(1); return { json: async () => reply }; },
  });
  vm.runInContext([constLine('AGENT_WROTE_VERSION'), fn('agentWroteVerdict'), fn('agentWroteInChat')].join('\n'), context);
  return { st, fetched, ask: () => vm.runInContext("agentWroteInChat('c1')", context), verdict: () => vm.runInContext("agentWroteVerdict(state.c1)", context) };
}

test('a "did not write" saved without the current version is asked again, and the new answer is stamped', async () => {
  const h = wroteHarness({ agentWrote: false }, { ok: true, wrote: true, authors: ['a@x'], me: ['a@x'] });
  assert.equal(h.verdict(), undefined, 'not trusted');
  assert.equal(await h.ask(), true, 'the chat is theirs after all');
  assert.equal(h.fetched.length, 1);
  assert.equal(h.st.c1.agentWrote, true);
  assert.equal(h.st.c1.agentWroteV, 2);
});

test('a current "did not write" is still remembered, and a saved "wrote" or "unsure" is never discarded', async () => {
  const current = wroteHarness({ agentWrote: false, agentWroteV: 2 }, { ok: true, wrote: true });
  assert.equal(await current.ask(), false);
  assert.equal(current.fetched.length, 0);
  assert.equal(wroteHarness({ agentWrote: true }, {}).verdict(), true);
  assert.equal(wroteHarness({ agentWrote: 'unsure' }, {}).verdict(), 'unsure');
  assert.equal(wroteHarness({}, {}).verdict(), undefined);
});

test('a fresh "did not write" is stamped with the version so it is trusted next time', async () => {
  const h = wroteHarness({}, { ok: true, wrote: false, authors: ['b@x'], me: ['a@x'] });
  assert.equal(await h.ask(), false);
  assert.equal(h.st.c1.agentWroteV, 2);
  await h.ask();
  assert.equal(h.fetched.length, 1);
});

test('the sweep re-asks about a closed chat whose only verdict is an old "did not write"', () => {
  assert.match(app, /!\(AGENT_LOGIN_LIVE && agentWroteVerdict\(idle\) === undefined\)/);
});

// ---- Blast: the LiveChat account card is hidden while the widget's login is valid ------------------
function blastCard({ connected, expiresIn = 3600_000 }) {
  const start = adapter.indexOf('let connectionExpiryTimer = null;');
  const end = adapter.indexOf('  let oauthConfig =');
  assert.ok(start > -1 && end > start);
  const banner = { innerHTML: 'old', style: { display: '' }, querySelector: () => null };
  const timers = [];
  const now = 5_000_000;
  const context = vm.createContext({
    document: { getElementById: (id) => (id === 'bridgeBanner' ? banner : { disabled: false, style: {}, addEventListener() {} }) },
    detectedAccount: () => 'lc1', selectedAccount: () => 'lc1', token: () => (connected ? 'tok' : ''),
    accountStorageKey: (k, a) => `${k}:${a}`, TOKEN_EXPIRY_KEY: 'expiry',
    sessionStorage: { getItem: () => String(now + expiresIn) }, Number, Math, Boolean, Date: { now: () => now },
    setTimeout: (f, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
    oauthConfig: { clients: [] },
  });
  vm.runInContext(adapter.slice(start, end), context);
  vm.runInContext("renderConnection({ clients: [{ key: 'lc1', clientId: 'c' }] })", context);
  return { banner, timers };
}

test('Blast: with a valid LiveChat login the account card (and its Reconnect button) is gone, and comes back when the login expires', () => {
  const on = blastCard({ connected: true, expiresIn: 3600_000 });
  assert.equal(on.banner.innerHTML, '');
  assert.equal(on.banner.style.display, 'none');
  assert.deepEqual(on.timers, [3601_000], 'it re-checks just after the login runs out');
});

test('Blast: without a valid login the Connect card is shown as before', () => {
  const off = blastCard({ connected: false });
  assert.match(off.banner.innerHTML, /Connect/);
  assert.doesNotMatch(off.banner.innerHTML, /Reconnect/);
  assert.equal(off.banner.style.display, '');
  assert.deepEqual(off.timers, []);
});
