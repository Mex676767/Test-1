import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const NEWLINE = String.fromCharCode(10);

function widget({ flag = true, account = 'lc1', tokens = { lc1: 'tok' }, persisted = {}, live = {}, replies = [] } = {}) {
  const posts = [];
  const rendered = [];
  const logs = [];
  const context = vm.createContext({
    JSON, Boolean, Set, AGENT_LOGIN_LIVE: flag, currentLiveChatAccount: account, state: live,
    liveChatAgentTokens: () => tokens, loadPersistedState: () => persisted,
    renderNeedsAttentionPanel: () => rendered.push(vm.runInContext('unrecordedChats.length', context)), logDiagnostic: (t, k) => logs.push([k, t]),
    fetch: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { json: async () => replies.shift() || { ok: true } }; },
  });
  vm.runInContext(['let unrecordedChats = [];', 'const unrecordedResolving = new Set();', fn('postUnrecorded'), fn('fetchUnrecordedChats'), fn('resolveUnrecorded'), fn('getUnrecordedChats')].join(NEWLINE), context);
  return { posts, rendered, logs, list: () => vm.runInContext('unrecordedChats.map((c) => c.threadId).join(",")', context), shown: () => vm.runInContext('getUnrecordedChats().map((c) => c.threadId).join(",")', context), run: (code) => vm.runInContext(code, context) };
}
const chats = [{ threadId: 'T1', date: 1, customer: 'A' }, { threadId: 'T2', date: 2, customer: 'B' }];

test('the list is read once with the agent\'s own login and shown; nothing happens when the login is off or missing', async () => {
  const w = widget({ replies: [{ ok: true, chats }] });
  await w.run('fetchUnrecordedChats()');
  assert.deepEqual(w.posts, [{ url: '/livechat-unrecorded', body: { accountKey: 'lc1', agentToken: 'tok', action: 'list' } }]);
  assert.equal(w.list(), 'T1,T2');
  assert.deepEqual(w.rendered, [2]);
  const off = widget({ flag: false });
  await off.run('fetchUnrecordedChats()');
  const noLogin = widget({ tokens: {} });
  await noLogin.run('fetchUnrecordedChats()');
  assert.equal(off.posts.length + noLogin.posts.length, 0);
});

test('a failed read keeps the list as it was and says why in the log', async () => {
  const w = widget({ replies: [{ ok: true, chats }, { ok: false, error: 'Could not read your LiveChat email (x).' }] });
  await w.run('fetchUnrecordedChats()');
  await w.run('fetchUnrecordedChats()');
  assert.equal(w.list(), 'T1,T2');
  assert.match(w.logs[0][1], /Could not read your LiveChat email/);
});

test('Ignore takes the chat off the list at once and tells Lark once', async () => {
  const w = widget({ replies: [{ ok: true, chats }] });
  await w.run('fetchUnrecordedChats()');
  await w.run("resolveUnrecorded('T1', 'Ignored')");
  assert.equal(w.list(), 'T2');
  assert.deepEqual(w.posts.at(-1).body, { accountKey: 'lc1', agentToken: 'tok', action: 'resolve', threadId: 'T1', status: 'Ignored' });
});

test('a chat the agent has since recorded here (inquiry and status, logged) drops off the list and is marked Done once', async () => {
  const w = widget({ replies: [{ ok: true, chats }], live: { T1: { logged: true, inquiry: ['WD/DP problem'], status: 'Solved' } } });
  await w.run('fetchUnrecordedChats()');
  assert.equal(w.shown(), 'T2');
  assert.equal(w.shown(), 'T2');
  const resolves = w.posts.filter((p) => p.body.action === 'resolve');
  assert.deepEqual(resolves.map((p) => [p.body.threadId, p.body.status]), [['T1', 'Done']], 'told once, not on every redraw');
});

test('a card that is only "logged" without inquiry and status (Unknown, a ghost restore) does not count as recorded; an ignored card does hide it', async () => {
  const ghost = widget({ replies: [{ ok: true, chats }], persisted: { T1: { logged: true, inquiry: [], status: '' } } });
  await ghost.run('fetchUnrecordedChats()');
  assert.equal(ghost.shown(), 'T1,T2');
  const ignored = widget({ replies: [{ ok: true, chats }], persisted: { T1: { attentionIgnored: true } } });
  await ignored.run('fetchUnrecordedChats()');
  assert.equal(ignored.shown(), 'T2');
});

test('the panel counts and renders these chats with Open and Ignore, escaped, and the list is read after the sign-in', () => {
  const panel = app.slice(app.indexOf('function renderNeedsAttentionPanel'), app.indexOf('document.getElementById("needsAttentionList").addEventListener'));
  assert.match(panel, /const unrecorded = getUnrecordedChats\(\);/);
  assert.match(panel, /incomplete\.length \+ stale\.length \+ unrecorded\.length \+ previewCount/);
  assert.match(panel, /data-action="ignoreUnrecorded"/);
  assert.match(panel, /archiveUrlFor\(c\.threadId\)/);
  assert.match(panel, /escapeHtml\(c\.customer/);
  const bound = app.slice(app.indexOf('function applyBoundAgent'), app.indexOf('// First sign-in: pick the agent name once'));
  assert.match(bound, /fetchUnrecordedChats\(\);/);
  assert.match(app, /button\[data-action='ignoreUnrecorded'\]/);
});

test('a chat ticked "Unknown player" in this browser is written off in Lark and leaves the list', async () => {
  const w = widget({ replies: [{ ok: true, chats }], persisted: { T1: { isUnknown: true } } });
  await w.run('fetchUnrecordedChats()');
  assert.equal(w.shown(), 'T2');
  const resolves = w.posts.filter((p) => p.body.action === 'resolve');
  assert.deepEqual(resolves.map((p) => [p.body.threadId, p.body.status]), [['T1', 'Ignored']]);
});

test('only the newest 25 are listed, with a line saying how many older ones remain; the count in the header is the full number', () => {
  const panel = app.slice(app.indexOf('function renderNeedsAttentionPanel'), app.indexOf('document.getElementById("needsAttentionList").addEventListener'));
  assert.match(app, /const UNRECORDED_SHOWN_MAX = 25;/);
  assert.match(panel, /\.sort\(\(a, b\) => b\.date - a\.date\)\.slice\(0, UNRECORDED_SHOWN_MAX\)/);
  assert.match(panel, /unrecordedShown\.map\(/);
  assert.match(panel, /unrecorded\.length - unrecordedShown\.length\} older chats/);
  assert.match(panel, /incomplete\.length \+ stale\.length \+ unrecorded\.length \+ previewCount/);
});
