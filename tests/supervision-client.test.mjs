import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = name => app.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

test('a supervised card cannot write via automatic recording, link saves, Unknown, claims, name edits, notes or birthdays', async () => {
  const s = { lookupReadOnly: true, caRecordId: 'recPrevious', chatUrl: 'https://my.livechatinc.com/chats/C/T', username: 'player', brand: 'JOM', agentWrote: true };
  const c = vm.createContext({ state: { c1: s }, fetch: () => { throw new Error('Unexpected write'); } });
  const names = ['submitRecordOnce', 'resyncLoggedRecord', 'saveLinkToRecord', 'reportUnknownTick', 'reportClaim', 'setUnknown', 'removeStaleRecordsForChat', 'savePlayerName', 'checkBirthdayAmount', 'removeBirthdayPicture', 'addCaseFlow', 'agentActed', 'agentTouchedChat', 'consoleNoteBlocker'];
  vm.runInContext(names.map(fn).join('\n'), c);
  for (const name of names.slice(0, 11)) await c[name]('c1');
  assert.equal(s.caRecordId, 'recPrevious');
  assert.equal(c.agentActed(s), false);
  assert.equal(c.agentTouchedChat(s), false);
  assert.match(c.consoleNoteBlocker(s), /Read-only/);
  assert.equal(c.consoleNoteBlocker(s, false), '', 'supervisors may still read existing notes');
});

test('the lookup sends the signed-in account token and preserves the read-only server result', async () => {
  let posted;
  const c = vm.createContext({ previewMode: false, currentLiveChatAccount: 'lc2', liveChatAgentTokens: () => ({ lc2: 'test-token' }),
    fetch: async (url, options) => { posted = JSON.parse(options.body); return { text: async () => JSON.stringify({ ok: true, readOnly: true, readOnlyReason: 'Supervising', row: {} }) }; } });
  vm.runInContext(fn('fetchBonusRow'), c);
  const result = await c.fetchBonusRow('player', 'JOM', 'https://my.livechatinc.com/chats/C/T', false, 'Guide', null);
  assert.deepEqual(posted.chatAccess, { accountKey: 'lc2', agentToken: 'test-token' });
  assert.equal(result.readOnly, true);
  assert.equal(result.readOnlyReason, 'Supervising');
});

test('the SDK chat ID supplies a usable link immediately, before the first status poll', () => {
  const c = vm.createContext({});
  vm.runInContext(fn('chatFromProfile'), c);
  assert.equal(c.chatFromProfile({ chat: { id: 'THREAD', chat_id: 'CHAT' } }).link, 'https://my.livechatinc.com/chats/CHAT/THREAD');
});
