import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { calendarDays, displayDate } from '../qa/datepicker.js';
import { createCache } from '../qa/cache.js';
import { pickerLabel } from '../qa/agentpicker.js';
import { agentChoices, alignedWindows, checkKnownUsernames, describeChatLog, threadFromInput, toCsv } from '../qa/scan.js';
import { ALWAYS_EXCLUDED_HASHES, HIDE_UNTRACKED_BEFORE, HIDE_UNTRACKED_HASHES, dropOwnUntracked, MARK_LABELS, classifyEntries, countMarks, emailHash, loadTicks, loadLogged, loggedIssues, planAll, scanChats, summarizeLogged, toLoggedCsv } from '../qa/scan.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0];

function tabs({ previewMode, activeMainTab, qaView = false }) {
  const element = (extra = {}) => ({ hidden: true, style: {}, ...extra });
  const frame = { src: '', dataset: { src: '/qa/index.html' } };
  const els = { unknownChatsTab: element(), unknownChatsView: element({ querySelector: () => frame }), chatList: element({ hidden: false }), mainTabs: element(), retentionTab: element(), ticketsTab: element(), blastTab: element(), knowledgeTab: element(), agentBadge: element({ hidden: false }) };
  const context = vm.createContext({
    activeMainTab, previewMode, qaView, QA_VIEW_ALSO_TICKETS_AND_KNOWLEDGE: false, blastRunInProgress: false, DEPARTMENT_TABS_LIVE: false, BLAST_LIVE: false, CONFIGURED_LIVECHAT_ACCOUNT: '',
    mainTabAvailability: () => ({ customer: true, blast: true, tickets: false, knowledge: false }), ESCALATION_TICKET_ENABLED: true,
    document: { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] },
    URL,
    location: { origin: 'https://widget.test' },
  });
  vm.runInContext(fn('syncMainTabs'), context);
  vm.runInContext('syncMainTabs()', context);
  return { context, els, frame };
}

test('QA is a tab of the admin preview only: shown there, its page loads once opened, and the installed widget never shows it', () => {
  const preview = tabs({ previewMode: true, activeMainTab: 'unknownChats' });
  assert.equal(preview.els.unknownChatsTab.hidden, false);
  assert.equal(preview.context.activeMainTab, 'unknownChats');
  assert.equal(preview.els.unknownChatsView.hidden, false);
  assert.equal(preview.els.chatList.hidden, true, 'the chat cards give way to the page');
  assert.equal(preview.frame.src, '/qa/index.html');

  const otherTab = tabs({ previewMode: true, activeMainTab: 'customer' });
  assert.equal(otherTab.els.unknownChatsTab.hidden, false);
  assert.equal(otherTab.els.unknownChatsView.hidden, true);
  assert.equal(otherTab.frame.src, '', 'not loaded until the tab is opened');

  const installed = tabs({ previewMode: false, activeMainTab: 'unknownChats' });
  assert.equal(installed.els.unknownChatsTab.hidden, true);
  assert.equal(installed.context.activeMainTab, 'customer', 'a remembered QA tab falls back to Retention');
  assert.equal(installed.els.unknownChatsView.hidden, true);
  assert.equal(installed.frame.src, '');
});

test('the tab and its page are wired in index.html', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="unknownChatsTab"[^>]*data-main-tab="unknownChats"[^>]*hidden/);
  assert.match(html, /id="unknownChatsView"[\s\S]*?data-src="\/qa\/index\.html"/);
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  assert.match(page, /src="qa\.js[^"]*"/);
  assert.match(page, /id="signInBtn"/, 'QA signs in with LiveChat');
  assert.doesNotMatch(page, /Access key|QA_KEY/);
});

test('scan.js runs in a browser: it imports nothing', () => {
  const source = readFileSync(new URL('../qa/scan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /node:|process\.|require\(/);
});

test('the page reads, never writes: it only asks the read steps of /crosscheck', () => {
  const page = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  const scan = readFileSync(new URL('../qa/scan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page + scan, /step: "write"|step: "existing"/);
});

const archive = (threadId, writers) => ({ chatId: 'C-' + threadId, threadId, date: 5, customer: 'Zimito', writers, counts: Object.fromEntries(writers.map((w) => [w, 2])), customerMessages: 1 });
const site = (chats) => async (body) => {
  if (body.step === 'recorded') return { ok: true, threads: [], pairs: [], next: '', rows: 0 };
  if (body.step === 'agents') return { ok: true, agents: [{ email: 'a@x', name: '96 Alice' }, { email: 'me@x', name: 'Admin' }] };
  if (body.step === 'archives') return { ok: true, chats: body.account === 'lc1' ? chats : [], pending: [], outreach: 0, next: '' };
  throw new Error('unexpected ' + body.step);
};

test('a scan can be stopped between steps, and leaves out the emails it is told to', async () => {
  const log = [];
  const scan = await scanChats({ step: site([archive('T1', ['a@x', 'me@x'])]), fromMs: 0, toMs: 10, windowMs: 10, log: () => {} });
  const entries = planAll(scan, { exclude: ['ME@x'], log: (l) => log.push(l) });
  assert.deepEqual(entries.map((e) => e.email), ['a@x']);
  assert.match(log.join('\n'), /1 chat\/writer pairs left out: excluded emails/);

  let calls = 0;
  await assert.rejects(
    () => scanChats({ step: site([]), fromMs: 0, toMs: 10, windowMs: 10, isCancelled: () => (calls += 1) > 1 }),
    (error) => error.cancelled === true,
  );
});

test('the admin logins built into the code are salted hashes, never the plain emails, and the scan drops the writers that match', async () => {
  assert.equal(ALWAYS_EXCLUDED_HASHES.size, 0, 'nobody is left out by default: the admin logins are included');
  for (const hash of ALWAYS_EXCLUDED_HASHES) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(await emailHash('boss@x'), await emailHash('boss@x '.replace('x ', 'y')), 'different emails, different hashes');
  assert.equal(await emailHash(' BOSS@x '), await emailHash('boss@x'), 'letter case and spaces do not matter');

  const hash = await emailHash('boss@x');
  ALWAYS_EXCLUDED_HASHES.add(hash);
  try {
    const log = [];
    const scan = await scanChats({ step: site([archive('T1', ['a@x', 'Boss@x']), archive('T2', ['boss@x'])]), fromMs: 0, toMs: 10, windowMs: 10 });
    assert.deepEqual([...scan.alwaysExcluded], ['boss@x']);
    const entries = planAll(scan, { log: (l) => log.push(l) });
    assert.deepEqual(entries.map((e) => `${e.threadId}|${e.email}`), ['T1|a@x']);
    assert.match(log.join('\n'), /2 chat\/writer pairs left out: excluded emails/);
  } finally {
    ALWAYS_EXCLUDED_HASHES.delete(hash);
  }
});

const logRow = (agent, createdAt, extra = {}) => ({ recordId: "r" + createdAt, createdAt, agent, username: "p" + createdAt, brand: "VS96", inquiry: ["Free Spin"], status: "Done", amount: 10, link: "https://my.livechatinc.com/archives/T" + createdAt, threadId: "T" + createdAt, ...extra });

test("what a logged case is missing is named, and agents are ranked by how much they logged", () => {
  assert.deepEqual(loggedIssues(logRow("A", 1)), []);
  assert.deepEqual(loggedIssues(logRow("A", 1, { inquiry: [], status: "", username: "", brand: "", link: "" })), ["No inquiry", "No status", "No username", "No brand", "No chat link"]);
  const rows = [logRow("96 Alice", 1), logRow("96 bob", 2), logRow("96 Bob", 3, { status: "" }), logRow("96 Bob", 4)];
  assert.deepEqual(summarizeLogged(rows), [{ agent: "96 bob", total: 3, incomplete: 1 }, { agent: "96 Alice", total: 1, incomplete: 0 }], "names that differ only in letter case are one agent");
});

test("the QA sheet of logged chats lists the busiest agent first, newest first, with the missing parts, a chat link and empty QA columns", () => {
  const rows = [logRow("96 Alice", 1000), logRow("96 Bob", 2000, { username: "=cmd()" }), logRow("96 Bob", 3000, { inquiry: [], amount: null })];
  const lines = toLoggedCsv(rows).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  assert.equal(lines[0], "Agent,Date logged (MYT),Player username,Brand,Inquiry,Status,Released amount,Missing,Chat link,QA verdict,QA note");
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]), ["96 Bob", "96 Bob", "96 Alice"]);
  assert.equal(lines[1], "96 Bob,1970-01-01 08:00,p3000,VS96,,Done,,No inquiry,https://my.livechatinc.com/archives/T3000,,", "newest first, a missing amount stays empty");
  assert.ok(lines[2].includes(",'=cmd(),"), "a typed value that looks like a formula is defused");
});

test("reading what agents logged pages through the table and leaves out the rows of the built-in excluded logins", async () => {
  const hash = await emailHash("boss@x");
  ALWAYS_EXCLUDED_HASHES.add(hash);
  try {
    const asked = [];
    const step = async (body) => {
      asked.push(body.step + ":" + (body.pageToken || ""));
      if (body.step === "agents") return { ok: true, agents: [{ email: "a@x", name: "96 Alice" }, { email: "boss@x", name: "The Boss" }] };
      if (body.step === "logged") return body.pageToken ? { ok: true, rows: [logRow("96 Alice", 3)], next: "", scanned: 1 } : { ok: true, rows: [logRow("96 Alice", 1), logRow("the boss", 2)], next: "p2", scanned: 2 };
      throw new Error("unexpected " + body.step);
    };
    const progress = [];
    const read = await loadLogged({ step, fromMs: 0, toMs: 10, onProgress: (n) => progress.push(n) });
    assert.deepEqual(read.rows.map((r) => r.agent), ["96 Alice", "96 Alice"], "the excluded agent name matches without letter case");
    assert.deepEqual(asked, ["agents:", "logged:", "logged:p2"]);
    assert.deepEqual(progress, [2, 3]);
    await assert.rejects(() => loadLogged({ step, fromMs: 0, toMs: 10, isCancelled: () => true }), (e) => e.cancelled === true);
  } finally {
    ALWAYS_EXCLUDED_HASHES.delete(hash);
  }
});

const unrecorded = (threadId, email, date, extra = {}) => ({ threadId, chatId: 'C-' + threadId, email, date, customer: 'Z', account: 'lc1', agentMessages: 2, customerMessages: 1, ...extra });
const byEmail = new Map([['a@x', '96 Alice'], ['b@x', '96 Bob']]);

test('each unrecorded chat is marked ticked Unknown, ticked automatically, left without ticking, or too old to judge', () => {
  const since = 1000;
  const ticks = [
    { threadId: 'T1', chatId: 'C-T1', agent: '96 alice', source: 'manual', at: 1500 },
    { threadId: 'T2', chatId: 'C-T2', agent: '96  Alice', source: 'auto', at: 1600 },
    { threadId: '', chatId: 'C-T5', agent: '96 Bob', source: 'manual', at: 1700 },
    { threadId: 'T6', chatId: 'C-T6', agent: '96 Alice', source: 'manual', at: 1800 },
  ];
  const entries = [
    unrecorded('T1', 'a@x', 1500), unrecorded('T2', 'a@x', 1600), unrecorded('T3', 'a@x', 1700),
    unrecorded('T4', 'a@x', 500), unrecorded('T5', 'b@x', 1750), unrecorded('T6', 'b@x', 1800),
  ];
  classifyEntries(entries, { ticks, configured: true, since }, byEmail);
  assert.deepEqual(entries.map((e) => e.mark), ['ticked', 'ticked-auto', 'not-ticked', 'untracked', 'ticked', 'not-ticked'],
    'T3 was left; T4 is older than tracking; T5 was ticked before the thread was known (matched by chat id); T6 was ticked by Alice, not by Bob');
  assert.deepEqual(countMarks(entries), { ticked: 3, notTicked: 2, untracked: 1 });
  assert.ok(Object.keys(MARK_LABELS).every((mark) => MARK_LABELS[mark]));
});

test('with tick tracking not set up, or nobody ticked yet, nothing is claimed: every chat is "before tracking"', () => {
  for (const data of [{ ticks: [], configured: false, since: 0 }, { ticks: [], configured: true, since: 0 }]) {
    const entries = [unrecorded('T1', 'a@x', 5000)];
    classifyEntries(entries, data, byEmail);
    assert.equal(entries[0].mark, 'untracked');
  }
});

test('the ticks are read page after page until the list is complete', async () => {
  const pages = { '': { ok: true, configured: true, ticks: [{ threadId: 'T1', agent: 'A' }], next: 'c2', since: 7 }, c2: { ok: true, configured: true, ticks: [{ threadId: 'T2', agent: 'A' }], next: '', since: 7 } };
  const asked = [];
  const read = await loadTicks(async (body) => { asked.push(body.cursor); return pages[body.cursor]; });
  assert.deepEqual(asked, ['', 'c2']);
  assert.deepEqual(read.ticks.map((t) => t.threadId), ['T1', 'T2']);
  assert.deepEqual([read.configured, read.since], [true, 7]);
  assert.deepEqual(await loadTicks(async () => ({ ok: true, configured: false, ticks: [], next: '', since: 0 })), { ticks: [], configured: false, since: 0 });
  await assert.rejects(() => loadTicks(async () => ({ ok: false, error: 'boom' })), /ticks: boom/);
});

test("the QA page uses its own calendar, not the browser's date input; weeks start on Monday and always show 6 rows", () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /type="date"/);
  const october = calendarDays(2026, 9); // 1 Oct 2026 is a Thursday
  assert.equal(october.length, 42);
  assert.deepEqual([october[0].year, october[0].month, october[0].day, october[0].otherMonth], [2026, 8, 28, true], 'the first cell is Monday 28 Sep');
  assert.deepEqual(october.filter((d) => !d.otherMonth).map((d) => d.day), Array.from({ length: 31 }, (_, i) => i + 1));
  const monday = calendarDays(2026, 5); // 1 Jun 2026 is a Monday: no days of May in front
  assert.deepEqual([monday[0].month, monday[0].day, monday[0].otherMonth], [5, 1, false]);
  assert.equal(displayDate('2026-10-07'), '07/10/2026');
  assert.equal(displayDate(''), '');
});

test('by default nobody is hidden: the admin\'s own logins show in the unknown-chats list and the logged-chats list', async () => {
  const scan = await scanChats({ step: site([archive('T1', ['a@x', 'me@x'])]), fromMs: 0, toMs: 10, windowMs: 10 });
  assert.equal(scan.alwaysExcluded.size, 0);
  assert.deepEqual(planAll(scan).map((e) => e.email).sort(), ['a@x', 'me@x']);
  const step = async (body) => (body.step === 'agents' ? { ok: true, agents: [{ email: 'me@x', name: 'Admin' }] } : { ok: true, rows: [logRow('Admin', 1)], next: '', scanned: 1 });
  assert.deepEqual((await loadLogged({ step, fromMs: 0, toMs: 10 })).rows.map((r) => r.agent), ['Admin']);
});

test('"Before tracking" chats older than 15 Oct are dropped for the listed logins only; their newer chats, other chats and everyone else\'s stay', async () => {
  assert.equal(HIDE_UNTRACKED_HASHES.size, 2);
  for (const hash of HIDE_UNTRACKED_HASHES) assert.match(hash, /^[0-9a-f]{64}$/);
  const hash = await emailHash('boss@x');
  HIDE_UNTRACKED_HASHES.add(hash);
  try {
    const old = HIDE_UNTRACKED_BEFORE - 1;
    const entries = [
      { threadId: 'T1', email: 'boss@x', mark: 'untracked', date: old },
      { threadId: 'T2', email: 'boss@x', mark: 'not-ticked', date: old },
      { threadId: 'T3', email: 'boss@x', mark: 'ticked', date: old },
      { threadId: 'T4', email: 'a@x', mark: 'untracked', date: old },
      { threadId: 'T5', email: 'boss@x', mark: 'untracked', date: HIDE_UNTRACKED_BEFORE },
      { threadId: 'T6', email: 'boss@x', mark: 'untracked', date: HIDE_UNTRACKED_BEFORE + 86_400_000 },
    ];
    assert.deepEqual((await dropOwnUntracked(entries)).map((e) => e.threadId), ['T2', 'T3', 'T4', 'T5', 'T6'], 'from 15 Oct 00:00 (Malaysia) on, nothing of theirs is hidden');
    assert.equal(HIDE_UNTRACKED_BEFORE, Date.UTC(2026, 9, 14, 16, 0, 0));
  } finally {
    HIDE_UNTRACKED_HASHES.delete(hash);
  }
});

// ---- saved results ----------------------------------------------------------------------------------------------------------

test('the saved-results store keeps a value until it expires, hands out copies, and can be emptied', async () => {
  let clock = 1000;
  const cache = createCache({ useDb: false, now: () => clock });
  await cache.set('k', { list: [1, 2] }, 500);
  const first = await cache.get('k');
  first.list.push(3);
  assert.deepEqual(await cache.get('k'), { list: [1, 2] }, 'a caller cannot change what is saved');
  clock = 1499;
  assert.ok(await cache.get('k'));
  clock = 1500;
  assert.equal(await cache.get('k'), undefined, 'expired');
  await cache.set('j', 1, 500);
  await cache.clear();
  assert.equal(await cache.get('j'), undefined);
  assert.equal(await cache.get('never'), undefined);
});

test('time windows sit on a fixed grid, so another start date reuses the windows an earlier search saved', () => {
  assert.deepEqual(alignedWindows(25, 55, 10), [[20, 30], [30, 40], [40, 50], [50, 55]]);
  assert.deepEqual(alignedWindows(20, 30, 10), [[20, 30]]);
});

const longAgo = () => Date.now() - 5 * 24 * 3_600_000; // well past the "settled" time
function archiveSite(chatsByWindow, counters) {
  return async (body) => {
    if (body.step === 'recorded') { counters.recorded += 1; return { ok: true, threads: [], pairs: [], next: '', rows: 3 }; }
    if (body.step === 'agents') return { ok: true, agents: [{ email: 'a@x', name: '96 Alice' }] };
    if (body.step === 'archives') {
      counters.archives += 1;
      return { ok: true, chats: body.account === 'lc1' ? (chatsByWindow[body.from] || []) : [], pending: [], outreach: body.account === 'lc1' ? 1 : 0, next: '' };
    }
    throw new Error('unexpected ' + body.step);
  };
}

test('a second search reuses saved windows of settled time and the saved table read; a recent window is always read again; "read again" ignores it all', async () => {
  const step = 10 * 3_600_000;
  const base = Math.floor(longAgo() / step) * step;
  const chat = (id, date) => ({ chatId: 'C' + id, threadId: id, date, customer: 'Z', writers: ['a@x'], counts: { 'a@x': 2 }, customerMessages: 1 });
  const chatsByWindow = { [base]: [chat('OLD1', base + 5), chat('OLD2', base + 9)] };
  const cache = createCache({ useDb: false });
  const first = { recorded: 0, archives: 0 };
  const toMs = base + step;
  const one = await scanChats({ step: archiveSite(chatsByWindow, first), fromMs: base, toMs, windowMs: step, cache });
  assert.deepEqual([first.recorded, first.archives], [1, 2], 'both accounts read for the first time');
  const second = { recorded: 0, archives: 0 };
  const two = await scanChats({ step: archiveSite(chatsByWindow, second), fromMs: base, toMs, windowMs: step, cache });
  assert.deepEqual([second.recorded, second.archives], [0, 0], 'nothing asked: windows and the table read come from the saved results');
  assert.deepEqual([...two.results[0].chats.keys()].sort(), ['OLD1', 'OLD2']);
  assert.equal(two.results[0].outreach, 1);
  assert.equal(two.results[0].fromSaved, 1);
  assert.deepEqual(planAll(two).map((e) => e.threadId).sort(), planAll(one).map((e) => e.threadId).sort(), 'the same answer');

  const third = { recorded: 0, archives: 0 };
  await scanChats({ step: archiveSite(chatsByWindow, third), fromMs: base, toMs, windowMs: step, cache, fresh: true });
  assert.deepEqual([third.recorded, third.archives], [1, 2], 'fresh reads everything again');

  // A window that ended minutes ago is not settled: it is not saved and not reused.
  const recent = { recorded: 0, archives: 0 };
  const cache2 = createCache({ useDb: false });
  const recentFrom = Math.floor(Date.now() / step) * step;
  await scanChats({ step: archiveSite({}, recent), fromMs: recentFrom, toMs: Date.now(), windowMs: step, cache: cache2 });
  await scanChats({ step: archiveSite({}, recent), fromMs: recentFrom, toMs: Date.now(), windowMs: step, cache: cache2 });
  assert.equal(recent.archives, 4, 'both accounts, both times');
});

test('chats older than the start date, from the grid\'s first window, are dropped', async () => {
  const step = 10;
  const chat = (id, date) => ({ chatId: 'C' + id, threadId: id, date, customer: 'Z', writers: ['a@x'], counts: { 'a@x': 2 }, customerMessages: 1 });
  const counters = { recorded: 0, archives: 0 };
  const scan = await scanChats({ step: archiveSite({ 20: [chat('BEFORE', 22), chat('AFTER', 28), chat('UNDATED', 0)] }, counters), fromMs: 25, toMs: 30, windowMs: step });
  assert.deepEqual([...scan.results[0].chats.keys()].sort(), ['AFTER', 'UNDATED']);
});

test('what agents logged: a saved read serves any agent choice; the choice only filters, by name without letter case', async () => {
  const rows = [logRow('96 Alice', 1), logRow('96 Bob', 2), logRow('96 BOB', 3)];
  let reads = 0;
  const step = async (body) => {
    if (body.step === 'agents') return { ok: true, agents: [] };
    reads += 1;
    return { ok: true, rows, next: '', scanned: 3 };
  };
  const cache = createCache({ useDb: false });
  const all = await loadLogged({ step, fromMs: 0, toMs: 10, cache, cacheKey: '2026-10-01:now' });
  const bob = await loadLogged({ step, fromMs: 0, toMs: 10, only: ['96 bob'], cache, cacheKey: '2026-10-01:now' });
  assert.deepEqual([all.rows.length, bob.rows.length, reads, all.fromSaved, bob.fromSaved], [3, 2, 1, false, true]);
  await loadLogged({ step, fromMs: 0, toMs: 10, cache, cacheKey: '2026-10-01:now', fresh: true });
  assert.equal(reads, 2);
  assert.equal((await loadLogged({ step, fromMs: 0, toMs: 10, only: ['Nobody'] })).rows.length, 0);
});

// ---- who to check -----------------------------------------------------------------------------------------------------------

test('the agents to choose from are the Agent Logins names, A to Z, with every login of a name; the button says what is chosen', () => {
  const choices = agentChoices([
    { email: 'B2@x', name: '96  Bob' }, { email: 'a@x', name: '96 Alice' }, { email: 'b1@x', name: '96 bob' }, { email: '', name: 'No email' }, { email: 'z@x', name: '' },
  ]);
  assert.deepEqual(choices, [{ name: '96 Alice', emails: ['a@x'] }, { name: '96 Bob', emails: ['b2@x', 'b1@x'] }]);
  assert.equal(pickerLabel([], 12), 'All agents (12)');
  assert.equal(pickerLabel([], 0), 'All agents');
  assert.equal(pickerLabel(['96 Alice'], 12), '96 Alice');
  assert.equal(pickerLabel(['A', 'B', 'C'], 12), '3 agents');
});

test('only the chosen agents are listed as unknown chats, whatever else is going on; nothing chosen lists everybody', async () => {
  const scan = await scanChats({ step: site([archive('T1', ['a@x']), archive('T2', ['me@x']), archive('T3', ['a@x', 'me@x'])]), fromMs: 0, toMs: 10, windowMs: 10 });
  assert.deepEqual(planAll(scan, { only: ['ME@x'] }).map((e) => e.threadId).sort(), ['T2', 'T3']);
  assert.deepEqual(planAll(scan, { only: ['a@x'] }).map((e) => e.threadId).sort(), ['T1', 'T3']);
  assert.equal(planAll(scan, { only: null }).length, 4);
  assert.equal(planAll(scan, { only: [] }).length, 0, 'an empty list of emails is a choice of nobody (the page passes null for "everybody")');
});

// ---- ticked Unknown although a username was on file -------------------------------------------------------------------------

test('a chat ticked Unknown by hand whose customer already had a username on file is marked with it; automatic ticks and untouched chats are not asked', async () => {
  const entries = [
    { threadId: 'T1', chatId: 'CA', mark: 'ticked' }, { threadId: 'T2', chatId: 'CA', mark: 'ticked' }, { threadId: 'T3', chatId: 'CB', mark: 'ticked' },
    { threadId: 'T4', chatId: 'CC', mark: 'ticked-auto' }, { threadId: 'T5', chatId: 'CD', mark: 'not-ticked' }, { threadId: 'T6', chatId: 'CE', mark: 'ticked' },
  ];
  const asked = [];
  const step = async (body) => {
    asked.push(body.chatId);
    if (body.chatId === 'CA') return { ok: true, found: true, username: 'player-one' };
    if (body.chatId === 'CE') return { ok: false, error: 'Lark said no' };
    return { ok: true, found: false, username: '' };
  };
  const cache = createCache({ useDb: false });
  const progress = [];
  const result = await checkKnownUsernames(entries, step, { cache, onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(asked.sort(), ['CA', 'CB', 'CE'], 'one question per chat, only for hand-ticked chats');
  assert.deepEqual(result, { checked: 3, found: 1, failed: 1 });
  assert.deepEqual(entries.map((e) => e.knownUsername), ['player-one', 'player-one', undefined, undefined, undefined, undefined]);
  assert.equal(progress.at(-1)[1], 3);

  const again = [];
  await checkKnownUsernames(entries.map((e) => ({ ...e })), async (body) => { again.push(body.chatId); return { ok: true, found: false }; }, { cache });
  assert.deepEqual(again, ['CE'], 'answers are saved (a failed one is asked again)');
  await assert.rejects(() => checkKnownUsernames(entries, step, { isCancelled: () => true }), (e) => e.cancelled === true);
});

test('the QA page carries the new controls: who to check, read again, the username filter', () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  for (const id of ['agentPicker', 'fresh', 'onlyKnownUser']) assert.match(page, new RegExp('id="' + id + '"'));
  const csv = toCsv([{ threadId: 'T', chatId: 'C', email: 'a@x', date: 1, customer: 'Z', account: 'lc1', mark: 'ticked', knownUsername: 'player-one' }], new Map());
  assert.ok(csv.includes('Ticked Unknown,player-one,,'), 'the sheet has the username already on file');
});

test('a person marked QA sees the QA tab only: no Retention, Blast, Tickets or Knowledge, no agent badge, and the QA page opens first', () => {
  const qa = tabs({ previewMode: false, activeMainTab: 'customer', qaView: true });
  assert.equal(qa.context.activeMainTab, 'unknownChats', 'a remembered Retention tab falls back to QA');
  assert.deepEqual(['unknownChatsTab', 'ticketsTab', 'knowledgeTab', 'retentionTab', 'blastTab'].map((id) => qa.els[id].hidden), [false, true, true, true, true]);
  assert.equal(qa.els.unknownChatsView.hidden, false);
  assert.equal(qa.frame.src, '/qa/index.html');
  assert.equal(qa.els.chatList.hidden, true);
  assert.equal(qa.els.agentBadge.hidden, true);
  for (const remembered of ['knowledge', 'tickets']) assert.equal(tabs({ previewMode: false, activeMainTab: remembered, qaView: true }).context.activeMainTab, 'unknownChats', remembered + ' is not available to QA yet');
  const blast = tabs({ previewMode: false, activeMainTab: 'blast', qaView: true });
  assert.equal(blast.context.activeMainTab, 'unknownChats', 'Blast is not available to QA');
});

test('every other agent in the installed widget is unchanged by the QA view: Retention and Blast as before, no QA tab, badge untouched', () => {
  const agent = tabs({ previewMode: false, activeMainTab: 'customer', qaView: false });
  assert.deepEqual(['unknownChatsTab', 'retentionTab', 'blastTab', 'ticketsTab', 'knowledgeTab'].map((id) => agent.els[id].hidden), [true, false, false, true, true]);
  assert.equal(agent.els.agentBadge.hidden, false);
});

test('the QA view is wired in the widget: on by default, with an off switch, Tickets and Knowledge held back, and it skips the agent-name step and the settings name panel', () => {
  assert.match(app, /const QA_VIEW_LIVE = new URLSearchParams\(location\.search\)\.get\("qaView"\) !== "0";/);
  assert.match(app, /&& !selectedAgent && !qaView\) \{\s*\n\s*\/\/ Give the agent-name list a short chance/, 'boot does not force the agent-name panel on a QA person');
  assert.match(app, /const customerService = isCustomerServiceView\(\) \|\| qaView;/);
  assert.match(app, /const QA_VIEW_ALSO_TICKETS_AND_KNOWLEDGE = false;/, 'Tickets and Knowledge are not live for QA yet');
  assert.match(app, /\.get\("department"\)/, 'the department views are untouched');
  assert.match(app, /const DEPARTMENT_TABS_LIVE = false;/, 'the department switch stays off');
});

// ---- one chat -------------------------------------------------------------------------------------------------------------

const fn2 = (name) => app.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0];

test('a thread id is found in a pasted chat link, archive link or the bare id; anything else is refused', () => {
  assert.equal(threadFromInput('https://my.livechatinc.com/archives/THREAD_9-x'), 'THREAD_9-x');
  assert.equal(threadFromInput('  https://my.livechatinc.com/chats/CHAT1/THREAD2?foo=1 '), 'THREAD2', 'the second id of a live chat link is the thread');
  assert.equal(threadFromInput('ABC123'), 'ABC123');
  assert.equal(threadFromInput('ab'), '');
  assert.equal(threadFromInput('not a link'), '');
  assert.equal(threadFromInput(''), '');
  assert.equal(threadFromInput(undefined), '');
});

test('one chat is described as logged, logged with something missing, ticked Unknown only, or nothing at all', () => {
  const row = (agent, extra = {}) => ({ agent, createdAt: 1000, username: 'p1', brand: 'VS96', inquiry: ['Free Spin'], status: 'Done', amount: 5, link: 'l', ...extra });
  const logged = describeChatLog({ rows: [row('96 Alice')], ticks: [], tracking: { configured: true, since: 5 } });
  assert.deepEqual([logged.verdict, logged.headline, logged.note], ['logged', 'Logged by 96 Alice', '']);
  const incomplete = describeChatLog({ rows: [row('96 Alice', { status: '' }), row('96 Bob')], ticks: [] });
  assert.equal(incomplete.verdict, 'incomplete');
  assert.match(incomplete.headline, /something is missing: 96 Alice, 96 Bob/);
  assert.deepEqual(incomplete.rows[0].issues, ['No status']);
  const ticked = describeChatLog({ rows: [], ticks: [{ agent: '96 Carl', source: 'manual', at: 9 }, { agent: '96 Carl', source: 'auto', at: 10 }] });
  assert.equal(ticked.verdict, 'ticked');
  assert.match(ticked.headline, /96 Carl ticked Unknown player on this chat/);
  assert.deepEqual(ticked.ticks.map((t) => t.label), ['ticked by the agent', 'automatic: the Look up said not VIP']);
  const nothing = describeChatLog({ rows: [], ticks: [], tracking: { configured: true, since: Date.UTC(2026, 9, 14, 16, 0) } });
  assert.equal(nothing.verdict, 'nothing');
  assert.match(nothing.note, /only recorded from 2026-10-15 00:00 \(Malaysia time\)/);
  assert.match(describeChatLog({ rows: [], ticks: [], tracking: { configured: false, since: 0 } }).note, /not being recorded yet/);
  const both = describeChatLog({ rows: [row('96 Alice')], ticks: [{ agent: '96 Bob', source: 'manual', at: 3 }] });
  assert.equal(both.verdict, 'logged');
  assert.equal(both.ticks.length, 1, 'a tick by another agent still shows beside the record');
});

test('the QA page has a read-only card for the open chat, and the two reports are folded under Reports', () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  for (const id of ['chatCard', 'chatForm', 'chatInput', 'chatResult']) assert.match(page, new RegExp('id="' + id + '"'));
  const reports = page.slice(page.indexOf('<details id="reports"'), page.indexOf('</details>', page.indexOf('id="unknownPanel"')) + 10);
  assert.ok(reports.includes('id="form"') && reports.includes('id="loggedPanel"') && reports.includes('id="unknownPanel"'), 'both reports sit inside Reports');
  assert.ok(page.indexOf('id="chatCard"') < page.indexOf('<details id="reports"'), 'the chat comes first, the reports at the bottom');
  assert.doesNotMatch(page.slice(page.indexOf('id="chatCard"'), page.indexOf('<details id="reports"')), /<textarea|type="checkbox"/, 'nothing to edit in the chat card');
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  assert.match(script, /type="checkbox" disabled/, 'the Unknown player box on the card is disabled');
  assert.doesNotMatch(script, /<input type="text"|<select|<textarea/, 'the cards have no fields to type in');
  assert.match(script, /source: "ca-qa-ready"/);
  assert.match(script, /event\.data\?\.source !== "ca-qa-chat"/);
});

test('the widget tells the QA page which chat is open, remembers it for a page that loads later, and answers its ready message; only for the chat of this window', () => {
  const sent = [];
  const frame = { contentWindow: { postMessage: (message, origin) => sent.push([message, origin]) } };
  const listeners = [];
  const context = vm.createContext({
    String, qaView: true, location: { origin: 'https://app.test' },
    document: { querySelector: (selector) => (selector === '#unknownChatsView iframe' ? frame : null) },
    window: { addEventListener: (type, fn) => listeners.push([type, fn]) },
  });
  vm.runInContext([app.match(/let qaOpenChat = "";[^\n]*/)[0], fn2('postQaChat'), fn2('reportQaChat'), app.match(/window\.addEventListener\("message", \(event\) => \{\s*\n\s*if \(event\.origin === location\.origin && event\.data && event\.data\.source === "ca-qa-ready"\) postQaChat\(\);\s*\n\}\);/)[0]].join('\n'), context);
  const open = (profile) => vm.runInContext('reportQaChat(' + JSON.stringify(profile) + ')', context);
  open({ source: 'archives', chat: { id: 'THREAD1' } });
  open({ source: 'archives', chat: { id: 'THREAD1' } });
  open({ source: 'chats', chat: { id: 'THREAD2' } });
  open({ source: 'customers', chat: { id: 'IGNORED' } });
  open(null);
  assert.deepEqual(sent.map(([m]) => m.threadId), ['THREAD1', 'THREAD2', ''], 'a repeat is not sent again; the Customers section and no profile mean no chat');
  assert.ok(sent.every(([m, origin]) => m.source === 'ca-qa-chat' && origin === 'https://app.test'));
  open({ source: 'chats', chat: { id: 'THREAD3' } });
  sent.length = 0;
  const ready = listeners.find(([type]) => type === 'message')[1];
  ready({ origin: 'https://evil.test', data: { source: 'ca-qa-ready' } });
  ready({ origin: 'https://app.test', data: { source: 'something-else' } });
  assert.equal(sent.length, 0, 'only the ready message from this site is answered');
  ready({ origin: 'https://app.test', data: { source: 'ca-qa-ready' } });
  assert.equal(sent[0][0].threadId, 'THREAD3');
  vm.runInContext('qaView = false', context);
  sent.length = 0;
  open({ source: 'chats', chat: { id: 'THREAD4' } });
  assert.equal(sent.length, 0, 'an agent who is not QA is never sent anything');
});

test('the admin preview stays the full admin view for a QA login, and shows the QA view only with ?department=qa; the installed widget follows the login', () => {
  const flag = (embedded, search) => vm.runInContext(app.match(/let qaView = ([^\n]+);/)[1], vm.createContext({ IS_EMBEDDED_APP: embedded, URLSearchParams, location: { search } }));
  assert.equal(flag(false, ''), false, 'preview: nothing forced');
  assert.equal(flag(false, '?department=rtn'), false);
  assert.equal(flag(false, '?department=qa'), true, 'preview: asked for the QA view');
  assert.equal(flag(true, '?department=qa'), false, 'the installed widget ignores the preview switch: only the login decides');
  assert.equal(flag(true, ''), false);
  assert.match(app, /if \(!QA_VIEW_LIVE \|\| !IS_EMBEDDED_APP\) return false;/, 'a QA login in the preview is not looked up');
  // The preview with ?department=qa shows the QA tab only, like the department views it sits beside.
  const forced = tabs({ previewMode: true, activeMainTab: 'customer', qaView: true });
  assert.deepEqual(['unknownChatsTab', 'retentionTab', 'blastTab', 'ticketsTab', 'knowledgeTab'].map((id) => forced.els[id].hidden), [false, true, true, true, true]);
  assert.equal(forced.context.activeMainTab, 'unknownChats');
  const normal = tabs({ previewMode: true, activeMainTab: 'customer', qaView: false });
  assert.deepEqual(['unknownChatsTab', 'retentionTab', 'blastTab'].map((id) => normal.els[id].hidden), [false, false, false], 'the preview shows everything, QA included');
});

test('the chat card shows the Claim Secret tick like the Retention card, read-only, and has no "open this chat" link', () => {
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  assert.match(script, /Claim Secret<\/div>\s*\n\s*<label class="rc-unknown"><input type="checkbox" disabled \$\{row\.claimSecret \? "checked" : ""\} \/><span>\$\{row\.claimSecret \? "✓ Ticked" : "— Not ticked"\}/);
  assert.doesNotMatch(script, /Open this chat in LiveChat/, 'QA is already in the chat');
});
