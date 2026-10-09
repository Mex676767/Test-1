import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
// The saved-answer version stamp and the helper that decides whether a saved "did not write" is still trusted.
const verdictCode = () => app.match(/const AGENT_WROTE_VERSION = .*;/)[0] + '\n' + fn('agentWroteVerdict');

function harness({ flag = true, chat = {}, tokens = { lc1: 'tok' }, replies = [] } = {}) {
  const st = { c1: { chatUrl: 'https://my.livechatinc.com/chats/CHAT/THREAD', ...chat } };
  const calls = { fetched: [], logs: [] };
  const context = vm.createContext({
    JSON, Boolean, String, AGENT_LOGIN_LIVE: flag, state: st, currentLiveChatAccount: 'lc1',
    liveChatAgentTokens: () => tokens,
    logDiagnostic: (text, kind) => calls.logs.push([kind, text]),
    fetch: async (url, options) => {
      calls.fetched.push({ url, body: JSON.parse(options.body) });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { json: async () => reply };
    },
  });
  vm.runInContext(verdictCode() + '\n' + fn('agentWroteInChat'), context);
  return { st, calls, ask: () => vm.runInContext("agentWroteInChat('c1')", context) };
}

test('with the LiveChat login off nothing is asked and the answer is "not theirs" (actions-only rule)', async () => {
  const h = harness({ flag: false });
  assert.equal(await h.ask(), false);
  assert.equal(h.calls.fetched.length, 0);
});

test('asks LiveChat with the agent\'s own login for exactly this chat and thread, then remembers "wrote"', async () => {
  const h = harness({ replies: [{ ok: true, wrote: true, authors: ['a@x'], me: ['a@x'] }] });
  assert.equal(await h.ask(), true);
  assert.deepEqual(h.calls.fetched, [{ url: '/livechat-agent-wrote', body: { accountKey: 'lc1', agentToken: 'tok', chatId: 'CHAT', threadId: 'THREAD' } }]);
  assert.equal(h.st.c1.agentWrote, true);
  assert.equal(await h.ask(), true);
  assert.equal(h.calls.fetched.length, 1, 'answered from the saved result');
});

test('"did not write" is remembered too, and the log shows both sides of the comparison', async () => {
  const h = harness({ replies: [{ ok: true, wrote: false, authors: ['bob@x'], me: ['alice@x'] }] });
  assert.equal(await h.ask(), false);
  assert.equal(h.st.c1.agentWrote, false);
  assert.equal(await h.ask(), false);
  assert.equal(h.calls.fetched.length, 1);
  assert.match(h.calls.logs[0][1], /alice@x/);
  assert.match(h.calls.logs[0][1], /bob@x/);
});

test('when LiveChat cannot be asked the chat stays theirs ("unsure"), the question is repeated, and the log is not spammed', async () => {
  const h = harness({ replies: [new Error('offline'), { ok: false, error: 'Chat not found' }, { ok: true, wrote: false, authors: [], me: ['a@x'] }] });
  assert.equal(await h.ask(), true);
  assert.equal(h.st.c1.agentWrote, 'unsure');
  assert.equal(await h.ask(), true, 'still theirs, asked again');
  assert.equal(h.calls.logs.filter(([kind]) => kind === 'warn').length, 1, 'one warning, not one per attempt');
  assert.equal(await h.ask(), false, 'the later answer replaces "unsure"');
  assert.equal(h.st.c1.agentWrote, false);
  assert.equal(h.calls.fetched.length, 3);
});

test('"unknown" from the server (LiveChat email unreadable) keeps the chat on the list as "unsure" and says why', async () => {
  const h = harness({ replies: [{ ok: true, wrote: null, authors: ['a@x'], me: ['uuid'], error: 'Could not read your LiveChat email (own token: missing scope).' }] });
  assert.equal(await h.ask(), true);
  assert.equal(h.st.c1.agentWrote, 'unsure');
  assert.match(h.calls.logs[0][1], /Could not read your LiveChat email/);
  assert.match(h.calls.logs[0][1], /keeping it on your list/);
});

test('no stored LiveChat login is "unsure"; no chat link yet is simply not theirs (and not remembered); neither calls the server', async () => {
  const noLogin = harness({ tokens: {} });
  assert.equal(await noLogin.ask(), true);
  assert.equal(noLogin.st.c1.agentWrote, 'unsure');
  const noLink = harness({ chat: { chatUrl: '' } });
  assert.equal(await noLink.ask(), false, 'a chat that closed before its first status check: nothing happened that needs recording');
  assert.equal(noLink.st.c1.agentWrote, undefined, 'not remembered, so it is asked again once there is a link');
  assert.equal(noLogin.calls.fetched.length + noLink.calls.fetched.length, 0);
});

test('a chat counts as theirs once they acted, wrote, or LiveChat could not tell', () => {
  const c = vm.createContext({});
  vm.runInContext(fn('agentActed') + '\n' + fn('agentTouchedChat'), c);
  const touched = (s) => vm.runInContext(`agentTouchedChat(${JSON.stringify(s)})`, c);
  assert.equal(touched({ agentWrote: true }), true);
  assert.equal(touched({ agentWrote: 'unsure' }), true);
  assert.equal(touched({ agentWrote: false }), false);
  assert.equal(touched({}), false);
  assert.equal(touched({ agentWrote: false, status: 'Solved' }), true, 'an action still wins');
});

// ---- the sweep gives an unchecked chat to submitRecord only when the login is on --------------------
function sweepWith({ flag, agentWrote }) {
  const submits = [];
  const st = {};
  const context = vm.createContext({
    PENDING_SWEEP_MS: 8000, SWEEP_BACKOFF_CAP_MS: 300000, Date, JSON, AGENT_LOGIN_LIVE: flag,
    activeChats: [], state: st, isLoggingPaused: () => false, currentLiveChatAccount: 'lc1', selectedAgent: 'Agent A',
    document: { hidden: false },
    loadPersistedState: () => ({ c1: { chatOpen: false, logged: false, liveChatAccount: 'lc1', username: 'x', inquiry: [], status: '', agentWrote, agentWroteV: agentWrote === undefined ? undefined : 3 } }),
    markStateSynced() {}, renderNeedsAttentionPanel() {}, checkChatStatus: async () => {}, holdsSweepLease: () => true,
    submitRecord: async (chatId) => { submits.push(chatId); },
  });
  vm.runInContext([fn('nextSweepDelay'), fn('sweepSignature'), fn('agentActed'), fn('agentTouchedChat'), verdictCode(), fn('sweepPendingChats')].join('\n'), context);
  return { submits, run: () => vm.runInContext('sweepPendingChats()', context) };
}

test('sweep: an unchecked, unworked chat is handed to submitRecord only with the login on', async () => {
  const on = sweepWith({ flag: true, agentWrote: undefined });
  await on.run();
  assert.deepEqual(on.submits, ['c1']);
  const off = sweepWith({ flag: false, agentWrote: undefined });
  await off.run();
  assert.deepEqual(off.submits, []);
});

test('sweep: once LiveChat said they did not write, the chat is left alone; "wrote" or "unsure" keeps it in play', async () => {
  const no = sweepWith({ flag: true, agentWrote: false });
  await no.run();
  assert.deepEqual(no.submits, []);
  for (const agentWrote of [true, 'unsure']) {
    const yes = sweepWith({ flag: true, agentWrote });
    await yes.run();
    assert.deepEqual(yes.submits, ['c1'], String(agentWrote));
  }
});

test('the record gate asks LiveChat only for a chat the agent did not act on, before anything is stamped or flagged', () => {
  const submit = app.slice(app.indexOf('async function submitRecordOnce'));
  const gate = submit.indexOf('if (auto && !agentActed(s)) {');
  assert.ok(gate > -1);
  assert.ok(submit.indexOf('await agentWroteInChat(chatId)', gate) > gate);
  assert.ok(gate < submit.indexOf('s.agentName = selectedAgent'));
  assert.ok(gate < submit.indexOf('if (!selectedAgent)'));
});

test('they wrote but the customer never did (the agent reached out): not theirs, remembered, and the log says why', async () => {
  const h = harness({ replies: [{ ok: true, wrote: true, customerWrote: false, authors: ['a@x'], me: ['a@x'] }] });
  assert.equal(await h.ask(), false);
  assert.equal(h.st.c1.agentWrote, false);
  assert.equal(h.st.c1.agentWroteV, 3);
  assert.match(h.calls.logs.at(-1)[1], /the customer never wrote in this chat/);
  assert.equal(await h.ask(), false);
  assert.equal(h.calls.fetched.length, 1, 'asked once');
});

test('they wrote and the customer wrote too: theirs; an older server that does not say is taken as "the customer wrote"', async () => {
  const both = harness({ replies: [{ ok: true, wrote: true, customerWrote: true, authors: [], me: [] }] });
  assert.equal(await both.ask(), true);
  const older = harness({ replies: [{ ok: true, wrote: true, authors: [], me: [] }] });
  assert.equal(await older.ask(), true);
});

test('an earlier "wrote" (before this rule) is asked about again, so a chat flagged by mistake clears itself', async () => {
  const h = harness({ chat: { agentWrote: true }, replies: [{ ok: true, wrote: true, customerWrote: false, authors: ['a@x'], me: ['a@x'] }] });
  assert.equal(await h.ask(), false);
  assert.equal(h.st.c1.agentWrote, false);
  assert.equal(h.calls.fetched.length, 1);
});
