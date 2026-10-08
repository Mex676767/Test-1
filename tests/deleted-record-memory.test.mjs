import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const constLine = (name) => app.match(new RegExp(`const ${name} = [^\\n]*;`))[0];

function storageFake() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function helpers(clock = { now: 1_000_000 }) {
  const context = vm.createContext({ JSON, Object, Number, localStorage: storageFake(), Date: { now: () => clock.now } });
  vm.runInContext([constLine('DELETED_RECORDS_KEY'), constLine('DELETED_RECORDS_TTL_MS'),
    fn('readDeletedRecords'), fn('rememberDeletedRecord'), fn('forgetDeletedRecord'), fn('isDeletedRecord')].join('\n'), context);
  const run = (code) => vm.runInContext(code, context);
  return { clock, run, context };
}

test('a record this browser deleted is remembered, can be forgotten, and expires after an hour', () => {
  const h = helpers();
  assert.equal(h.run("isDeletedRecord('rec1')"), false);
  h.run("rememberDeletedRecord('rec1')");
  assert.equal(h.run("isDeletedRecord('rec1')"), true);
  assert.equal(h.run("isDeletedRecord('rec2')"), false);
  h.run("forgetDeletedRecord('rec1')");
  assert.equal(h.run("isDeletedRecord('rec1')"), false, 'a failed delete is taken back');
  h.run("rememberDeletedRecord('rec1')");
  h.clock.now += 59 * 60_000;
  assert.equal(h.run("isDeletedRecord('rec1')"), true);
  h.clock.now += 2 * 60_000;
  assert.equal(h.run("isDeletedRecord('rec1')"), false, 'forgotten after an hour');
  assert.equal(h.run("isDeletedRecord('')"), false);
  h.run("rememberDeletedRecord('')");   // nothing to remember, must not throw
});

test('unreadable or blocked storage never breaks anything', () => {
  const context = vm.createContext({ JSON, Object, Number, Date, localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  vm.runInContext([constLine('DELETED_RECORDS_KEY'), constLine('DELETED_RECORDS_TTL_MS'), fn('readDeletedRecords'), fn('rememberDeletedRecord'), fn('forgetDeletedRecord'), fn('isDeletedRecord')].join('\n'), context);
  assert.equal(vm.runInContext("rememberDeletedRecord('r'); forgetDeletedRecord('r'); isDeletedRecord('r')", context), false);
});

// ---- restoring a card from Lark must ignore rows this browser just deleted ---------------------
function restoreHarness(records, deleted) {
  const st = {};
  const logs = [];
  const h = helpers();
  const context = h.context;
  Object.assign(context, {
    selectedAgent: 'Me', larkRestoreTried: new Set(), state: st, currentLiveChatAccount: 'lc1', previewMode: false, Promise, Boolean, String,
    fetch: async () => ({ json: async () => ({ ok: true, records }) }),
    logDiagnostic: (text) => logs.push(text),
    ensureChatState: (chat) => { st[chat.chatId] = { logs: [], inquiry: [], status: '' }; },
    caseFromLarkRow: (r) => ({ caRecordId: r.recordId, logged: true, inquiry: r.inquiry, status: r.status }),
    saveState() {}, renderChats() {}, renderNeedsAttentionPanel() {}, showChatToast() {}, activeChats: [],
  });
  vm.runInContext(fn('restoreCardFromLark'), context);
  for (const id of deleted) h.run(`rememberDeletedRecord('${id}')`);
  return { st, logs, restore: () => vm.runInContext("restoreCardFromLark('THREAD')", context) };
}
const row = (recordId, username) => ({ recordId, username, brand: 'EZ', inquiry: ['WD/DP problem'], status: 'Unsolved', link: '' });

test('a row Lark still returns right after it was deleted does not rebuild a "Logged" card', async () => {
  const h = restoreHarness([row('rec-ghost', '1694992')], ['rec-ghost']);
  assert.equal(await h.restore(), false);
  assert.deepEqual(h.st, {}, 'no card was created from the ghost');
});

test('only the deleted rows are ignored: a real row for the same chat still restores', async () => {
  const h = restoreHarness([row('rec-ghost', 'old'), row('rec-real', 'real-user')], ['rec-ghost']);
  assert.equal(await h.restore(), true);
  assert.equal(h.st.THREAD.caRecordId, 'rec-real');
  assert.equal(h.st.THREAD.username, 'real-user');
});

test('with nothing deleted a restore works exactly as before', async () => {
  const h = restoreHarness([row('rec-1', 'u1')], []);
  assert.equal(await h.restore(), true);
  assert.equal(h.st.THREAD.caRecordId, 'rec-1');
});

test('every place the widget deletes a record remembers it, and the stale list skips remembered rows', () => {
  const unknown = app.slice(app.indexOf('function setUnknown'), app.indexOf('const MERGED_SEARCH_BOXES'));
  assert.match(unknown, /rememberDeletedRecord\(staleRecordId\);\s*\n\s*fetch\("\/lark-delete-record"/);
  assert.match(unknown, /forgetDeletedRecord\(staleRecordId\)/, 'a failed delete is taken back');
  const editCase = app.slice(app.indexOf('async function editCaseFlow'), app.indexOf('function renderTickets'));
  assert.match(editCase, /rememberDeletedRecord\(s\.caRecordId\);\s*\n\s*fetch\("\/lark-delete-record"/);
  const remove = app.slice(app.indexOf('async function removeStaleRecord'), app.indexOf('function ignoreAttention'));
  assert.match(remove, /rememberDeletedRecord\(recordId\)/);
  assert.match(app, /rememberDeletedRecord\(previousRecordId\)/, 'a repeat Look up replaces the previous row');
  const stale = app.slice(app.indexOf('function getStaleLarkRecords'), app.indexOf('async function removeStaleRecord'));
  assert.match(stale, /deletedRecordAgeMs\(r\.recordId\) < DELETED_RECORD_HIDE_MS/);
});

const NEWLINE = String.fromCharCode(10);
// ---- the Lark-side list: Lark says "no Inquiry/Status", so it shows unless a real reason hides it ------
function staleList({ stale, local = {}, deletedAgoMs = null }) {
  const clock = { now: 10_000_000 };
  const context = vm.createContext({
    JSON, Object, Number, Boolean, Map, Set, Date: { now: () => clock.now }, localStorage: storageFake(),
    IS_EMBEDDED_APP: false, currentLiveChatAccount: '', staleRecords: stale, state: {},
    loadPersistedState: () => ({ c1: local }), getIncompleteChats: () => [],
  });
  vm.runInContext([constLine('DELETED_RECORDS_KEY'), constLine('DELETED_RECORDS_TTL_MS'), constLine('DELETED_RECORD_HIDE_MS'),
    fn('readDeletedRecords'), fn('rememberDeletedRecord'), fn('deletedRecordAgeMs'), fn('getStaleLarkRecords')].join(NEWLINE), context);
  if (deletedAgoMs !== null) { clock.now -= deletedAgoMs; vm.runInContext("rememberDeletedRecord('rec1')", context); clock.now += deletedAgoMs; }
  return vm.runInContext("getStaleLarkRecords().map((r) => r.recordId).join(',')", context);
}
const lark = [{ recordId: 'rec1', username: 'u', brand: 'EZ', createdAt: 1 }];

test('an incomplete Lark row shows when this browser knows nothing about it', () => {
  assert.equal(staleList({ stale: lark }), 'rec1');
});

test('an incomplete Lark row shows even when a card here is marked "logged" without inquiry and status (Unknown, ghost restore)', () => {
  assert.equal(staleList({ stale: lark, local: { caRecordId: 'rec1', logged: true, chatOpen: false, inquiry: [], status: '' } }), 'rec1');
  assert.equal(staleList({ stale: lark, local: { caRecordId: 'rec1', logged: false, chatOpen: false } }), 'rec1');
});

test('it stays hidden only for a real reason: completed here a moment ago, written off, or the chat is still open', () => {
  assert.equal(staleList({ stale: lark, local: { caRecordId: 'rec1', logged: true, chatOpen: false, inquiry: ['WD/DP problem'], status: 'Solved' } }), '');
  assert.equal(staleList({ stale: lark, local: { caRecordId: 'rec1', attentionIgnored: true, logged: true, chatOpen: false } }), '');
  assert.equal(staleList({ stale: lark, local: { caRecordId: 'rec1', chatOpen: true } }), '');
});

test('a row deleted here is hidden only for the few seconds Lark takes to forget it', () => {
  assert.equal(staleList({ stale: lark, deletedAgoMs: 60_000 }), '', 'a minute ago: Lark may still list it');
  assert.equal(staleList({ stale: lark, deletedAgoMs: 10 * 60_000 }), 'rec1', 'ten minutes ago it is still there, so it is real');
});
