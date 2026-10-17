import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

function widget({ previewMode = false, selectedAgent = '96 Alice', state = {}, failing = false } = {}) {
  const posts = [];
  const context = vm.createContext({
    previewMode, selectedAgent, state, String, JSON,
    fetch: (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return failing ? Promise.reject(new Error('offline')) : Promise.resolve({}); },
  });
  vm.runInContext(fn('reportUnknownTick'), context);
  return { posts, report: (...args) => vm.runInContext(`reportUnknownTick(${args.map((a) => JSON.stringify(a)).join(',')})`, context) };
}

test('ticking Unknown tells the server the thread and chat from the card\'s link, the agent, and whether it was automatic', () => {
  const w = widget({ state: { CHAT1: { chatUrl: 'https://my.livechatinc.com/chats/CHAT1/THREAD1' } } });
  w.report('CHAT1', true, false);
  w.report('CHAT1', false, false);
  w.report('CHAT1', true, true);
  assert.deepEqual(w.posts.map((p) => p.url), ['/unknown-tick', '/unknown-tick', '/unknown-tick']);
  assert.deepEqual(w.posts[0].body, { agentName: '96 Alice', ticked: true, source: 'manual', threadId: 'THREAD1', chatId: 'CHAT1' });
  assert.equal(w.posts[1].body.ticked, false);
  assert.equal(w.posts[2].body.source, 'auto');
});

test('an archived card is known by its thread id; a card with no link yet is sent by its own id only', () => {
  const archived = widget({ state: { T7: { chatUrl: 'https://my.livechatinc.com/archives/T7' } } });
  archived.report('T7', true, false);
  assert.deepEqual([archived.posts[0].body.threadId, archived.posts[0].body.chatId], ['T7', 'T7']);
  const noLink = widget({ state: { NEWCHAT: { chatUrl: '' } } });
  noLink.report('NEWCHAT', true, false);
  assert.deepEqual([noLink.posts[0].body.threadId, noLink.posts[0].body.chatId], ['', 'NEWCHAT']);
});

test('nothing is sent from the admin preview, without an agent name, or for a chat the widget does not know; a failed send changes nothing', async () => {
  const chat = { C: { chatUrl: '' } };
  const preview = widget({ previewMode: true, state: chat });
  const noAgent = widget({ selectedAgent: '', state: chat });
  const unknown = widget({ state: {} });
  preview.report('C', true, false); noAgent.report('C', true, false); unknown.report('C', true, false);
  assert.equal(preview.posts.length + noAgent.posts.length + unknown.posts.length, 0);
  const offline = widget({ failing: true, state: chat });
  assert.doesNotThrow(() => offline.report('C', true, false));
  await new Promise((resolve) => setTimeout(resolve, 5)); // the rejected send is swallowed, not an unhandled rejection
});

test('every way a chat becomes Unknown or stops being Unknown reports it: the tick, the auto-tick, a forced lookup and a failed forced lookup', () => {
  const setUnknown = app.slice(app.indexOf('function setUnknown'), app.indexOf('function setUnknown') + 400);
  assert.match(setUnknown, /s\.isUnknown = value;\s*\n\s*reportUnknownTick\(chatId, value, silent\);/);
  assert.match(app, /if \(forcing\) \{ s\.isUnknown = false; reportUnknownTick\(chatId, false, true\); \}/);
  assert.match(app, /if \(forcing\) \{ s\.isUnknown = true; reportUnknownTick\(chatId, true, true\); \}/);
});

function claimWidget({ previewMode = false, selectedAgent = '96 Alice', state = {} } = {}) {
  const posts = [];
  const context = vm.createContext({ previewMode, selectedAgent, state, String, JSON, fetch: (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return Promise.resolve({}); } });
  vm.runInContext(fn('reportClaim'), context);
  return { posts, report: (...args) => vm.runInContext('reportClaim(' + args.map((a) => JSON.stringify(a)).join(',') + ')', context) };
}

test('a claim tells the server the agent, the thread and chat ids, and the bonus with its source, inquiry and amount; an unclaim says remove', () => {
  const w = claimWidget({ state: { CHAT1: { chatUrl: 'https://my.livechatinc.com/chats/CHAT1/THREAD1' } } });
  const claim = { program: 'topPnl', label: 'Top 10 P&L', source: 'Pass RM18', inquiry: 'TOP P&L', amount: '18' };
  w.report('CHAT1', claim);
  w.report('CHAT1', null);
  assert.deepEqual(w.posts.map((p) => p.url), ['/claim-log', '/claim-log']);
  assert.deepEqual(w.posts[0].body, { agentName: '96 Alice', threadId: 'THREAD1', chatId: 'CHAT1', claim });
  assert.deepEqual(w.posts[1].body, { agentName: '96 Alice', threadId: 'THREAD1', chatId: 'CHAT1', remove: true });
});

test('claims are never sent from the admin preview, without an agent name, or for a chat the widget does not know', () => {
  const chat = { C: { chatUrl: '' } };
  const a = claimWidget({ previewMode: true, state: chat });
  const b = claimWidget({ selectedAgent: '', state: chat });
  const c = claimWidget({ state: {} });
  a.report('C', { program: 'x' }); b.report('C', { program: 'x' }); c.report('C', { program: 'x' });
  assert.equal(a.posts.length + b.posts.length + c.posts.length, 0);
  const noLink = claimWidget({ state: chat });
  noLink.report('C', { program: 'x' });
  assert.deepEqual([noLink.posts[0].body.threadId, noLink.posts[0].body.chatId], ['', 'C']);
});

test('every way a bonus is claimed or unclaimed reports it: the normal claim, the Grace Period claim and the unclaim', () => {
  assert.match(app, /reportClaim\(chatId, \{ program: "gracePeriod", label: "Grace Period", source: display, inquiry: "Grace Period", amount \}\);/);
  assert.match(app, /const claimedSource = allSources\.find\(\(src\) => src\.key === programKey\);\s*\n\s*reportClaim\(chatId, \{/);
  assert.match(app, /s\.unclaimInFlight = false;\s*\n\s*reportClaim\(chatId, null\);/);
  assert.match(app, /amount: riskClaim\?\.valid \? riskClaim\.formattedClaim : programHasAmount\(programKey\) \? extractAmountNumber\(claimedSource\?\.display\) : ""/);
});

// ---- ticking Unknown also removes the leftover Lark row Needs Attention lists for this chat ------------------------
function leftoverHarness({ staleRecords, chatUrl = '', claimed = {}, caRecordId = null, deleteReply = { ok: true }, selectedAgent = '96 Mexha', previewMode = false }) {
  const calls = { fetched: [], remembered: [], forgotten: [], rendered: 0, status: [] };
  const context = vm.createContext({
    state: { THREAD: { chatUrl, claimedPrograms: claimed, caRecordId } },
    staleRecords, selectedAgent, previewMode,
    rememberDeletedRecord: (id) => calls.remembered.push(id),
    forgetDeletedRecord: (id) => calls.forgotten.push(id),
    renderNeedsAttentionPanel: () => { calls.rendered += 1; },
    setStatus: (text, kind) => calls.status.push([text, kind]),
    logDiagnostic() {}, Set, String, Object, Error, JSON,
    fetch: async (url, options) => { calls.fetched.push([url, JSON.parse(options.body)]); return { json: async () => deleteReply }; },
  });
  vm.runInContext(app.match(/function removeStaleRecordsForChat\(chatId, silent\) \{[\s\S]*?\n\}/)[0], context);
  return { context, calls, run: (silent = false) => { vm.runInContext(`removeStaleRecordsForChat('THREAD', ${silent})`, context); return new Promise((resolve) => setTimeout(resolve, 5)); } };
}

test('Unknown removes the leftover Lark row of this chat even though the card does not remember it', async () => {
  const h = leftoverHarness({ staleRecords: [{ recordId: 'rec-1', threadId: 'THREAD' }, { recordId: 'rec-2', threadId: 'OTHER' }] });
  await h.run();
  assert.deepEqual(h.calls.fetched, [['/lark-stale-records', { agentName: '96 Mexha', deleteRecordId: 'rec-1' }]], 'only this chat\'s row, as this agent');
  assert.deepEqual(h.calls.remembered, ['rec-1']);
  assert.deepEqual(vm.runInContext('staleRecords.map((r) => r.recordId)', h.context), ['rec-2'], 'it leaves Needs Attention');
  assert.equal(h.calls.status.at(-1)[1], 'success');
});

test('the chat is also found by the link of a chat opened from the archive', async () => {
  const h = leftoverHarness({ staleRecords: [{ recordId: 'rec-9', threadId: 'ARCH' }], chatUrl: 'https://my.livechatinc.com/archives/ARCH' });
  await h.run();
  assert.deepEqual(h.calls.fetched.map((c) => c[1].deleteRecordId), ['rec-9']);
});

test('nothing is removed when a bonus is claimed, in the preview, with no agent, or for the card\'s own row; a refusal is taken back', async () => {
  const rows = [{ recordId: 'rec-1', threadId: 'THREAD' }];
  for (const options of [{ claimed: { topPnl: true } }, { previewMode: true }, { selectedAgent: '' }, { caRecordId: 'rec-1' }]) {
    const h = leftoverHarness({ staleRecords: [...rows], ...options });
    await h.run();
    assert.equal(h.calls.fetched.length, 0, JSON.stringify(options));
  }
  const refused = leftoverHarness({ staleRecords: [...rows], deleteReply: { ok: false, error: 'This record has already been filled in — not removed.' } });
  await refused.run();
  assert.deepEqual(refused.calls.forgotten, ['rec-1'], 'a failed delete can be retried');
  assert.equal(vm.runInContext('staleRecords.length', refused.context), 1, 'and the row stays listed');
});

test('setUnknown calls it for every tick', () => {
  assert.match(app, /if \(value\) removeStaleRecordsForChat\(chatId, silent\);/);
});
