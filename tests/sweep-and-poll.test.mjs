import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

// ---- exponential backoff ------------------------------------------------------------------
test('sweep retry delay doubles from 8 s and caps at 5 minutes', () => {
  const context = vm.createContext({ PENDING_SWEEP_MS: 8000, SWEEP_BACKOFF_CAP_MS: 300000 });
  vm.runInContext(fn('nextSweepDelay'), context);
  const delays = [1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => vm.runInContext(`nextSweepDelay(${n})`, context));
  assert.deepEqual(delays, [8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
});

// ---- one sweeper per account + agent --------------------------------------------------------
function tab(storage, clock, tabId, extra = {}) {
  const context = vm.createContext({
    PENDING_SWEEP_MS: 8000, SWEEP_TAB_ID: tabId, currentLiveChatAccount: 'lc1', selectedAgent: 'Agent A',
    Date: { now: () => clock.now }, JSON, localStorage: storage, ...extra,
  });
  vm.runInContext(fn('holdsSweepLease'), context);
  return () => vm.runInContext('holdsSweepLease()', context);
}
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; };

test('only one tab holds the sweep lease; another takes over after it expires', () => {
  const storage = makeStorage(), clock = { now: 1_000_000 };
  const tabA = tab(storage, clock, 'A'), tabB = tab(storage, clock, 'B');
  assert.equal(tabA(), true);
  assert.equal(tabB(), false, 'second tab skips while the first is alive');
  clock.now += 8000;
  assert.equal(tabA(), true, 'the holder renews every sweep');
  assert.equal(tabB(), false);
  clock.now += 8000 * 3 + 1;             // holder stopped sweeping (tab closed)
  assert.equal(tabB(), true, 'the other tab takes over once the lease lapses');
  assert.equal(tabA(), false);
});

test('leases are per LiveChat account, so LC1 and LC2 tabs each get a sweeper', () => {
  const storage = makeStorage(), clock = { now: 5_000_000 };
  const lc1 = tab(storage, clock, 'A', { currentLiveChatAccount: 'lc1' });
  const lc2 = tab(storage, clock, 'B', { currentLiveChatAccount: 'lc2' });
  assert.equal(lc1(), true);
  assert.equal(lc2(), true);
});

test('with unusable storage the sweep still runs (previous behaviour) instead of silently stopping', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(tab(broken, { now: 1 }, 'A')(), true);
});

// ---- sweep retries with backoff -------------------------------------------------------------
function sweepHarness({ succeedOnAttempt = Infinity } = {}) {
  const clock = { now: 10_000_000 };
  const st = {};
  const submits = [];
  const context = vm.createContext({
    PENDING_SWEEP_MS: 8000, SWEEP_BACKOFF_CAP_MS: 300000, Date: { now: () => clock.now }, JSON,
    activeChats: [], state: st, loggingPaused: false, currentLiveChatAccount: 'lc1', selectedAgent: 'Agent A',
    document: { hidden: false },
    // storage mirrors what submitRecord's saveState() writes: a recorded chat is persisted as logged
    loadPersistedState: () => ({ c1: { chatOpen: false, logged: !!st.c1?.logged, liveChatAccount: 'lc1', caOwner: 'Agent A', inquiry: [], status: '' } }),
    markStateSynced() {}, renderNeedsAttentionPanel() {}, checkChatStatus: async () => {},
    holdsSweepLease: () => true,
    submitRecord: async (chatId) => {
      submits.push(clock.now);
      if (submits.length >= succeedOnAttempt) st[chatId].logged = true;
      else st[chatId].autoRecordError = 'Lark is throttling';
    },
  });
  vm.runInContext([fn('nextSweepDelay'), fn('sweepSignature'), fn('sweepPendingChats')].join('\n'), context);
  return { clock, st, submits, context, sweep: () => vm.runInContext('sweepPendingChats()', context) };
}

test('a closed-but-unrecorded chat backs off instead of writing to Lark every 8 s forever', async () => {
  const h = sweepHarness();
  for (let tick = 0; tick < 75; tick++) { await h.sweep(); h.clock.now += 8000; }   // 10 minutes of 8 s ticks
  assert.ok(h.submits.length >= 6 && h.submits.length <= 12, `expected ~9 attempts in 10 min, saw ${h.submits.length}`);
  const gaps = h.submits.slice(1).map((t, i) => t - h.submits[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `gaps never shrink: ${gaps}`);
  assert.ok(gaps.at(-1) <= 300000 + 8000, 'capped near 5 minutes');
});

test('editing the card (new signature) retries immediately instead of waiting out the backoff', async () => {
  const h = sweepHarness();
  await h.sweep(); h.clock.now += 8000;
  await h.sweep(); h.clock.now += 8000;            // second failure: next retry far away
  const before = h.submits.length;
  await h.sweep();                                  // still backing off
  assert.equal(h.submits.length, before);
  h.st.c1.inquiry = ['Deposit']; h.st.c1.status = 'Solved';   // the agent fixes the missing fields
  await h.sweep();
  assert.equal(h.submits.length, before + 1, 'retried at once');
});

test('a successful record clears the backoff and stops retrying', async () => {
  const h = sweepHarness({ succeedOnAttempt: 3 });
  for (let tick = 0; tick < 40; tick++) { await h.sweep(); h.clock.now += 8000; }
  assert.equal(h.submits.length, 3);
  assert.equal(h.st.c1.sweepRetry, undefined);
});

test('the focused chat is skipped while the widget is visible, but swept while it is hidden', async () => {
  const h = sweepHarness();
  h.context.activeChats = [{ chatId: 'c1' }];
  await h.sweep();
  assert.equal(h.submits.length, 0, 'visible: its own tight poll covers it');
  h.context.document.hidden = true;
  await h.sweep();
  assert.equal(h.submits.length, 1, 'hidden: the sweep covers it so background auto-record keeps working');
});

// ---- chat-status poll pauses while hidden ---------------------------------------------------
test('the 2 s chat-status tick is skipped while the widget is hidden and runs once when it becomes visible', () => {
  const checks = [];
  let interval;
  const st = { c1: { chatOpen: true, logged: false } };
  const context = vm.createContext({
    state: st, document: { hidden: true }, CHAT_STATUS_POLL_MS: 2000, chatStatusPollTimer: null,
    checkChatStatus: (id) => checks.push(id), setInterval: (f) => { interval = f; return 1; }, clearInterval() {},
  });
  vm.runInContext(['let chatStatusPollTick = null;', fn('stopChatStatusPolling'), fn('startChatStatusPolling')].join('\n'), context);
  vm.runInContext("startChatStatusPolling('c1')", context);
  interval(); interval();
  assert.equal(checks.length, 0, 'no calls while hidden');
  context.document.hidden = false;
  vm.runInContext('chatStatusPollTick()', context);   // what the visibilitychange handler calls
  assert.equal(checks.length, 1, 'one immediate check on becoming visible');
  interval();
  assert.equal(checks.length, 2, 'normal 2 s ticks resume');
});

// ---- case-row failure is a warning, not a failed lookup -----------------------------------------
test('fetchBonusRow passes caseRowError through, so the widget shows results plus a warning', async () => {
  const body = { ok: true, row: { vipBooster: 'Eligible' }, otherBrands: [], lookupWarnings: [], caRecordId: null, justCreated: false,
    caseRowError: 'Case row not saved — press Look Up again (the results below are still valid).' };
  const context = vm.createContext({
    previewMode: false, JSON, Promise, waitBeforeLookupRetry: async () => {},
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
  });
  vm.runInContext(fn('fetchBonusRow'), context);
  const result = await vm.runInContext("fetchBonusRow('p1','PP','https://my.livechatinc.com/chats/A/B',false,'Agent A',null,undefined)", context);
  assert.equal(result.row.vipBooster, 'Eligible');
  assert.equal(result.caRecordId, null);
  assert.match(result.caseRowError, /Look Up again/);
  // and the lookup handler surfaces it as a status line instead of throwing
  assert.match(app, /if \(caseRowError\) \{\s*setStatus\(/);
});

// ---- saveLinkToRecord (called from the 2 s chat-status tick) backs off ----------------------------
function linkSaveHarness({ fail }) {
  const clock = { now: 20_000_000 };
  const s = { caRecordId: 'rec1', chatUrl: 'https://my.livechatinc.com/chats/A/B', caLinkSaved: false, logged: false };
  const calls = [], logs = [];
  const context = vm.createContext({
    PENDING_SWEEP_MS: 8000, SWEEP_BACKOFF_CAP_MS: 300000, Date: { now: () => clock.now }, JSON, Math, Set,
    state: { c1: s }, linkSaveInFlight: new Set(), selectedAgent: 'Agent A', ownsCaseRecord: () => true,
    logDiagnostic: (m) => logs.push(m),
    fetch: async () => { calls.push(clock.now); return { json: async () => (fail() ? { ok: false, error: 'throttled' } : { ok: true }) }; },
  });
  vm.runInContext([fn('nextSweepDelay'), fn('saveLinkToRecord')].join('\n'), context);
  return { clock, s, calls, logs, tick: () => vm.runInContext("saveLinkToRecord('c1')", context) };
}

test('a failing link save is retried with exponential backoff, not on every 2 s tick', async () => {
  const h = linkSaveHarness({ fail: () => true });
  for (let t = 0; t < 150; t++) { await h.tick(); h.clock.now += 2000; }   // 5 minutes of 2 s ticks
  assert.ok(h.calls.length >= 5 && h.calls.length <= 9, `expected ~7 attempts in 5 min, saw ${h.calls.length}`);
  assert.equal(h.logs.length, h.calls.length, 'one diagnostic per attempt, not one per tick');
  const gaps = h.calls.slice(1).map((c, i) => c - h.calls[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `gaps never shrink: ${gaps}`);
});

test('a successful link save clears the backoff and stops calling', async () => {
  let failing = true;
  const h = linkSaveHarness({ fail: () => failing });
  await h.tick(); h.clock.now += 8000; failing = false;
  await h.tick();
  assert.equal(h.s.caLinkSaved, true);
  assert.equal(h.s.linkSaveRetry, undefined);
  const calls = h.calls.length;
  await h.tick(); await h.tick();
  assert.equal(h.calls.length, calls, 'saved: no further calls');
});

test('a different record or link retries immediately despite a pending backoff', async () => {
  const h = linkSaveHarness({ fail: () => true });
  await h.tick();                                   // fails, backs off
  await h.tick();
  assert.equal(h.calls.length, 1, 'still backing off for the same record+link');
  h.s.chatUrl = 'https://my.livechatinc.com/chats/A/NEWTHREAD';
  await h.tick();
  assert.equal(h.calls.length, 2, 'new link: tried right away');
  h.s.caRecordId = 'rec2';
  await h.tick();
  assert.equal(h.calls.length, 3, 'new record: tried right away');
});

// ---- saveState early exit --------------------------------------------------------------------------
function saveHarness() {
  const clock = { now: 30_000_000 };
  const store = new Map();
  const counts = { get: 0, set: 0 };
  const localStorage = {
    getItem: (k) => { counts.get++; return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { counts.set++; store.set(k, String(v)); },
  };
  const state = { c1: { username: 'a', brand: 'PP', inquiry: [], logged: false }, c2: { username: 'b', brand: 'MY', inquiry: [], logged: false } };
  const context = vm.createContext({
    state, localStorage, JSON, Date: { now: () => clock.now }, Object, STATE_STORAGE_KEY: 'rc-chat-state', STATE_MAX_AGE_MS: 7 * 86400000,
    lastSyncedJson: new Map(), knownBrandFor: new Map(), renderNeedsAttentionPanel() {},
  });
  vm.runInContext([fn('stateSnapshot'), fn('markStateSynced'), fn('keepBrand'), fn('hasLocalStateChanges'), fn('saveState')].join('\n')
    .replace(/^/, 'let storageDirty = true; let lastFullStateSyncAt = 0; const FULL_STATE_SYNC_MS = 60000;\n'), context);
  return { clock, store, counts, state, context, save: () => vm.runInContext('saveState()', context) };
}

test('saveState touches localStorage only when something changed, another tab wrote, or a minute passed', () => {
  const h = saveHarness();
  h.save();                                            // first call: full sync, writes both chats
  assert.equal(h.counts.set, 1);
  const stored = JSON.parse(h.store.get('rc-chat-state'));
  assert.deepEqual(Object.keys(stored).sort(), ['c1', 'c2']);

  const getsAfterSync = h.counts.get, setsAfterSync = h.counts.set;
  for (let i = 0; i < 20; i++) { h.clock.now += 3000; h.save(); }          // 1 minute of idle 3 s calls... minus the safety net
  const idleReads = h.counts.get - getsAfterSync;
  assert.ok(idleReads <= 2, `idle calls must not read storage every time (read ${idleReads}x in 60 s)`);
  assert.equal(h.counts.set, setsAfterSync, 'nothing changed: nothing written');

  h.state.c1.username = 'edited';                      // a real local change is saved straight away
  const before = h.counts.set;
  h.save();
  assert.equal(h.counts.set, before + 1);
  assert.equal(JSON.parse(h.store.get('rc-chat-state')).c1.username, 'edited');
});

test('a storage event from another tab forces the next save to read and adopt its newer copy', () => {
  const h = saveHarness();
  h.save();
  const raw = JSON.parse(h.store.get('rc-chat-state'));
  raw.c2 = { ...raw.c2, username: 'changed-by-other-tab', _savedAt: h.clock.now + 1 };
  h.store.set('rc-chat-state', JSON.stringify(raw));   // another tab wrote
  h.clock.now += 3000;
  h.save();
  assert.equal(h.state.c2.username, 'b', 'without the storage event the idle tab does not read (cheap path)');
  vm.runInContext('storageDirty = true', h.context);   // what the window "storage" listener now sets
  h.save();
  assert.equal(h.state.c2.username, 'changed-by-other-tab', 'adopted once the event says another tab wrote');
});

test('the 60 s safety net still reads storage even if no storage event arrived', () => {
  const h = saveHarness();
  h.save();
  const raw = JSON.parse(h.store.get('rc-chat-state'));
  raw.c2 = { ...raw.c2, username: 'missed-event', _savedAt: h.clock.now + 1 };
  h.store.set('rc-chat-state', JSON.stringify(raw));
  h.clock.now += 61_000;
  h.save();
  assert.equal(h.state.c2.username, 'missed-event');
});

test('the storage listener marks storage dirty before saving', () => {
  assert.match(app, /if \(e\.key !== STATE_STORAGE_KEY\) return;\s*storageDirty = true;[^\n]*\s*saveState\(\);/);
});

// ---- update reload is only allowed when the widget is genuinely idle ------------------------------------
function refreshGuard(over = {}) {
  const NL = String.fromCharCode(10);
  const start = app.indexOf('window.canRefreshForDeployment = () => {');
  const block = app.slice(start, app.indexOf(NL + '};', start) + 3);
  const keys = over.sessionKeys || [];
  const context = vm.createContext({
    window: {}, blastRunInProgress: false, state: {}, recordSubmitInFlight: new Map(), linkSaveInFlight: new Set(),
    ticketCreateInFlight: new Set(), claimWriteInFlight: new Set(), ticketAttachmentsByChat: new Map(),
    sessionStorage: { length: keys.length, key: (i) => keys[i] }, document: { activeElement: null },
    Object, String, ...over.context,
  });
  vm.runInContext(block, context);
  return { ok: () => context.window.canRefreshForDeployment(), context };
}

test('automatic update reload: allowed only when nothing is in flight, queued, unsent, or being typed', () => {
  assert.equal(refreshGuard().ok(), true, 'idle widget');
  assert.equal(refreshGuard({ context: { blastRunInProgress: true } }).ok(), false, 'Blast running');
  assert.equal(refreshGuard({ context: { state: { c1: { lookupInFlight: true } } } }).ok(), false, 'lookup in flight');
  assert.equal(refreshGuard({ context: { state: { c1: { unclaimInFlight: true } } } }).ok(), false, 'unclaim in flight');
  assert.equal(refreshGuard({ sessionKeys: ['ca-livechat-engagement:queue:lc1'] }).ok(), false, 'Blast queue saved for recovery');
  assert.equal(refreshGuard({ sessionKeys: ['ca-livechat-engagement:queue-images:lc1', 'other'] }).ok(), true, 'an image store alone is not a queue');
  assert.equal(refreshGuard({ context: { document: { activeElement: { tagName: 'INPUT' } } } }).ok(), false, 'cursor in a field');
  assert.equal(refreshGuard({ context: { document: { activeElement: { tagName: 'BUTTON' } } } }).ok(), true, 'a focused button is fine');
});

test('automatic update reload waits for Lark writes still in progress and for an unsent typed username', () => {
  assert.equal(refreshGuard({ context: { recordSubmitInFlight: new Map([['c1', Promise.resolve()]]) } }).ok(), false, 'recording a chat');
  assert.equal(refreshGuard({ context: { linkSaveInFlight: new Set(['c1']) } }).ok(), false, 'saving a chat link');
  assert.equal(refreshGuard({ context: { state: { c1: { logged: false, usernameDraft: 'player99' } } } }).ok(), false, 'typed, not yet looked up');
  assert.equal(refreshGuard({ context: { state: { c1: { logged: true, usernameDraft: 'old' } } } }).ok(), true, 'a recorded chat does not block');
  assert.equal(refreshGuard({ context: { state: { c1: { logged: false, usernameDraft: '   ' } } } }).ok(), true, 'blank draft');
});

test('the app saves its state right before an update reload', () => {
  const NL = String.fromCharCode(10);
  const start = app.indexOf('window.prepareForDeploymentRefresh = () => {');
  const block = app.slice(start, app.indexOf(NL, start));
  let saved = 0;
  const context = vm.createContext({ window: {}, saveState: () => { saved += 1; } });
  vm.runInContext(block, context);
  context.window.prepareForDeploymentRefresh();
  assert.equal(saved, 1);
  context.saveState = () => { throw new Error('storage blocked'); };
  assert.doesNotThrow(() => context.window.prepareForDeploymentRefresh(), 'a save hiccup never blocks the reload');
});

// ---- more blockers: ticket create, claim write, unsent attachments, unsent ticket form -----------------------
test('update is also refused while a ticket is being created, a claim is being written, attachments are unsent, or a ticket form has typed input', () => {
  assert.equal(refreshGuard({ context: { ticketCreateInFlight: new Set(['c1']) } }).ok(), false, 'ticket create in flight');
  assert.equal(refreshGuard({ context: { claimWriteInFlight: new Set(['c1']) } }).ok(), false, 'bonus claim in flight');
  assert.equal(refreshGuard({ context: { ticketAttachmentsByChat: new Map([['c1', [{ name: 'receipt.png' }]]]) } }).ok(), false, 'files chosen but not sent (memory only)');
  assert.equal(refreshGuard({ context: { ticketAttachmentsByChat: new Map([['c1', []]]) } }).ok(), true, 'an emptied attachment list is fine');
  for (const field of ['queries', 'transactionId', 'paymentGateway', 'remarks']) {
    assert.equal(refreshGuard({ context: { state: { c1: { escalationSubmitted: false, escalation: { [field]: 'typed text' } } } } }).ok(), false, 'unsent ticket form: ' + field);
  }
  assert.equal(refreshGuard({ context: { state: { c1: { escalationSubmitted: true, escalation: { queries: 'Deposit' } } } } }).ok(), true, 'a raised ticket does not block');
  assert.equal(refreshGuard({ context: { state: { c1: { escalationSubmitted: false, escalation: { memberUserId: 'auto', brand: 'PP', amount: '18', queries: '   ' } } } } }).ok(), true, 'auto-filled fields and blanks do not block');
});

test('the in-flight sets are added before the request and removed in a finally (so a failure cannot leave a stuck blocker)', () => {
  assert.match(app, /ticketCreateInFlight\.add\(chatId\);\s*try \{/);
  assert.match(app, /\} finally \{\s*ticketCreateInFlight\.delete\(chatId\);\s*\}/);
  assert.match(app, /claimWriteInFlight\.add\(chatId\);\s*try \{/);
  assert.match(app, /\} finally \{\s*claimWriteInFlight\.delete\(chatId\);\s*\}/);
});

// ---- the refresh button ---------------------------------------------------------------------------------------
function refreshButton(over = {}) {
  const NL = String.fromCharCode(10);
  const fnStart = app.indexOf('function handleRefreshClick() {');
  const handler = app.slice(fnStart, app.indexOf(NL + '}', fnStart) + 2);
  const guardStart = app.indexOf('window.canRefreshForDeployment = () => {');
  const guard = app.slice(guardStart, app.indexOf(NL + '};', guardStart) + 3);
  const log = { toasts: [], reloads: 0, prepared: 0, dropdown: [], renders: 0 };
  const win = { deploymentUpdatePending: () => !!over.pending, prepareForDeploymentRefresh: () => { log.prepared += 1; },
    reloadForDeploymentUpdate: () => { log.reloads += 1; return over.reloadResult || 'reloaded'; } };
  const context = vm.createContext({
    window: win, blastRunInProgress: false, state: {}, recordSubmitInFlight: new Map(), linkSaveInFlight: new Set(),
    ticketCreateInFlight: new Set(), claimWriteInFlight: new Set(), ticketAttachmentsByChat: new Map(),
    sessionStorage: { length: 0, key: () => null }, document: { activeElement: { tagName: 'BUTTON' } }, Object, String,
    showChatToast: (message, kind) => log.toasts.push([message, kind]),
    refreshDropdownOptions: (o) => log.dropdown.push(o),
    liveWidget: null, setStatus() {}, renderChats() { log.renders += 1; }, activeChats: [], applyProfile() {},
    ...over.context,
  });
  vm.runInContext(guard + NL + handler, context);
  return { log, context, click: () => vm.runInContext('handleRefreshClick()', context) };
}

test('refresh button with an update pending and the widget safe: saves state, reloads ONCE, and does nothing else', () => {
  const b = refreshButton({ pending: true });
  b.click();
  assert.equal(b.log.prepared, 1, 'state saved first');
  assert.equal(b.log.reloads, 1);
  assert.equal(b.log.dropdown.length, 0, 'the normal refresh is skipped: the page is reloading anyway');
  assert.equal(b.log.toasts.length, 0);
});

test('refresh button with an update pending but BUSY (each blocker): no reload, nothing saved, and a toast saying what to finish', () => {
  const blockers = {
    'lookup in flight': { state: { c1: { lookupInFlight: true } } },
    'unclaim in flight': { state: { c1: { unclaimInFlight: true } } },
    'record submit in flight': { recordSubmitInFlight: new Map([['c1', Promise.resolve()]]) },
    'link save in flight': { linkSaveInFlight: new Set(['c1']) },
    'ticket create in flight': { ticketCreateInFlight: new Set(['c1']) },
    'bonus claim in flight': { claimWriteInFlight: new Set(['c1']) },
    'unsent attachments': { ticketAttachmentsByChat: new Map([['c1', [{ name: 'a.png' }]]]) },
    'unsent ticket form': { state: { c1: { escalationSubmitted: false, escalation: { remarks: 'half typed' } } } },
    'typed username': { state: { c1: { logged: false, usernameDraft: 'player1' } } },
    'Blast running': { blastRunInProgress: true },
    'cursor in a field': { document: { activeElement: { tagName: 'TEXTAREA' } } },
  };
  for (const [name, context] of Object.entries(blockers)) {
    const b = refreshButton({ pending: true, context });
    b.click();
    assert.equal(b.log.reloads, 0, name + ': no reload');
    assert.equal(b.log.prepared, 0, name + ': nothing saved or reloaded');
    assert.deepEqual(b.log.toasts, [['Finish or cancel your current lookup / claim / ticket / Blast first, then click ⟳ again.', 'warn']], name + ': explained');
  }
});

test('refresh button whose update was already tried for this release in this tab explains instead of looping', () => {
  const b = refreshButton({ pending: true, reloadResult: 'already-tried' });
  b.click();
  assert.equal(b.log.toasts.length, 1);
  assert.match(b.log.toasts[0][0], /already tried/i);
});

test('refresh button with NO update pending behaves exactly as before (re-reads dropdowns, re-syncs, never reloads)', () => {
  const b = refreshButton({ pending: false });
  b.click();
  assert.equal(JSON.stringify(b.log.dropdown), JSON.stringify([{ fresh: true }]));
  assert.equal(b.log.reloads, 0);
  assert.equal(b.log.prepared, 0);
  assert.equal(b.log.toasts.length, 0);
  assert.equal(b.log.renders, 1, 'the preview-mode branch re-rendered the chats');
  // a busy widget with no update pending is not nagged either
  const busy = refreshButton({ pending: false, context: { state: { c1: { lookupInFlight: true } } } });
  busy.click();
  assert.equal(busy.log.toasts.length, 0);
  assert.equal(JSON.stringify(busy.log.dropdown), JSON.stringify([{ fresh: true }]));
});

test('the refresh listener is the named handler', () => {
  assert.match(app, /document\.getElementById\("refreshBtn"\)\.addEventListener\("click", handleRefreshClick\);/);
});
