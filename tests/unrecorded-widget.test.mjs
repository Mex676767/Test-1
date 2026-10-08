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
    JSON, Boolean, Set, AGENT_LOGIN_LIVE: flag, currentLiveChatAccount: account, state: live, liveWidget: null, activeChats: [],
    liveChatAgentTokens: () => tokens, loadPersistedState: () => persisted,
    renderNeedsAttentionPanel: () => rendered.push(vm.runInContext('unrecordedChats.length', context)), logDiagnostic: (t, k) => logs.push([k, t]),
    fetch: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { json: async () => replies.shift() || { ok: true } }; },
  });
  vm.runInContext(['let unrecordedChats = [];', 'let unrecordedLoaded = false;', 'const unrecordedResolving = new Set();', fn('reopenArchivedFromList'), fn('postUnrecorded'), fn('fetchUnrecordedChats'), fn('resolveUnrecorded'), fn('ignoreAllUnrecorded'), fn('getUnrecordedChats')].join(NEWLINE), context);
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
  assert.match(w.logs.at(-1)[1], /Could not read your LiveChat email/);
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

test('Ignore all clears the list at once and tells Lark in rounds until none remain; asking is required; a failure is logged', async () => {
  const w = widget({ replies: [{ ok: true, chats }, { ok: true, updated: 50, remaining: 50 }, { ok: true, updated: 50, remaining: 0 }] });
  await w.run('fetchUnrecordedChats()');
  w.run('var confirmAnswer = true; var confirm = () => confirmAnswer;');
  await w.run('ignoreAllUnrecorded()');
  assert.equal(w.list(), '');
  assert.deepEqual(w.posts.filter((p) => p.body.action === 'resolveAll').length, 2);
  assert.match(w.logs.at(-1)[1], /Ignored 2 unrecorded chats/);
  const declined = widget({ replies: [{ ok: true, chats }] });
  await declined.run('fetchUnrecordedChats()');
  declined.run('var confirm = () => false;');
  await declined.run('ignoreAllUnrecorded()');
  assert.equal(declined.list(), 'T1,T2', 'nothing happens unless the agent confirms');
  const failing = widget({ replies: [{ ok: true, chats }, { ok: false, error: 'boom' }] });
  await failing.run('fetchUnrecordedChats()');
  failing.run('var confirm = () => true;');
  await failing.run('ignoreAllUnrecorded()');
  assert.match(failing.logs.at(-1)[1], /Couldn't write off the whole list: boom/);
});

test('the panel offers Ignore all when there is more than one chat, and the click is wired', () => {
  const panel = app.slice(app.indexOf('function renderNeedsAttentionPanel'), app.indexOf('document.getElementById("needsAttentionList").addEventListener'));
  assert.match(panel, /unrecorded\.length > 1/);
  assert.match(panel, /data-action="ignoreAllUnrecorded"/);
  assert.match(app, /button\[data-action='ignoreAllUnrecorded'\]/);
});

test('the list says in the activity log how many chats it got, and ⟳ reads it again (it was read only at start before)', async () => {
  const w = widget({ replies: [{ ok: true, chats }, { ok: true, chats: [...chats, { threadId: 'T3', date: 3 }] }] });
  await w.run('fetchUnrecordedChats()');
  assert.match(w.logs.at(-1)[1], /Unrecorded-chats list: 2 from the crosscheck/);
  await w.run('fetchUnrecordedChats()');
  assert.equal(w.list(), 'T1,T2,T3', 'a list written after the widget started shows up on the next read');
  const refresh = app.slice(app.indexOf('function handleRefreshClick'), app.indexOf('document.getElementById("refreshBtn")'));
  const deploy = refresh.indexOf('reloadForDeploymentUpdate');
  assert.ok(refresh.indexOf('fetchUnrecordedChats();') > deploy, 'after the update branch returns, so an update still just reloads');
});

// ---- opening an archived chat from the unrecorded list gives a fresh card --------------------------
function archivedHarness({ restored = false, entries = [{ threadId: 'T1', chatId: 'CH1', customer: 'Zimito', date: 1 }], source = 'archives', profileName = 'Zimito' } = {}) {
  const calls = { shown: [], brand: [], status: [], saved: 0, ensured: [], restoreAsked: [], logs: [] };
  const st = {};
  const context = vm.createContext({
    String, Promise, state: st, unrecordedChats: entries, activeChats: [], archiveOpening: '', logDiagnostic: (t) => calls.logs.push(t),
    findTrackedChatByThread: () => '', stopChatStatusPolling() {}, renderChats() {}, setStatus: (t) => calls.status.push(t),
    chatFromProfile: () => ({ chatId: 'LIVE' }), announceChatSwitch() {}, refreshBackgroundLookupPill() {}, bgLookupDone: null,
    ensureChatState: (chat) => { calls.ensured.push(chat); st[chat.chatId] = { chatOpen: true, chatUrl: '' }; },
    saveState: () => { calls.saved += 1; },
    resolveBrandFromGroupId: (id, group) => calls.brand.push([id, group]),
    showTrackedArchivedChat: (id) => calls.shown.push(id),
    restoreCardFromLark: async (id) => { calls.restoreAsked.push(id); if (restored) st[id] = { chatOpen: false }; return restored; },
  });
  vm.runInContext(['let unrecordedChats = ' + JSON.stringify(entries) + ';', 'let unrecordedLoaded = true;', 'let archiveOpening = "";', fn('openFreshArchivedCard'), fn('applyProfile')].join(NEWLINE), context);
  const profile = { source, name: profileName, chat: { id: 'T1', groupID: '7' } };
  return { calls, st, context, open: async () => { vm.runInContext('applyProfile(' + JSON.stringify(profile) + ')', context); await new Promise((r) => setImmediate(r)); } };
}

test('an archived chat from the unrecorded list, with no saved card and no Lark row, gets a fresh closed card', async () => {
  const h = archivedHarness();
  await h.open();
  assert.deepEqual(h.calls.restoreAsked, ['T1'], 'Lark is asked first, as before');
  assert.equal(h.st.T1.chatOpen, false);
  assert.equal(h.st.T1.chatUrl, 'https://my.livechatinc.com/chats/CH1/T1');
  assert.equal(h.st.T1.agentName, undefined, 'nothing is stamped on it until the agent records');
  assert.equal(JSON.stringify(h.calls.ensured[0]), JSON.stringify({ chatId: 'T1', customerName: 'Zimito', link: '', isTelegram: false, groupName: '' }));
  assert.deepEqual(h.calls.brand, [['T1', '7']], 'the brand is looked for from the chat\'s group');
  assert.deepEqual(h.calls.shown, ['T1']);
  assert.match(h.calls.status.at(-1), /unrecorded list/);
  assert.ok(h.calls.saved >= 1);
});

test('a card Lark could restore is shown as before, and an archived chat that is not on the list still shows nothing', async () => {
  const restored = archivedHarness({ restored: true });
  await restored.open();
  assert.deepEqual(restored.calls.shown, ['T1']);
  assert.deepEqual(restored.calls.ensured, [], 'no fresh card when there was a real one');
  const notListed = archivedHarness({ entries: [{ threadId: 'OTHER', chatId: 'C' }] });
  await notListed.open();
  assert.deepEqual(notListed.calls.shown, []);
  assert.match(notListed.calls.status.at(-1), /only tracks live chats/);
});

test('leaving the archived chat before Lark answers does not open its card afterwards', async () => {
  const h = archivedHarness();
  vm.runInContext('applyProfile(' + JSON.stringify({ source: 'archives', name: 'Z', chat: { id: 'T1' } }) + ')', h.context);
  vm.runInContext('applyProfile(null)', h.context);   // the agent moved on at once
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls.shown, []);
  assert.deepEqual(h.calls.ensured, []);
});

test('once its fresh card is flagged incomplete here, the same chat is not listed a second time', async () => {
  const w = widget({ replies: [{ ok: true, chats }], live: { T1: { chatOpen: false, logged: false, autoRecordError: 'missing: inquiry', agentName: 'Me' } } });
  w.run("var selectedAgent = 'Me';");
  await w.run('fetchUnrecordedChats()');
  assert.equal(w.shown(), 'T2');
});

// ---- the archived chat arrives before the list (Open ↗ opens a new tab) ---------------------------
test('an archived chat that arrived before the list was read gets its card as soon as the list arrives', () => {
  const opened = [];
  const profile = { source: 'archives', chat: { id: 'T1' } };
  const context = vm.createContext({
    String, activeChats: [], liveWidget: { getCustomerProfile: () => profile },
    applyProfile: (p) => opened.push(p.chat.id),
  });
  vm.runInContext(['let unrecordedChats = [];', fn('reopenArchivedFromList')].join(NEWLINE), context);
  vm.runInContext('reopenArchivedFromList()', context);
  assert.deepEqual(opened, [], 'not on the list (yet): nothing');
  vm.runInContext("unrecordedChats = [{ threadId: 'T1' }];", context);
  vm.runInContext('reopenArchivedFromList()', context);
  assert.deepEqual(opened, ['T1']);
  context.activeChats = [{ chatId: 'T1' }];
  vm.runInContext('reopenArchivedFromList()', context);
  assert.deepEqual(opened, ['T1'], 'its card is already showing: not opened again');
  profile.source = 'chats';
  context.activeChats = [];
  vm.runInContext('reopenArchivedFromList()', context);
  assert.deepEqual(opened, ['T1'], 'a live chat is left alone');
});

test('reading the list re-checks the open archived chat, and the log says why a chat has no card', () => {
  const read = app.slice(app.indexOf('async function fetchUnrecordedChats'), app.indexOf('// Marks one chat Done'));
  assert.match(read, /unrecordedLoaded = true;\s*\n\s*reopenArchivedFromList\(\);/);
  assert.match(app, /not on your unrecorded list, so no card is made for it/);
  assert.match(app, /your unrecorded list is still loading/);
});

test('ticking Unknown on a chat that is on the list writes it off in Lark at once', () => {
  const setUnknownCode = app.slice(app.indexOf('function setUnknown'), app.indexOf('function setUnknown') + 900);
  assert.match(setUnknownCode, /if \(value && unrecordedChats\.some\(\(chat\) => chat\.threadId === chatId\)\) resolveUnrecorded\(chatId, "Ignored"\);/);
  assert.ok(setUnknownCode.indexOf('resolveUnrecorded') < setUnknownCode.indexOf('if (!s.isUnknown || !s.caRecordId) return;'), 'before the early return, so it also works when no row exists');
});

test('a fresh archived card ticked Unknown never shows in Needs Attention: the local list skips Unknown cards', () => {
  const incomplete = app.slice(app.indexOf('function getIncompleteChats'), app.indexOf('function getIncompleteChats') + 700);
  assert.match(incomplete, /!s\.isUnknown/);
  const gate = app.slice(app.indexOf('async function submitRecordOnce'), app.indexOf('async function submitRecordOnce') + 1200);
  assert.match(gate, /if \(s\.isUnknown\) \{\s*\n\s*s\.logged = true;\s*\n\s*s\.autoRecordError = "";/);
});
