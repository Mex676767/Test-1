import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `found ${name} in app.js`);
  return match[0];
};
const source = grab('ensureLiveChatLoginForClaim');

// The LiveChat login lasts 8 hours: a claim that needs a ticket reconnects right there instead of failing with a ticket error.
function world({ tokens = {}, account = 'lc2', preview = false, clients, connect, config } = {}) {
  const calls = { overlays: [], connects: [], saved: [], current: [], fetches: 0 };
  const buttons = {};
  const overlay = {
    removed: false, remove() { this.removed = true; },
    querySelector: (selector) => buttons[selector],
  };
  const button = () => { const handlers = {}; return { disabled: false, textContent: '', className: '', addEventListener: (type, fn) => { handlers[type] = fn; }, click: () => handlers.click?.(), handlers }; };
  const context = vm.createContext({
    previewMode: preview, currentLiveChatAccount: account, location: { origin: 'https://widget.test' },
    liveChatAgentTokens: () => tokens, escapeHtml: (value) => String(value),
    setCurrentLiveChatAccount: (key) => { calls.current.push(key); context.currentLiveChatAccount = key; },
    fetch: async () => { calls.fetches++; return { json: async () => config ?? { clients: clients ?? [{ key: 'lc1', clientId: 'c1' }, { key: 'lc2', clientId: 'c2' }], redirectUri: 'https://widget.test/blast/oauth.html' } }; },
    agentLoginPanel: (html) => {
      calls.overlays.push(html);
      for (const id of ['#claimReconnect', '#claimReconnectCancel', '#claimReconnectStatus']) buttons[id] = button();
      return overlay;
    },
    connectLiveChatLogin: async (list, redirect, onProgress) => { calls.connects.push({ keys: list.map((c) => c.key), redirect }); onProgress?.('Opening LiveChat…'); return connect ? connect() : { accountKey: list[0].key, token: 'fresh-token', expiresAt: Date.now() + 8 * 3600_000 }; },
    saveLiveChatLogin: (key, token, expiresAt) => calls.saved.push({ key, token, expiresAt }),
  });
  vm.runInContext(source, context);
  return { context, calls, buttons, overlay, run: () => context.ensureLiveChatLoginForClaim() };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a valid login for this chat\'s account never interrupts the claim', async () => {
  const w = world({ tokens: { lc2: 'tok' } });
  assert.equal(await w.run(), true);
  assert.equal(w.calls.overlays.length, 0);
  assert.equal(w.calls.fetches, 0);
});

test('admin preview never asks to reconnect', async () => {
  const w = world({ tokens: {}, preview: true });
  assert.equal(await w.run(), true);
  assert.equal(w.calls.overlays.length, 0);
});

test('an expired login for LC 2 asks to reconnect LC 2 only, saves the new login and lets the claim carry on', async () => {
  const w = world({ tokens: { lc1: 'still-valid-lc1-token' }, account: 'lc2' });
  const pending = w.run();
  await tick();
  assert.equal(w.calls.overlays.length, 1);
  assert.match(w.calls.overlays[0], /LiveChat account 2 login expired/);
  assert.match(w.calls.overlays[0], /lasts 8 hours/);
  w.buttons['#claimReconnect'].click();
  assert.equal(await pending, true);
  assert.deepEqual(w.calls.connects.map((item) => item.keys), [['lc2']], 'only the expired account is reconnected');
  assert.equal(w.calls.saved[0].key, 'lc2');
  assert.equal(w.calls.saved[0].token, 'fresh-token');
  assert.deepEqual(w.calls.current, ['lc2']);
  assert.equal(w.overlay.removed, true);
});

test('cancelling the reconnect stops the claim', async () => {
  const w = world({ tokens: {}, account: 'lc2' });
  const pending = w.run();
  await tick();
  w.buttons['#claimReconnectCancel'].click();
  assert.equal(await pending, false);
  assert.equal(w.calls.saved.length, 0);
  assert.equal(w.overlay.removed, true);
});

test('a failed reconnect shows why and can be retried or cancelled', async () => {
  let attempts = 0;
  const w = world({ tokens: {}, account: 'lc1', connect: () => { attempts++; if (attempts === 1) throw new Error('Your browser blocked the next LiveChat window.'); return { accountKey: 'lc1', token: 't2', expiresAt: Date.now() + 1000 }; } });
  const pending = w.run();
  await tick();
  w.buttons['#claimReconnect'].click();
  await tick();
  assert.match(w.buttons['#claimReconnectStatus'].textContent, /blocked/);
  assert.equal(w.buttons['#claimReconnect'].disabled, false, 'the button works again');
  w.buttons['#claimReconnect'].click();
  assert.equal(await pending, true);
  assert.equal(attempts, 2);
});

test('with no chat account chosen yet and exactly one connected login, that account is used without asking', async () => {
  const w = world({ tokens: { lc2: 'tok' }, account: '' });
  assert.equal(await w.run(), true);
  assert.deepEqual(w.calls.current, ['lc2']);
  assert.equal(w.calls.overlays.length, 0);
});

test('if LiveChat login is not set up at all, the claim is not blocked here', async () => {
  const w = world({ tokens: {}, account: 'lc2', clients: [] });
  assert.equal(await w.run(), true);
  assert.equal(w.calls.overlays.length, 0);
});

test('every claim ticket goes through the reconnect check first, before anything is asked or created', () => {
  const raise = grab('raiseClaimTicket');
  const at = (text) => raise.indexOf(text);
  assert.ok(at('ensureLiveChatLoginForClaim()') > 0, 'raiseClaimTicket reconnects when needed');
  assert.ok(at('ensureLiveChatLoginForClaim()') < at('claimTicketBusy.add(chatId)'), 'before the claim is marked busy');
  assert.ok(at('ensureLiveChatLoginForClaim()') < at('ticketAccountForClaim(chatId)'), 'before the ticket account is checked');
  assert.ok(at('ensureLiveChatLoginForClaim()') < at('fetchTicketConfig'), 'before the ticket form is loaded (which needs the login)');
});
