import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// A lookup keeps running when the agent switches chats: its messages belong to ITS chat, a pill and one neutral toast say it finished,
// and a widget that is recreated mid-lookup resumes it once. The real code from app.js runs here against fakes (no DOM, no network).
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = app.slice(app.indexOf('// ---- A lookup keeps running when the agent switches chats'), app.indexOf('function applyProfile(profile) {'));
const announce = app.match(/function announceChatSwitch\(prevChatId, nextChat\) \{[\s\S]*?\n\}/)[0];
assert.ok(block.includes('async function runLookup(') && block.includes('function resumePendingLookups('), 'found the lookup code in app.js');

const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ROW = { tier: '3' };
const okResult = (extra = {}) => ({ row: ROW, otherBrands: [], lookupWarnings: [], caRecordId: 'rec1', caseRowError: '', notVip: false, ...extra });

// One copy of the widget (an iframe). `persisted` plays localStorage's chat state; `storage` the other localStorage keys.
function widget({ persisted = {}, agent = 'Agent A', focus = null, storage, clock, fetchBonusRow, instance = 'copy' }) {
  const calls = { status: [], toast: [], diag: [], render: 0, fetch: [], timers: [] };
  const els = new Map();
  const state = JSON.parse(JSON.stringify(persisted));
  for (const s of Object.values(state)) { delete s.lookupInFlight; }
  const context = vm.createContext({
    state, activeChats: focus ? [{ chatId: focus, customerName: focus }] : [], selectedAgent: agent, previewMode: false,
    lookupControllers: new Map(), localStorage: storage, AbortController, JSON, Object, Array, Set, Map, Number, String, Promise, Math,
    Date: { now: () => clock.now },
    setStatus: (text, kind) => calls.status.push({ text, kind }),
    showChatToast: (text, kind) => calls.toast.push({ text, kind }),
    logDiagnostic: (text, kind) => calls.diag.push({ text, kind }),
    renderChats: () => { calls.render++; }, scheduleNeedsAttentionRefresh: () => {}, saveState: () => { const copy = JSON.parse(JSON.stringify(state)); for (const s of Object.values(copy)) { delete s.lookupInFlight; delete s.unclaimInFlight; } widgetSaved.set(instance, copy); },   // like persistableState()
    setUnknown: (chatId, value) => { state[chatId].isUnknown = value; },
    chatListEl: { querySelectorAll: () => [] }, renderPlayerInfo: () => '', renderTickets: () => '', renderAutoFields: () => '',
    escapeHtml: (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    fetchBonusRow: (...args) => { calls.fetch.push(args); return fetchBonusRow ? fetchBonusRow(...args) : Promise.resolve(okResult()); },
    document: { getElementById: (id) => els.get(id) || null, createElement: () => ({ dataset: {}, classList: { add() {} } }), body: { appendChild: (el) => els.set(el.id, el) } },
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; }, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  });
  vm.runInContext(`const LOOKUP_INSTANCE_ID_OVERRIDE = ${JSON.stringify(instance)};`, context);
  vm.runInContext(block.replace(/const LOOKUP_INSTANCE_ID = [^\n]*\n/, `const LOOKUP_INSTANCE_ID = ${JSON.stringify(instance)};\n`), context);
  vm.runInContext(announce, context);
  return { context, state, calls, els, run: (code) => vm.runInContext(code, context),
    focus: (chatId) => { context.activeChats = chatId ? [{ chatId, customerName: chatId }] : []; },
    pill: () => els.get('bgLookupPill') };
}
const widgetSaved = new Map();
const chat = (extra = {}) => ({ username: '', usernameDraft: '', brand: 'PP', lookupInFlight: false, chatUrl: 'https://my.livechatinc.com/chats/A/T1', ...extra });
const LOOKUP = (over = {}) => ({ username: 'alice', brand: 'PP', telegramNow: false, link: 'https://my.livechatinc.com/chats/A/T1', previousRecordId: null, forcing: false, ...over });
const start = (w, chatId, over) => { const p = w.context.runLookup(chatId, LOOKUP(over)); return p; };

test('look up in chat A, switch to B before it finishes: the result is saved in A, B is left alone, one neutral toast says it finished elsewhere', async () => {
  const clock = { now: 1_000_000 }, d = deferred();
  const w = widget({ persisted: { A: chat(), B: chat() }, focus: 'A', storage: makeStorage(), clock, fetchBonusRow: () => d.promise });
  const running = start(w, 'A');
  assert.equal(w.state.A.lookupInFlight, true);
  assert.equal(w.pill()?.textContent || '', '', 'no pill while its own chat is in front');
  // the agent switches to B (what applyProfile does: announce, then swap, then refresh the pill)
  w.run(`announceChatSwitch('A', { chatId: 'B', customerName: 'Bob' })`);
  w.focus('B'); w.run('refreshBackgroundLookupPill()');
  assert.deepEqual(w.calls.toast.map((t) => [t.kind, t.text]), [['info', 'Lookup for alice keeps running — results will be waiting when you come back.']], 'info, not a warning');
  assert.equal(w.pill().textContent, '1 lookup running in another chat');
  d.resolve(okResult());
  await running;
  assert.equal(w.state.A.caRecordId, 'rec1'); assert.deepEqual(w.state.A.matchedRow, ROW); assert.equal(w.state.A.lookupInFlight, false); assert.equal(w.state.A.pendingLookup, null);
  assert.equal(w.state.A.lookupMessage.text, 'Found alice under PP.');
  assert.deepEqual(w.calls.status, [], "B's status bar is untouched");
  assert.equal(w.state.B.lookupMessage, undefined, "nothing was written onto B");
  assert.deepEqual(w.calls.toast.slice(1).map((t) => [t.kind, t.text]), [['info', 'Lookup for alice finished (other chat)']], 'exactly one neutral toast');
  assert.equal(w.pill().textContent, '✓ Lookup for alice done'); assert.match(w.pill().className, /done/);
  // the "Found" line is only logged in Diagnostics; lookup messages are no longer drawn in the card
  assert.ok(w.calls.diag.some((x) => x.text.includes('Found alice under PP.')), 'Found line is in the diagnostics log');
  assert.doesNotMatch(app, /renderLookupMessage|lookup-message/, 'the card has no lookup message block');
});

test('the "done" pill goes away after ~10 s, and while another lookup is still running that one is shown instead', async () => {
  const clock = { now: 5_000_000 }, d1 = deferred(), d2 = deferred();
  let n = 0;
  const w = widget({ persisted: { A: chat(), B: chat(), C: chat() }, focus: 'C', storage: makeStorage(), clock, fetchBonusRow: () => (n++ ? d2.promise : d1.promise) });
  const a = start(w, 'A'), b = start(w, 'B', { username: 'bob' });
  w.run('refreshBackgroundLookupPill()');
  assert.equal(w.pill().textContent, '2 lookups running in other chats');
  d1.resolve(okResult()); await a;
  assert.equal(w.pill().textContent, '1 lookup running in another chat', 'a running lookup wins over the done message');
  d2.resolve(okResult()); await b;
  assert.match(w.pill().textContent, /^✓ Lookup for bob done$/);
  clock.now += 11_000; w.run('refreshBackgroundLookupPill()');
  assert.equal(w.pill().textContent, ''); assert.match(w.pill().className, /hidden/);
});

test("a lookup that fails or has warnings while another chat is focused: nothing about it in the focused chat's status bar, 'needs attention' wording", async () => {
  for (const [label, impl, expectText] of [
    ['failed', () => Promise.reject(new Error('Lark is down')), 'Lookup failed: Lark is down'],
    ['warnings', () => Promise.resolve(okResult({ lookupWarnings: ['Top 10 P&L'] })), 'Lookup completed with some checks unavailable: Top 10 P&L. Click Look up to retry.'],
    ['case row error', () => Promise.resolve(okResult({ caseRowError: 'Case row not saved — press Look Up again.' })), 'Case row not saved — press Look Up again.'],
  ]) {
    const w = widget({ persisted: { A: chat(), B: chat() }, focus: 'B', storage: makeStorage(), clock: { now: 9_000_000 }, fetchBonusRow: impl });
    await start(w, 'A');
    assert.deepEqual(w.calls.status, [], `${label}: B's status bar is untouched`);
    assert.equal(w.state.A.lookupMessage.text, expectText, label); assert.equal(w.state.A.lookupMessage.attention, true);
    assert.deepEqual(w.calls.toast.map((t) => [t.kind, t.text]), [['warn', '⚠ Lookup for alice needs attention (other chat)']], label);
    assert.equal(w.pill().textContent, '⚠ Lookup for alice needs a retry'); assert.match(w.pill().className, /attention/);
    assert.ok(w.calls.diag.some((x) => x.text.includes('(other chat)')), 'still in the diagnostics log');
  }
});

test("Not VVIP result for a chat that is not in front: stored on its card as an error, not shown on the focused chat, and not called 'needs attention'", async () => {
  const w = widget({ persisted: { A: chat(), B: chat() }, focus: 'B', storage: makeStorage(), clock: { now: 1 }, fetchBonusRow: () => Promise.resolve(okResult({ row: null, notVip: true })) });
  await start(w, 'A');
  assert.deepEqual(w.calls.status, []);
  assert.match(w.state.A.lookupMessage.text, /^Not VVIP — marked Unknown player\./); assert.equal(w.state.A.lookupMessage.kind, 'error'); assert.equal(w.state.A.lookupMessage.attention, false);
  assert.equal(w.state.A.isUnknown, true); assert.equal(w.state.B.isUnknown, undefined);
  assert.deepEqual(w.calls.toast.map((t) => [t.kind, t.text]), [['info', 'Lookup for alice finished (other chat)']]);
});

test('a lookup in the chat that IS in front behaves as before: toast + status bar text, and its own card message', async () => {
  const w = widget({ persisted: { A: chat() }, focus: 'A', storage: makeStorage(), clock: { now: 1 }, fetchBonusRow: () => Promise.resolve(okResult()) });
  await start(w, 'A');
  assert.deepEqual(w.calls.toast.map((t) => t.text), ['✓ Looked up "alice" — PP']);
  assert.deepEqual(w.calls.status, [{ text: 'Found alice under PP.', kind: undefined }]);
  assert.equal(w.state.A.lookupMessage.text, 'Found alice under PP.');
  assert.equal(w.pill().textContent, '', 'no pill for the focused chat');
  const failing = widget({ persisted: { A: chat() }, focus: 'A', storage: makeStorage(), clock: { now: 1 }, fetchBonusRow: () => Promise.reject(new Error('boom')) });
  await start(failing, 'A');
  assert.deepEqual(failing.calls.status, [{ text: 'Lookup failed: boom', kind: 'error' }]);
});

test('switch messages: a running lookup is information, a typed-but-not-looked-up username is still a loud warning', () => {
  const w = widget({ persisted: { A: chat({ usernameDraft: 'carol' }), B: chat(), C: chat({ lookupInFlight: true, username: 'dave' }) }, focus: 'A', storage: makeStorage(), clock: { now: 1 } });
  w.state.C.lookupInFlight = true;
  w.run(`announceChatSwitch('A', { chatId: 'B', customerName: 'Bob' })`);
  w.run(`announceChatSwitch('C', { chatId: 'B', customerName: 'Bob' })`);
  w.run(`announceChatSwitch('B', { chatId: 'A', customerName: 'Ann' })`);
  assert.deepEqual(w.calls.toast.map((t) => [t.kind, t.text]), [
    ['warn', '⚠ Switched chats before "carol" was submitted — now viewing Bob. Come back to the other chat to finish it.'],
    ['info', 'Lookup for dave keeps running — results will be waiting when you come back.'],
    ['info', 'Now viewing Ann'],
  ]);
});

// ---- widget reload mid-lookup -----------------------------------------------------------------------------------------------
async function reloadScenario({ ageMs, persistedPatch = (p) => p, agent = 'Agent A', reloadAgent = 'Agent A' }) {
  const clock = { now: 20_000_000 }, storage = makeStorage();
  const first = widget({ persisted: { A: chat({ caOwner: 'Agent A' }), B: chat() }, agent, focus: 'A', storage, clock, instance: 'copy1', fetchBonusRow: () => new Promise(() => {}) });
  void start(first, 'A');                                              // never answers: the iframe is torn down mid-request
  const persisted = persistedPatch(JSON.parse(JSON.stringify(widgetSaved.get('copy1'))));
  assert.equal(persisted.A.pendingLookup.username, 'alice', 'the running lookup was saved without secrets');
  assert.deepEqual(Object.keys(persisted.A.pendingLookup).sort(), ['agent', 'brand', 'forcing', 'link', 'previousRecordId', 'resumed', 'startedAt', 'telegram', 'username']);
  assert.ok(!persisted.A.lookupInFlight, 'the in-flight flag itself is never stored');
  clock.now += ageMs;
  return { clock, storage, persisted, reloadAgent };
}

test('widget recreated mid-lookup (< 40 s): the lookup is resumed ONCE, exactly one search call, and the result is shown', async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 12_000 });             // the old copy's lock (10 s) has lapsed by now
  const second = widget({ persisted, focus: 'A', storage, clock, instance: 'copy2', fetchBonusRow: () => Promise.resolve(okResult({ caRecordId: 'rec-resumed' })) });
  second.run('startLookupResume()');
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(second.calls.fetch.length, 1, 'one /lark-search call');
  assert.deepEqual(second.calls.fetch[0].slice(0, 6), ['alice', 'PP', 'https://my.livechatinc.com/chats/A/T1', false, 'Agent A', null], 'same inputs, same agent');
  assert.equal(second.state.A.caRecordId, 'rec-resumed');
  assert.equal(second.state.A.lookupMessage.text, 'Found alice under PP.'); assert.equal(second.state.A.pendingLookup, null);
  assert.ok(second.calls.render >= 1, 'the Cancel button is shown while it runs');
  // resuming again (e.g. another reload) does nothing: it already finished
  second.run('resumePendingLookups()');
  assert.equal(second.calls.fetch.length, 1);
});

test('a lookup that was already resumed once and died again is NOT resumed a second time: "interrupted"', async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 12_000, persistedPatch: (p) => { p.A.pendingLookup.resumed = true; return p; } });
  const third = widget({ persisted, focus: 'A', storage, clock, instance: 'copy3' });
  third.run('startLookupResume()');
  assert.equal(third.calls.fetch.length, 0);
  assert.equal(third.state.A.lookupMessage.text, 'Lookup was interrupted — click Look up.'); assert.equal(third.state.A.pendingLookup, null);
});

test('older than 40 s: not re-run, cleared, and the card says "Lookup was interrupted — click Look up."', async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 41_000 });
  const second = widget({ persisted, focus: 'A', storage, clock, instance: 'copy2' });
  second.run('startLookupResume()');
  assert.equal(second.calls.fetch.length, 0);
  assert.equal(second.state.A.pendingLookup, null);
  assert.equal(second.state.A.lookupMessage.text, 'Lookup was interrupted — click Look up.');
  assert.deepEqual(second.calls.status, [{ text: 'Lookup was interrupted — click Look up.', kind: 'info' }], 'shown in the status area only because chat A is in front');
});

test('two widget copies load at the same time: only one resumes the chat; the other waits and then finds it finished', async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 12_000 });
  const done = deferred();
  const tabX = widget({ persisted, focus: 'A', storage, clock, instance: 'tabX', fetchBonusRow: () => done.promise });
  const tabY = widget({ persisted, focus: 'A', storage, clock, instance: 'tabY', fetchBonusRow: () => done.promise });
  tabX.run('startLookupResume()');
  tabY.run('startLookupResume()');
  assert.equal(tabX.calls.fetch.length + tabY.calls.fetch.length, 1, 'exactly one of them runs the lookup');
  const loser = tabX.calls.fetch.length ? tabY : tabX;
  assert.ok(loser.calls.timers.some((t) => t.ms === 2000), 'the other keeps checking every 2 s while it is blocked by the lock');
  done.resolve(okResult());
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(tabX.calls.fetch.length + tabY.calls.fetch.length, 1, 'still one call');
});

test("another agent's unfinished lookup is never resumed (and left untouched for its owner)", async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 12_000, persistedPatch: (p) => { p.A.pendingLookup.agent = 'Agent B'; return p; } });
  const other = widget({ persisted, agent: 'Agent A', focus: 'A', storage, clock, instance: 'copy2' });
  other.run('startLookupResume()');
  assert.equal(other.calls.fetch.length, 0);
  assert.equal(other.state.A.pendingLookup.agent, 'Agent B', 'left in place');
  // same agent name but the row belongs to someone else (caOwner)
  const { clock: c2, storage: s2, persisted: p2 } = await reloadScenario({ ageMs: 12_000, persistedPatch: (p) => { p.A.caOwner = 'Agent B'; return p; } });
  const owner = widget({ persisted: p2, agent: 'Agent A', focus: 'A', storage: s2, clock: c2, instance: 'copy2' });
  owner.run('startLookupResume()');
  assert.equal(owner.calls.fetch.length, 0, 'caOwner check');
});

test('resuming waits until the agent name is known', async () => {
  const { clock, storage, persisted } = await reloadScenario({ ageMs: 12_000 });
  const w = widget({ persisted, agent: '', focus: 'A', storage, clock, instance: 'copy2' });
  w.run('startLookupResume()');
  assert.equal(w.calls.fetch.length, 0);
  w.context.selectedAgent = 'Agent A';
  w.run('resumePendingLookups()');                                   // what saveAgent() does once an agent is chosen
  assert.equal(w.calls.fetch.length, 1);
});

// ---- wiring in app.js -------------------------------------------------------------------------------------------------------
test('the Look up button, boot and agent selection are wired to the new code; Cancel and the reload guard are unchanged', () => {
  assert.match(app, /await runLookup\(chatId, \{ username, brand, telegramNow, link: s\.chatUrl \|\| chatDef\?\.link \|\| "", previousRecordId, forcing, btn \}\);/);
  assert.match(app, /setTimeout\(startLookupResume, 1500\)/);
  assert.match(app, /function saveAgent\(name\) \{[\s\S]*?resumePendingLookups\(\)/);
  assert.match(app, /btn\.dataset\.action === "cancelLookup"[\s\S]*?lookupControllers\.get\(chatId\)[\s\S]*?controller\.abort\(\)/, 'per-chat Cancel still aborts that chat\'s controller');
  assert.match(app, /Object\.values\(state\)\.some\(s => s\?\.lookupInFlight \|\| s\?\.unclaimInFlight\)/, 'the update reload still waits for a running lookup');
  assert.ok(!/s\.lookupInFlight = true;[\s\S]{0,200}showChatToast\(`✓ Looked up/.test(app.slice(app.indexOf('function applyProfile'))), 'no leftover inline lookup body in the click handler');
});
