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
