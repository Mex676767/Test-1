import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

function context(extra = {}) {
  const context = vm.createContext({ ...extra });
  vm.runInContext(fn('agentActed') + '\n' + fn('agentTouchedChat'), context);
  return context;
}
const touched = (s) => vm.runInContext('agentTouchedChat(' + JSON.stringify(s) + ')', context());

const untouched = { username: 'nizamawsb', usernameDraft: '', caRecordId: null, inquiry: [], status: '', claimedPrograms: {}, logs: [] };

test('a chat nobody worked is not touched, even with a username auto-filled from an earlier recording', () => {
  assert.equal(touched(untouched), false);
  assert.equal(touched({ ...untouched, lastUsernameFound: true, lastUsernameValue: 'nizamawsb' }), false);
  assert.equal(touched(null), false);
  assert.equal(touched({}), false);
});

test('any real action by the agent makes it theirs', () => {
  assert.equal(touched({ ...untouched, caRecordId: 'rec1' }), true, 'Look up done');
  assert.equal(touched({ ...untouched, usernameDraft: 'abc' }), true, 'typed a username but never pressed Look up');
  assert.equal(touched({ ...untouched, inquiry: ['Bonus Checking'] }), true);
  assert.equal(touched({ ...untouched, status: 'Solved' }), true);
  assert.equal(touched({ ...untouched, logs: [{ caseNo: 1 }] }), true, 'an earlier case was parked');
  assert.equal(touched({ ...untouched, claimedPrograms: { gracePeriod: true } }), true);
  assert.equal(touched({ ...untouched, usernameDraft: '   ' }), false, 'blank typing is not work');
});

test('Needs Attention lists only touched chats, so a stale flag from an older version disappears', () => {
  const rows = {
    mine:      { chatOpen: false, logged: false, autoRecordError: 'missing', agentName: 'Me', liveChatAccount: 'lc1', caRecordId: 'rec1' },
    watched:   { chatOpen: false, logged: false, autoRecordError: 'missing', agentName: 'Me', liveChatAccount: 'lc1', username: 'nizamawsb', inquiry: [], status: '' },
    otherAgent:{ chatOpen: false, logged: false, autoRecordError: 'missing', agentName: 'Else', liveChatAccount: 'lc1', caRecordId: 'rec2' },
  };
  const c = vm.createContext({ IS_EMBEDDED_APP: true, AGENT_LOGIN_LIVE: false, currentLiveChatAccount: 'lc1', selectedAgent: 'Me', loadPersistedState: () => rows, archiveUrlFor: (id) => 'u/' + id });
  vm.runInContext(fn('agentActed') + '\n' + fn('agentTouchedChat') + '\n' + fn('getIncompleteChats'), c);
  const ids = vm.runInContext('getIncompleteChats().map((x) => x.chatId).join(",")', c);
  assert.equal(ids, 'mine');
});

test('auto-record skips an untouched chat before it stamps the agent or sets an error; the manual button is not gated', () => {
  const submit = app.slice(app.indexOf('async function submitRecordOnce'));
  const gate = submit.indexOf('if (auto && (!agentActed(s) || (AGENT_LOGIN_LIVE && caseNeverLookedUp(s)))) {');
  assert.ok(gate > -1, 'the gate exists');
  assert.ok(gate < submit.indexOf('if (!selectedAgent)'), 'before any error is set');
  assert.ok(gate < submit.indexOf('s.agentName = selectedAgent'), 'before the chat is stamped with the agent');
  assert.ok(gate > submit.indexOf('if (isLoggingPaused())'), 'after the pause gate');
});

test('old uncertain flags disappear immediately, including a prefilled username copied into the draft', () => {
  const base = { ...untouched, chatOpen: false, logged: false, autoRecordError: 'not fully filled in', agentName: 'Me', liveChatAccount: 'lc1' };
  const rows = {
    watched: { ...base, agentWrote: 'unsure' },
    draft: { ...base, usernameDraft: 'nizamawsb', agentWrote: 'unsure' },
    otherWriter: { ...base, usernameDraft: 'nizamawsb', agentWrote: false, agentWroteV: 3 },
    mine: { ...base, agentWrote: true, agentWroteV: 3 },
    lookedUp: { ...base, caRecordId: 'rec1' },
  };
  const c = vm.createContext({ IS_EMBEDDED_APP: true, AGENT_LOGIN_LIVE: true, currentLiveChatAccount: 'lc1', selectedAgent: 'Me', loadPersistedState: () => rows, archiveUrlFor: (id) => 'u/' + id });
  vm.runInContext([app.match(/const AGENT_WROTE_VERSION = .*;/)[0], ...['agentWroteVerdict', 'agentActed', 'agentTouchedChat', 'caseNeverLookedUp', 'getIncompleteChats'].map(fn)].join('\n'), c);
  assert.equal(vm.runInContext('getIncompleteChats().map((x) => x.chatId).join(",")', c), 'mine,lookedUp');
});

test('a viewed chat is not flagged on verification failure, retries, and only flags a confirmed writer', async () => {
  for (const wrote of [false, true]) {
    const s = { ...untouched, username: 'petai3862', usernameDraft: 'petai3862', chatUrl: 'https://my.livechatinc.com/chats/CHAT/THREAD', autoRecordError: 'old false flag' };
    const replies = [new Error('offline'), { ok: true, wrote, customerWrote: true, authors: ['yoona@example.com'], me: ['me@example.com'] }];
    let writes = 0;
    let requests = 0;
    const c = vm.createContext({
      state: { c1: s }, previewMode: false, AGENT_LOGIN_LIVE: true, selectedAgent: 'Me', currentLiveChatAccount: 'lc1',
      activeChats: [], isLoggingPaused: () => false, chatListEl: { querySelector: () => null }, liveChatAgentTokens: () => ({ lc1: 'test-token' }),
      autoMissingLoggedFor: new Map(), logDiagnostic() {}, renderChats() {}, renderNeedsAttentionPanel() {}, setStatus() {},
      writeLarkRecord: async () => { writes++; },
      fetch: async () => { requests++; const reply = replies.shift(); if (reply instanceof Error) throw reply; return { json: async () => reply }; },
    });
    vm.runInContext([app.match(/const AGENT_WROTE_VERSION = .*;/)[0], ...['agentWroteVerdict', 'agentWroteInChat', 'agentActed', 'caseNeverLookedUp', 'ownsCaseRecord', 'submitRecordOnce'].map(fn)].join('\n'), c);
    await c.submitRecordOnce('c1', { auto: true });
    assert.equal(s.agentWrote, 'unsure');
    assert.equal(s.autoRecordError, '');
    assert.equal(s.agentName, undefined, 'viewing and a failed check cannot assign the chat');
    await c.submitRecordOnce('c1', { auto: true });
    assert.equal(requests, 2, 'verification is retried');
    assert.equal(s.agentWrote, wrote);
    assert.equal(writes, 0, 'no Lark row is created by viewing');
    if (wrote) {
      assert.equal(s.agentName, 'Me');
      assert.match(s.autoRecordError, /look up the username/);
    } else {
      assert.equal(s.agentName, undefined);
      assert.equal(s.autoRecordError, '');
    }
  }
});

test('the background sweep does not retry an untouched chat', () => {
  const sweep = app.slice(app.indexOf('async function sweepPendingChats'), app.indexOf('setInterval(sweepPendingChats'));
  const skip = sweep.indexOf('agentTouchedChat(idle)');
  assert.ok(skip > -1);
  assert.ok(skip < sweep.indexOf('await submitRecord('), 'the skip comes before the retry');
});

test('a saved case that was never looked up (no player, no Lark record) is checked against the chat: if you never wrote there, it is dropped from Needs Attention', async () => {
  const run = async (state, wrote) => {
    const logs = [];
    const c = vm.createContext({
      state: { c1: state }, previewMode: false, AGENT_LOGIN_LIVE: true, selectedAgent: 'Me', currentLiveChatAccount: 'lc1', autoMissingLoggedFor: new Map(), writeLarkRecord: async () => {}, clearRecordRetry: () => {}, markCaseRecorded: () => {}, saveState: () => {}, scheduleNeedsAttentionRefresh: () => {}, activeChats: [], isLoggingPaused: () => false, recordSubmitInFlight: new Map(),
      chatListEl: { querySelector: () => null }, logDiagnostic: (text) => logs.push(text), renderChats: () => {}, renderNeedsAttentionPanel: () => {}, setStatus: () => {},
      agentWroteInChat: async () => { logs.push('asked'); return wrote; },
    });
    vm.runInContext(fn('agentActed') + '\n' + fn('caseNeverLookedUp') + '\n' + fn('ownsCaseRecord') + '\n' + fn('submitRecordOnce'), c);
    await vm.runInContext('submitRecordOnce("c1", { auto: true, reason: "Retrying" })', c);
    return { state: c.state.c1, logs };
  };
  const orphan = { username: '', caRecordId: null, inquiry: ['TOP P&L'], status: 'Given', claimedPrograms: { topPnl: true }, brand: 'JUS', autoRecordError: 'old', logged: false, escalation: {} };
  const dropped = await run({ ...orphan }, false);
  assert.ok(dropped.logs.includes('asked'), 'the chat is checked even though inquiry, status and a claim are filled in');
  assert.equal(dropped.state.autoRecordError, '', 'the flag is cleared, so it leaves the list');
  assert.equal(dropped.state.agentName, undefined, 'nothing is stamped on it');
  const autofilled = await run({ ...orphan, username: 'petai3862', lastUsernameFound: true, lastUsernameValue: 'petai3862' }, false);
  assert.ok(autofilled.logs.includes('asked'), 'a remembered username is not evidence of a lookup');
  assert.equal(autofilled.state.autoRecordError, '');
  assert.equal(autofilled.state.agentName, undefined);
  const wrote = await run({ ...orphan }, true);
  assert.match(wrote.state.autoRecordError, /missing: username, look up the username/, 'if you did write there, it stays on the list');
  const looked = await run({ ...orphan, username: 'p1', caRecordId: 'rec1' }, false);
  assert.ok(!looked.logs.includes('asked'), 'a case with a lookup behind it is not second-guessed');
});

test('the Console log says how a case got its content: claim, inquiry, status, another tab, or a saved case picked up on start', () => {
  const logs = [];
  const c = vm.createContext({ state: { c1: { username: '', caRecordId: null } }, selectedAgent: 'Me', logDiagnostic: (text) => logs.push(text) });
  vm.runInContext('const caseOriginLogged = new Set();\n' + fn('logCaseOrigin'), c);
  vm.runInContext('logCaseOrigin("c1", "topPnl claimed"); logCaseOrigin("c1", "topPnl claimed"); logCaseOrigin("c1", "status picked");', c);
  assert.equal(logs.length, 2, 'each way is logged once per chat');
  assert.match(logs[0], /Chat c1: topPnl claimed \(player: none, Lark record: no, agent: Me\)/);
  for (const how of [' claimed', '"inquiry picked"', '"status picked"', 'another tab of this browser', 'saved earlier in this browser']) assert.ok(app.includes(how), how);
});
