import test from 'node:test';
import assert from 'node:assert/strict';
import { planEntries, windows, summarize, run, createClient, pool, stepWithRetry } from '../scripts/crosscheck-unrecorded.mjs';

const chat = (threadId, writers, extra = {}) => ({ chatId: 'C-' + threadId, threadId, date: 5, customer: 'Zimito', writers, ...extra });

test('a chat is judged per writer: recorded chats and rows already written are skipped, twins are not made', () => {
  const chats = [chat('T1', ['a@x', 'b@x']), chat('T2', ['a@x']), chat('T3', ['a@x', 'A@X'])];
  const entries = planEntries(chats, new Set(['T2']), new Set(['T1|b@x']), 'lc1');
  assert.deepEqual(entries.map((e) => `${e.threadId}|${e.email}`), ['T1|a@x', 'T3|a@x']);
  assert.deepEqual(entries[0], { threadId: 'T1', chatId: 'C-T1', account: 'lc1', email: 'a@x', date: 5, customer: 'Zimito' });
});

test('the period is cut into equal windows and the last one ends exactly at the end', () => {
  assert.deepEqual(windows(0, 25, 10), [[0, 10], [10, 20], [20, 25]]);
  assert.deepEqual(windows(0, 10, 10), [[0, 10]]);
  assert.deepEqual(windows(5, 5, 10), []);
});

test('the summary counts rows per agent email, busiest first', () => {
  assert.deepEqual(summarize([{ email: 'a@x' }, { email: 'b@x' }, { email: 'a@x' }]), [['a@x', 2], ['b@x', 1]]);
});

// A fake of the site's /crosscheck steps.
function fakeSite({ recorded = [], existing = [], archives = {}, notConfigured = [], pendingByAccount = {}, aloneReply = {}, knownAgents = [], outreachByAccount = {} }) {
  const calls = [];
  const step = async (body) => {
    calls.push(body.step + (body.account ? ':' + body.account : ''));
    if (body.step === 'recorded') return body.pageToken ? { ok: true, threads: ['T9'], next: '', rows: 1 } : { ok: true, threads: recorded, next: 'p2', rows: 2 };
    if (body.step === 'existing') return { ok: true, keys: existing, next: '' };
    if (body.step === 'agents') return { ok: true, agents: knownAgents };
    if (body.step === 'archives') {
      if (notConfigured.includes(body.account)) return { ok: false, error: `LiveChat account ${body.account} is not configured.` };
      const pages = archives[body.account] || [[]];
      const index = body.pageId ? Number(body.pageId) : 0;
      return { ok: true, outreach: outreachByAccount[body.account] && index === 0 && body.from === 0 ? outreachByAccount[body.account] : 0, chats: pages[index], pending: (pendingByAccount[body.account] || []).filter(() => index === 0 && body.from === 0), next: index + 1 < pages.length ? String(index + 1) : '' };
    }
    if (body.step === 'chat') return aloneReply[body.threadId] || { ok: false, error: 'LiveChat refused' };
    if (body.step === 'write') return { ok: true, created: body.entries.length, failed: [] };
    throw new Error('unexpected ' + body.step);
  };
  return { step, calls };
}
const period = { fromMs: 0, toMs: 20, windowMs: 10 };
const quiet = [];
const log = (line) => quiet.push(line);

test('a dry run reads everything, writes nothing and says what it would write', async () => {
  const site = fakeSite({ recorded: ['T1'], archives: { lc1: [[chat('T1', ['a@x']), chat('T2', ['a@x', 'b@x'])]] } });
  const out = await run({ step: site.step, ...period, onlyKnown: false, write: false, log, accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => `${e.threadId}|${e.email}`), ['T2|a@x', 'T2|b@x']);
  assert.equal(out.created, 0);
  assert.ok(!site.calls.includes('write') && !site.calls.includes('existing'));
  assert.deepEqual(site.calls.filter((c) => c === 'recorded').length, 2, 'both pages of Customer Approaching were read');
  assert.ok(quiet.some((line) => /Dry run/.test(line)));
});

test('--write skips what is already in the table and writes the rest in chunks of 25', async () => {
  const many = Array.from({ length: 30 }, (_, i) => chat('N' + i, ['a@x']));
  const site = fakeSite({ existing: ['N0|a@x'], archives: { lc1: [many] } });
  const out = await run({ step: site.step, ...period, onlyKnown: false, write: true, log, accounts: ['lc1'] });
  assert.equal(out.entries.length, 29);
  assert.equal(out.created, 29);
  assert.equal(site.calls.filter((c) => c === 'write').length, 2, '25 + 4');
});

test('every window and page of the archive is read, the same chat in two windows counts once, and an unconfigured account is skipped', async () => {
  const site = fakeSite({ archives: { lc1: [[chat('A', ['a@x'])], [chat('A', ['a@x']), chat('B', ['a@x'])]] }, notConfigured: ['lc2'] });
  const out = await run({ step: site.step, ...period, onlyKnown: false, write: false, log });
  assert.deepEqual(out.entries.map((e) => e.threadId).sort(), ['A', 'B']);
  assert.equal(site.calls.filter((c) => c === 'archives:lc1').length, 4, '2 windows x 2 pages');
  assert.ok(site.calls.includes('archives:lc2'));
});

test('a refused key stops at once with a clear message; a network blip is retried', async () => {
  const refused = createClient({ base: 'https://site', key: 'k', pauseMs: 0, fetchImpl: async () => ({ status: 401, json: async () => ({ ok: false }) }) });
  await assert.rejects(() => refused({ step: 'recorded' }), /check the key/);
  let attempts = 0;
  const flaky = createClient({ base: 'https://site', key: 'k', pauseMs: 0, retries: 3, fetchImpl: async (url, options) => {
    attempts += 1;
    assert.equal(options.headers['x-scan-key'], 'k');
    if (attempts < 2) throw new Error('network');
    return { status: 200, json: async () => ({ ok: true }) };
  } });
  assert.equal((await flaky({ step: 'recorded' })).ok, true);
  assert.equal(attempts, 2);
});

test('chats that came without their messages are fetched one by one and judged; one LiveChat refuses is reported, not guessed', async () => {
  const site = fakeSite({
    archives: { lc1: [[chat('A', ['a@x'])]] },
    pendingByAccount: { lc1: [{ chatId: 'C-P1', threadId: 'P1' }, { chatId: 'C-P2', threadId: 'P2' }, { chatId: 'C-P3', threadId: 'P3' }] },
    aloneReply: { P1: { ok: true, chat: chat('P1', ['b@x']) }, P2: { ok: true, chat: null } },
  });
  const lines = [];
  const out = await run({ step: site.step, ...period, onlyKnown: false, write: false, log: (l) => lines.push(l), accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => e.threadId).sort(), ['A', 'P1'], 'P2 had no agent message, P3 could not be judged');
  assert.equal(site.calls.filter((c) => c === 'chat:lc1').length, 3);
  const summary = lines.find((l) => l.startsWith('lc1:'));
  assert.match(summary, /3 chats had to be fetched one by one/);
  assert.match(summary, /1 could NOT be judged/);
});

test('a writer known as an agent is judged on their OWN record; an unknown writer on "any row for the chat"', () => {
  const chats = [chat('T1', ['a@x', 'b@x']), chat('T2', ['a@x', 'u@x'])];
  const recorded = new Set(['T1', 'T2']);
  const names = { pairs: new Set(['T1|96 alice', 'T2|96 bob']), byEmail: new Map([['a@x', '96 Alice'], ['b@x', '96 Bob']]) };
  const entries = planEntries(chats, recorded, new Set(), 'lc1', names);
  assert.deepEqual(entries.map((e) => `${e.threadId}|${e.email}`), ['T1|b@x', 'T2|a@x'],
    'Bob did not record T1 and Alice did not record T2, although other rows exist; u@x is unknown so T2 counts as recorded for them');
});

test('the run reads the agent list, uses it, and says how many agents it knows', async () => {
  const site = fakeSite({ recorded: ['T1'], archives: { lc1: [[chat('T1', ['a@x'])]] }, knownAgents: [{ email: 'A@X', name: '96 Alice' }] });
  const lines = [];
  const out = await run({ step: site.step, ...period, onlyKnown: false, write: false, log: (l) => lines.push(l), accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => e.email), ['a@x'], 'T1 has a row, but not one of Alice');
  assert.ok(site.calls.includes('agents'));
  assert.ok(lines.some((l) => /1 agents have their LiveChat email filled in/.test(l)));
});

test('the run says how many outreach-only chats (e.g. Blast) were left out', async () => {
  const site = fakeSite({ archives: { lc1: [[chat('A', ['a@x'])]] }, outreachByAccount: { lc1: 7 } });
  const lines = [];
  await run({ step: site.step, ...period, onlyKnown: false, write: false, log: (l) => lines.push(l), accounts: ['lc1'] });
  assert.match(lines.find((l) => l.startsWith('lc1:')), /7 outreach-only chats \(the customer never wrote, e\.g\. Blast\) were left out/);
});

test('pool runs the work a few at a time, never more than the limit, and rejects on the first failure', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); seen.push(n); running -= 1; });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(() => pool([1, 2], 2, async (n) => { if (n === 2) throw new Error('boom'); }), /boom/);
});

test('a temporary LiveChat refusal is retried; a real error is not', async () => {
  const replies = [{ ok: false, error: 'Too many requests' }, { ok: false, error: 'request timed out' }, { ok: true, chats: [] }];
  let calls = 0;
  assert.equal((await stepWithRetry(async () => { calls += 1; return replies.shift(); }, {}, 4, 0)).ok, true);
  assert.equal(calls, 3);
  let real = 0;
  const out = await stepWithRetry(async () => { real += 1; return { ok: false, error: 'Chat not found' }; }, {}, 4, 0);
  assert.equal(out.ok, false);
  assert.equal(real, 1, 'no retry for an error that will not go away');
  let stuck = 0;
  await stepWithRetry(async () => { stuck += 1; return { ok: false, error: 'Too many requests' }; }, {}, 3, 0);
  assert.equal(stuck, 3, 'gives up after the allowed tries');
});

test('both accounts are read at the same time, with a progress line per finished window', async () => {
  const startedOrder = [];
  let open = 0;
  let peak = 0;
  const site = fakeSite({ archives: { lc1: [[chat('A', ['a@x'])]], lc2: [[chat('B', ['b@x'])]] } });
  const slow = async (body) => {
    if (body.step === 'archives') {
      startedOrder.push(body.account);
      open += 1; peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 10));
      open -= 1;
    }
    return site.step(body);
  };
  const lines = [];
  const out = await run({ step: slow, ...period, onlyKnown: false, write: false, log: (l) => lines.push(l) });
  assert.ok(peak >= 2, 'more than one archive request was in flight at once');
  assert.deepEqual(out.entries.map((e) => e.account), ['lc1', 'lc2'], 'results stay in account order');
  assert.ok(lines.some((l) => /^ {2}\[lc1\] window 2\/2 done, 1 chats so far/.test(l)));
  assert.ok(lines.some((l) => /^ {2}\[lc2\] window 2\/2 done/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('lc1:')) && lines.some((l) => l.startsWith('lc2:')));
});

test('only people who use the widget are listed: customer service, bots and agents not yet in the table are left out and counted', () => {
  const chats = [chat('T1', ['a@x', 'cs@x']), chat('T2', ['hexid', 'cs@x'])];
  const names = { pairs: new Set(), byEmail: new Map([['a@x', '96 Alice']]) };
  const stats = {};
  const entries = planEntries(chats, new Set(), new Set(), 'lc1', names, { stats });
  assert.deepEqual(entries.map((e) => `${e.threadId}|${e.email}`), ['T1|a@x']);
  assert.equal(stats.unknownWriters, 3);
  const everyone = planEntries(chats, new Set(), new Set(), 'lc1', names, { onlyKnown: false });
  assert.equal(everyone.length, 4, 'with --all-writers nobody is left out');
});

test('the run says how many chat/writer pairs were left out, and refuses to run with nobody known (instead of listing everyone)', async () => {
  const withAgent = fakeSite({ archives: { lc1: [[chat('A', ['a@x', 'cs@x'])]] }, knownAgents: [{ email: 'a@x', name: '96 Alice' }] });
  const lines = [];
  const out = await run({ step: withAgent.step, ...period, write: false, log: (l) => lines.push(l), accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => e.email), ['a@x']);
  assert.match(lines.find((l) => l.startsWith('lc1:')), /1 chat\/writer pairs left out: the writer is not in the Agent Logins table/);
  const nobody = fakeSite({ archives: { lc1: [[chat('A', ['a@x'])]] } });
  await assert.rejects(() => run({ step: nobody.step, ...period, write: false, log: () => {}, accounts: ['lc1'] }), /No agent has their LiveChat email/);
  assert.equal((await run({ step: nobody.step, ...period, write: false, onlyKnown: false, log: () => {}, accounts: ['lc1'] })).entries.length, 1);
});
