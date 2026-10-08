import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const constLine = (name) => app.match(new RegExp(`const ${name} = [^\\n]*;`))[0];

const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};
// Tabs of one browser window share localStorage; each tab has its own sessionStorage.
function browser() {
  const shared = storage();
  const clock = { now: 1_000_000 };
  const openTab = () => {
    const session = storage();
    const context = vm.createContext({ sessionStorage: session, localStorage: shared, Number, JSON, Date: { now: () => clock.now } });
    vm.runInContext([constLine('LIVECHAT_LOGIN_BACKUP'), constLine('LIVECHAT_TOKEN_EPOCH'), constLine('LIVECHAT_TOKEN_EPOCH_KEY'),
      fn('saveLiveChatLogin'), fn('forgetLiveChatLogin'), fn('restoreLiveChatLogins'), fn('dropOldLiveChatTokens'), fn('liveChatAgentTokens')].join('\n'), context);
    // what the page does as it loads
    vm.runInContext('dropOldLiveChatTokens(); restoreLiveChatLogins();', context);
    return { session, call: (code) => vm.runInContext(code, context), tokens: () => JSON.stringify(vm.runInContext('liveChatAgentTokens()', context)) };
  };
  return { shared, clock, openTab };
}

test('a login made in one tab is there when another tab of the same browser window opens', () => {
  const b = browser();
  const first = b.openTab();
  assert.equal(first.tokens(), '{}');
  first.call(`saveLiveChatLogin('lc1', 'tok-1', ${b.clock.now + 3600_000})`);
  assert.equal(first.tokens(), JSON.stringify({ lc1: 'tok-1' }));
  const second = b.openTab();
  assert.equal(second.tokens(), JSON.stringify({ lc1: 'tok-1' }), 'no second sign-in');
  assert.equal(second.session.getItem('ca-livechat-selected-account'), 'lc1');
});

test('each account keeps its own login, and an expired shared login is not handed to a new tab (and is cleaned away)', () => {
  const b = browser();
  const first = b.openTab();
  first.call(`saveLiveChatLogin('lc1', 'tok-1', ${b.clock.now + 3600_000})`);
  first.call(`saveLiveChatLogin('lc2', 'tok-2', ${b.clock.now + 10_000})`);
  b.clock.now += 20_000;
  const second = b.openTab();
  assert.equal(second.tokens(), JSON.stringify({ lc1: 'tok-1' }));
  assert.equal(b.shared.map.has('ca-livechat-login-backup:lc2'), false);
});

test('a tab that already has its own valid login keeps it', () => {
  const b = browser();
  const first = b.openTab();
  first.call(`saveLiveChatLogin('lc1', 'tok-old', ${b.clock.now + 3600_000})`);
  const second = b.openTab();
  second.call(`saveLiveChatLogin('lc1', 'tok-new', ${b.clock.now + 7200_000})`);
  const third = b.openTab();
  assert.equal(third.tokens(), JSON.stringify({ lc1: 'tok-new' }), 'the newest login is the shared one');
  assert.equal(first.tokens(), JSON.stringify({ lc1: 'tok-old' }), 'an open tab is not changed under its feet');
});

test('forgetting a login (expired or refused) removes it from the shared copy too, so no tab brings it back', () => {
  const b = browser();
  const first = b.openTab();
  first.call(`saveLiveChatLogin('lc1', 'tok-1', ${b.clock.now + 3600_000})`);
  first.call(`forgetLiveChatLogin('lc1')`);
  assert.equal(first.tokens(), '{}');
  assert.equal(b.openTab().tokens(), '{}');
});

test('the one-time re-login drops the shared copy as well, and a new tab does not repeat it', () => {
  const b = browser();
  b.shared.setItem('ca-livechat-login-backup:lc1', JSON.stringify({ token: 'pre-scope', expiresAt: b.clock.now + 3600_000 }));
  const first = b.openTab();     // no epoch mark anywhere: everything stored from before is dropped
  assert.equal(first.tokens(), '{}');
  first.call(`saveLiveChatLogin('lc1', 'fresh', ${b.clock.now + 3600_000})`);
  const second = b.openTab();    // the mark is in localStorage now, so a new tab keeps the fresh login
  assert.equal(second.tokens(), JSON.stringify({ lc1: 'fresh' }));
});

test('a tab that already carried the epoch mark in its session (from before this change) is not made to sign in again', () => {
  const b = browser();
  const session = storage();
  session.setItem('ca-livechat-token-epoch', '2026-10-08-accounts-scopes');
  session.setItem('ca-livechat-agent-token:lc1', 'still-good');
  session.setItem('ca-livechat-agent-token-expiry:lc1', String(b.clock.now + 3600_000));
  const context = vm.createContext({ sessionStorage: session, localStorage: b.shared, Number, JSON, Date: { now: () => b.clock.now } });
  vm.runInContext([constLine('LIVECHAT_LOGIN_BACKUP'), constLine('LIVECHAT_TOKEN_EPOCH'), constLine('LIVECHAT_TOKEN_EPOCH_KEY'), fn('forgetLiveChatLogin'), fn('dropOldLiveChatTokens'), fn('liveChatAgentTokens')].join('\n') + '\ndropOldLiveChatTokens();', context);
  assert.equal(JSON.stringify(vm.runInContext('liveChatAgentTokens()', context)), JSON.stringify({ lc1: 'still-good' }));
});

test('blocked storage never throws; the sign-in connect step saves through the shared helper', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const context = vm.createContext({ sessionStorage: blocked, localStorage: blocked, Number, JSON, Date });
  vm.runInContext([constLine('LIVECHAT_LOGIN_BACKUP'), constLine('LIVECHAT_TOKEN_EPOCH'), constLine('LIVECHAT_TOKEN_EPOCH_KEY'),
    fn('saveLiveChatLogin'), fn('forgetLiveChatLogin'), fn('restoreLiveChatLogins'), fn('dropOldLiveChatTokens')].join('\n') + "\ndropOldLiveChatTokens(); restoreLiveChatLogins(); saveLiveChatLogin('lc1', 't', 1); forgetLiveChatLogin('lc1');", context);
  assert.match(app, /saveLiveChatLogin\(login\.accountKey, login\.token, login\.expiresAt\);/);
  assert.match(app, /function dropLiveChatToken\(accountKey\) \{\s*forgetLiveChatLogin\(accountKey\);/);
});
