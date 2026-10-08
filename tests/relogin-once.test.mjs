import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const constLine = (name) => app.match(new RegExp(`const ${name} = [^\\n]*;`))[0];

function tab(initial = {}) {
  const store = new Map(Object.entries(initial));
  const sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const context = vm.createContext({ sessionStorage, Number, Date });
  vm.runInContext([constLine('LIVECHAT_TOKEN_EPOCH'), constLine('LIVECHAT_TOKEN_EPOCH_KEY'), fn('dropOldLiveChatTokens'), fn('liveChatAgentTokens')].join('\n'), context);
  return { store, boot: () => vm.runInContext('dropOldLiveChatTokens()', context), tokens: () => JSON.stringify(vm.runInContext('liveChatAgentTokens()', context)) };
}
const future = String(Date.now() + 3600_000);
const oldLogins = { 'ca-livechat-agent-token:lc1': 'old1', 'ca-livechat-agent-token-expiry:lc1': future, 'ca-livechat-agent-token:lc2': 'old2', 'ca-livechat-agent-token-expiry:lc2': future };

test('a tab that logged in before the scope change loses its logins once, so the agent signs in again', () => {
  const t = tab(oldLogins);
  assert.equal(t.tokens(), JSON.stringify({ lc1: 'old1', lc2: 'old2' }));
  t.boot();
  assert.equal(t.tokens(), '{}');
  assert.ok(t.store.get('ca-livechat-token-epoch'));
});

test('after that, a new login is kept: the drop happens only once per tab', () => {
  const t = tab(oldLogins);
  t.boot();
  t.store.set('ca-livechat-agent-token:lc1', 'new1');
  t.store.set('ca-livechat-agent-token-expiry:lc1', future);
  t.boot(); // a reload
  assert.equal(t.tokens(), JSON.stringify({ lc1: 'new1' }));
});

test('a fresh tab with no login is unaffected, and blocked storage does not throw', () => {
  const t = tab();
  t.boot();
  assert.equal(t.tokens(), '{}');
  const broken = vm.createContext({ sessionStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } } });
  vm.runInContext([constLine('LIVECHAT_TOKEN_EPOCH'), constLine('LIVECHAT_TOKEN_EPOCH_KEY'), fn('dropOldLiveChatTokens')].join('\n') + '\ndropOldLiveChatTokens()', broken);
});

test('the drop runs at load, before anything reads the stored logins', () => {
  const call = app.indexOf('\ndropOldLiveChatTokens();');
  assert.ok(call > -1);
  assert.ok(call > app.indexOf('const LIVECHAT_TOKEN_EPOCH ='), 'after its constants exist');
  assert.ok(call < app.indexOf('if (AGENT_LOGIN_LIVE) await requireAgentLogin();'), 'before the boot sign-in');
  assert.ok(call < app.indexOf('const optionsReady = refreshDropdownOptions();'), 'before the boot sequence starts');
});
