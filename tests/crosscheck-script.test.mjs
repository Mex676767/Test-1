import test from 'node:test';
import assert from 'node:assert/strict';
import { planEntries, windows, summarize, run, createClient } from '../scripts/crosscheck-unrecorded.mjs';

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
function fakeSite({ recorded = [], existing = [], archives = {}, notConfigured = [], pendingByAccount = {}, aloneReply = {} }) {
  const calls = [];
  const step = async (body) => {
    calls.push(body.step + (body.account ? ':' + body.account : ''));
    if (body.step === 'recorded') return body.pageToken ? { ok: true, threads: ['T9'], next: '', rows: 1 } : { ok: true, threads: recorded, next: 'p2', rows: 2 };
    if (body.step === 'existing') return { ok: true, keys: existing, next: '' };
    if (body.step === 'archives') {
      if (notConfigured.includes(body.account)) return { ok: false, error: `LiveChat account ${body.account} is not configured.` };
      const pages = archives[body.account] || [[]];
      const index = body.pageId ? Number(body.pageId) : 0;
      return { ok: true, chats: pages[index], pending: (pendingByAccount[body.account] || []).filter(() => index === 0 && body.from === 0), next: index + 1 < pages.length ? String(index + 1) : '' };
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
  const out = await run({ step: site.step, ...period, write: false, log, accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => `${e.threadId}|${e.email}`), ['T2|a@x', 'T2|b@x']);
  assert.equal(out.created, 0);
  assert.ok(!site.calls.includes('write') && !site.calls.includes('existing'));
  assert.deepEqual(site.calls.filter((c) => c === 'recorded').length, 2, 'both pages of Customer Approaching were read');
  assert.ok(quiet.some((line) => /Dry run/.test(line)));
});

test('--write skips what is already in the table and writes the rest in chunks of 25', async () => {
  const many = Array.from({ length: 30 }, (_, i) => chat('N' + i, ['a@x']));
  const site = fakeSite({ existing: ['N0|a@x'], archives: { lc1: [many] } });
  const out = await run({ step: site.step, ...period, write: true, log, accounts: ['lc1'] });
  assert.equal(out.entries.length, 29);
  assert.equal(out.created, 29);
  assert.equal(site.calls.filter((c) => c === 'write').length, 2, '25 + 4');
});

test('every window and page of the archive is read, the same chat in two windows counts once, and an unconfigured account is skipped', async () => {
  const site = fakeSite({ archives: { lc1: [[chat('A', ['a@x'])], [chat('A', ['a@x']), chat('B', ['a@x'])]] }, notConfigured: ['lc2'] });
  const out = await run({ step: site.step, ...period, write: false, log });
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
  const out = await run({ step: site.step, ...period, write: false, log: (l) => lines.push(l), accounts: ['lc1'] });
  assert.deepEqual(out.entries.map((e) => e.threadId).sort(), ['A', 'P1'], 'P2 had no agent message, P3 could not be judged');
  assert.equal(site.calls.filter((c) => c === 'chat:lc1').length, 3);
  const summary = lines.find((l) => l.startsWith('lc1:'));
  assert.match(summary, /3 chats had to be fetched one by one/);
  assert.match(summary, /1 could NOT be judged/);
});
