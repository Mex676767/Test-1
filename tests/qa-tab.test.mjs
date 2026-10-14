import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { calendarDays, displayDate } from '../qa/datepicker.js';
import { ALWAYS_EXCLUDED_HASHES, HIDE_UNTRACKED_HASHES, dropOwnUntracked, MARK_LABELS, classifyEntries, countMarks, emailHash, loadTicks, loadLogged, loggedIssues, planAll, scanChats, summarizeLogged, toLoggedCsv } from '../qa/scan.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0];

function tabs({ previewMode, activeMainTab }) {
  const element = (extra = {}) => ({ hidden: true, style: {}, ...extra });
  const frame = { src: '', dataset: { src: '/qa/index.html' } };
  const els = { unknownChatsTab: element(), unknownChatsView: element({ querySelector: () => frame }), chatList: element({ hidden: false }), mainTabs: element(), retentionTab: element(), ticketsTab: element(), blastTab: element(), knowledgeTab: element() };
  const context = vm.createContext({
    activeMainTab, previewMode, blastRunInProgress: false, DEPARTMENT_TABS_LIVE: false, BLAST_LIVE: false, CONFIGURED_LIVECHAT_ACCOUNT: '',
    mainTabAvailability: () => ({ customer: true, blast: false, tickets: false, knowledge: false }),
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

test('"Before tracking" chats are dropped for the listed logins only; their other chats and everyone else\'s stay', async () => {
  assert.equal(HIDE_UNTRACKED_HASHES.size, 2);
  for (const hash of HIDE_UNTRACKED_HASHES) assert.match(hash, /^[0-9a-f]{64}$/);
  const hash = await emailHash('boss@x');
  HIDE_UNTRACKED_HASHES.add(hash);
  try {
    const entries = [
      { threadId: 'T1', email: 'boss@x', mark: 'untracked' },
      { threadId: 'T2', email: 'boss@x', mark: 'not-ticked' },
      { threadId: 'T3', email: 'boss@x', mark: 'ticked' },
      { threadId: 'T4', email: 'a@x', mark: 'untracked' },
    ];
    assert.deepEqual((await dropOwnUntracked(entries)).map((e) => e.threadId), ['T2', 'T3', 'T4']);
  } finally {
    HIDE_UNTRACKED_HASHES.delete(hash);
  }
});
