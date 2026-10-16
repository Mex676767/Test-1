import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { calendarDays, displayDate } from '../qa/datepicker.js';
import { buildExamples } from '../qa/examples.js';
import { pickerLabel } from '../qa/agentpicker.js';
import { agentChoices, checkClaim, checkKnownUsernames, describeChatLog, toCsv } from '../qa/scan.js';
import { ALWAYS_EXCLUDED_HASHES, HIDE_UNTRACKED_BEFORE, HIDE_UNTRACKED_HASHES, dropOwnUntracked, MARK_LABELS, classifyEntries, countMarks, emailHash, loadTicks, loggedIssues, planAll, scanChats } from '../qa/scan.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0];

function tabs({ previewMode, activeMainTab, qaView = false, selectedAgent = '' }) {
  const element = (extra = {}) => ({ hidden: true, style: {}, ...extra });
  const frame = { src: '', dataset: { src: '/qa/index.html' } };
  const els = { unknownChatsTab: element(), unknownChatsView: element({ querySelector: () => frame }), chatList: element({ hidden: false }), mainTabs: element(), retentionTab: element(), ticketsTab: element(), blastTab: element(), knowledgeTab: element(), agentBadge: element({ hidden: false }) };
  const context = vm.createContext({
    activeMainTab, previewMode, qaView, QA_VIEW_ALSO_TICKETS_AND_KNOWLEDGE: false, blastRunInProgress: false, selectedAgent, DEPARTMENT_TABS_LIVE: false, BLAST_LIVE: false, CONFIGURED_LIVECHAT_ACCOUNT: '',
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
  assert.equal(preview.frame.src, '/qa/index.html?preview=1', 'the admin preview opens the QA tab with example chats');

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
  assert.doesNotMatch(page, /signInBtn|Sign in with LiveChat|Access key|QA_KEY|SCAN_KEY/, 'the page has no sign-in of its own: the widget\'s Settings holds it');
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

test("what a logged case is missing is named", () => {
  assert.deepEqual(loggedIssues(logRow("A", 1)), []);
  assert.deepEqual(loggedIssues(logRow("A", 1, { inquiry: [], status: "", username: "", brand: "", link: "" })), ["No inquiry", "No status", "No username", "No brand", "No chat link"]);
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

test('by default nobody is hidden: the admin\'s own logins show in the unknown-chats list', async () => {
  const scan = await scanChats({ step: site([archive('T1', ['a@x', 'me@x'])]), fromMs: 0, toMs: 10, windowMs: 10 });
  assert.equal(scan.alwaysExcluded.size, 0);
  assert.deepEqual(planAll(scan).map((e) => e.email).sort(), ['a@x', 'me@x']);
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

test('nothing is saved between searches: every search reads the data again, there is no "saved results" or "read again" control', () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /id="fresh"|saved results|loggedPanel|data-mode/i, 'one report only, nothing saved');
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  const scan = readFileSync(new URL('../qa/scan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script + scan, /indexedDB|createCache|cache\.(get|set|clear)|fromSaved|saved results/);
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
  const progress = [];
  const result = await checkKnownUsernames(entries, step, { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(asked.sort(), ['CA', 'CB', 'CE'], 'one question per chat, only for hand-ticked chats');
  assert.deepEqual(result, { checked: 3, found: 1, failed: 1 });
  assert.deepEqual(entries.map((e) => e.knownUsername), ['player-one', 'player-one', undefined, undefined, undefined, undefined]);
  assert.equal(progress.at(-1)[1], 3);

  await assert.rejects(() => checkKnownUsernames(entries, step, { isCancelled: () => true }), (e) => e.cancelled === true);
});

test('the QA page carries the new controls: who to check and the username filter', () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  for (const id of ['agentPicker', 'onlyKnownUser']) assert.match(page, new RegExp('id="' + id + '"'));
  const csv = toCsv([{ threadId: 'T', chatId: 'C', email: 'a@x', date: 1, customer: 'Z', account: 'lc1', mark: 'ticked', knownUsername: 'player-one' }], new Map());
  assert.ok(csv.includes('Ticked Unknown,player-one,,'), 'the sheet has the username already on file');
});

test('a person marked QA sees the QA and Retention tabs (to cover chats), never Blast, Tickets or Knowledge; the QA page opens first', () => {
  const qa = tabs({ previewMode: false, activeMainTab: 'unknownChats', qaView: true });
  assert.deepEqual(['unknownChatsTab', 'ticketsTab', 'knowledgeTab', 'retentionTab', 'blastTab'].map((id) => qa.els[id].hidden), [false, true, true, false, true]);
  assert.equal(qa.els.unknownChatsView.hidden, false);
  assert.equal(qa.frame.src, '/qa/index.html');
  assert.equal(qa.els.chatList.hidden, true);
  assert.equal(qa.els.agentBadge.hidden, true, 'no name and on the QA tab: no badge');
  const covering = tabs({ previewMode: false, activeMainTab: 'customer', qaView: true });
  assert.equal(covering.context.activeMainTab, 'customer', 'Retention stays open for a QA person');
  assert.equal(covering.els.chatList.hidden, false);
  assert.equal(covering.els.agentBadge.hidden, false, 'on Retention the badge shows, so a missing agent name is visible');
  assert.equal(tabs({ previewMode: false, activeMainTab: 'unknownChats', qaView: true, selectedAgent: '96 Edwin' }).els.agentBadge.hidden, false, 'a QA person with an agent name shows it');
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
  // The preview with ?department=qa shows the QA view like the installed widget: QA and Retention, no Blast, Tickets or Knowledge.
  const forced = tabs({ previewMode: true, activeMainTab: 'customer', qaView: true });
  assert.deepEqual(['unknownChatsTab', 'retentionTab', 'blastTab', 'ticketsTab', 'knowledgeTab'].map((id) => forced.els[id].hidden), [false, false, true, true, true]);
  assert.equal(forced.context.activeMainTab, 'customer', 'Retention stays open');
  const normal = tabs({ previewMode: true, activeMainTab: 'customer', qaView: false });
  assert.deepEqual(['unknownChatsTab', 'retentionTab', 'blastTab'].map((id) => normal.els[id].hidden), [false, false, false], 'the preview shows everything, QA included');
});

test('the QA tab is the open chat\'s card with the unknown-chats report folded under Reports; no sign-in, no paste box, no "what agents logged" report', () => {
  const page = readFileSync(new URL('../qa/index.html', import.meta.url), 'utf8');
  assert.ok(page.indexOf('id="chatResult"') > -1 && page.indexOf('id="chatResult"') < page.indexOf('<details id="reports"'), 'the card first, the report at the bottom');
  const reports = page.slice(page.indexOf('<details id="reports"'));
  assert.ok(reports.includes('id="form"') && reports.includes('id="results"'), 'the unknown-chats report sits inside Reports');
  assert.doesNotMatch(page, /chatForm|chatInput|id="signin|loggedPanel|loggedResults|data-mode|<h1/, 'nothing else on the page');
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /authorize\(|signIn|window\.open|loadLogged|toLoggedCsv|threadFromInput|\$\("key"\)/, 'no sign-in code, no logged report, no scan key');
  assert.match(script, /source: "ca-qa-ready"/);
  assert.match(script, /event\.data\?\.source !== "ca-qa-chat"/);
  assert.doesNotMatch(script + page, /<input type="text"|<select|<textarea|type="checkbox" disabled/, 'nothing on the card to type in or tick');
});

test('the card for a logged case is a tidy read-only grid: agent and time, username, brand, inquiry, status, amount, Claim Secret; missing values are called out', () => {
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  const card = script.slice(script.indexOf('function loggedCard'), script.indexOf('// An agent ticked Unknown player'));
  for (const label of ['Username', 'Brand', 'Inquiry', 'Status', 'Released amount', 'Claim Secret']) assert.ok(card.includes(label), label);
  assert.match(card, /Not filled in/);
  assert.match(card, /row\.claimSecret \? "✓" : "—"/);
  assert.doesNotMatch(card, /Customer<\/div>|Case details|VIEW ONLY|<input/, 'no boxes inside boxes, nothing to edit');
});

// ---- the bonus the agent claimed, against what they logged ----------------------------------------------------------------

const claimOf = (extra = {}) => ({ agent: '96 Alice', program: 'topPnl', label: 'Top 10 P&L', source: 'Pass RM18', inquiry: 'TOP P&L', amount: '18', at: 5, ...extra });
const loggedRow = (extra = {}) => ({ agent: '96 Alice', createdAt: 1000, username: 'p1', brand: 'VS96', inquiry: ['TOP P&L'], status: 'Given', amount: 18, link: 'l', ...extra });

test('a claim is checked against the logged inquiry (the claimed bonus tag is among them) and amount (the first number), with nothing compared when the bonus implies none', () => {
  assert.deepEqual(checkClaim(claimOf(), loggedRow()), { expectedAmount: 18, inquiryOk: true, amountOk: true });
  assert.deepEqual(checkClaim(claimOf(), loggedRow({ inquiry: ['Others'] })), { expectedAmount: 18, inquiryOk: false, amountOk: true });
  assert.equal(checkClaim(claimOf(), loggedRow({ amount: 20 })).amountOk, false);
  assert.equal(checkClaim(claimOf(), loggedRow({ amount: null })).amountOk, false, 'a bonus with an amount but none logged is wrong');
  assert.equal(checkClaim(claimOf(), loggedRow({ inquiry: ['top p&l ', 'Feedback'] })).inquiryOk, true, 'letter case and spaces do not matter, other tags are fine');
  assert.equal(checkClaim(claimOf({ amount: '18 | 20' }), loggedRow()).amountOk, true, 'several numbers: the first, as the record keeps one');
  assert.equal(checkClaim(claimOf({ amount: 18.5 }), loggedRow({ amount: 18.5 })).amountOk, true);
  const none = checkClaim(claimOf({ program: 'redeemCode', inquiry: '', amount: '' }), loggedRow({ amount: null, inquiry: [] }));
  assert.deepEqual(none, { expectedAmount: null, inquiryOk: null, amountOk: null });
});

test('one chat with a claim: a matching log is fine, a wrong inquiry or amount makes the whole chat a mismatch that names the agent', () => {
  const ok = describeChatLog({ rows: [loggedRow()], ticks: [], claims: [claimOf()], tracking: { configured: true, since: 1, claimsSince: 1 } });
  assert.equal(ok.verdict, 'logged');
  assert.deepEqual(ok.rows[0].claims.map((c) => [c.label, c.inquiryOk, c.amountOk]), [['Top 10 P&L', true, true]]);
  const wrong = describeChatLog({ rows: [loggedRow({ amount: 20, inquiry: ['Others'] }), loggedRow({ agent: '96 Bob' })], ticks: [], claims: [claimOf(), claimOf({ agent: '96 Bob' })] });
  assert.equal(wrong.verdict, 'mismatch');
  assert.match(wrong.headline, /does not match the bonus claimed: 96 Alice$/);
  assert.deepEqual(wrong.rows[0].claims.map((c) => [c.inquiryOk, c.amountOk]), [[false, false]]);
  assert.deepEqual(wrong.rows[1].claims.map((c) => [c.inquiryOk, c.amountOk]), [[true, true]], 'Bob\'s own claim is checked against Bob\'s own record');
});

test('a claim by an agent who logged nothing is called out; Status Given without any claim on record says why nothing could be compared', () => {
  const orphan = describeChatLog({ rows: [], ticks: [], claims: [claimOf()] });
  assert.equal(orphan.verdict, 'mismatch');
  assert.match(orphan.headline, /96 Alice claimed a bonus on this chat but logged nothing/);
  assert.equal(orphan.orphanClaims.length, 1);
  const mixed = describeChatLog({ rows: [loggedRow()], ticks: [], claims: [claimOf(), claimOf({ agent: '96 Cara' })] });
  assert.equal(mixed.verdict, 'mismatch', 'an agent who claimed and logged nothing counts even when another agent logged');
  assert.match(mixed.headline, /does not match the bonus claimed: 96 Cara$/);
  const since = Date.UTC(2026, 9, 14, 16, 0);
  const noClaim = describeChatLog({ rows: [loggedRow()], ticks: [], claims: [], tracking: { configured: true, since: 1, claimsSince: since } });
  assert.equal(noClaim.verdict, 'logged');
  assert.match(noClaim.note, /Status is Given but no bonus claim was recorded for this agent\. Claims are only recorded from 2026-10-15 00:00/);
  assert.match(describeChatLog({ rows: [loggedRow()], ticks: [], claims: [], tracking: { configured: false, since: 0 } }).note, /claims are not being recorded yet/);
  assert.equal(describeChatLog({ rows: [loggedRow({ status: 'Solved' })], ticks: [], claims: [] }).note, '', 'no bonus given, nothing to explain');
});

test('the card lists the bonus claimed with its source value and a tick or warning for the inquiry and the amount', () => {
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  const block = script.slice(script.indexOf('function claimsBlock'), script.indexOf('// One logged case'));
  for (const text of ['Bonus claimed', 'claim.label', 'claim.source', 'Inquiry should be', 'Amount should be', 'No amount for this bonus']) assert.ok(block.includes(text), text);
  assert.match(script, /\$\{claimsBlock\(row\.claims \|\| \[\]\)\}/, 'each logged card shows its own agent\'s claims');
  assert.match(script, /function claimOnlyCard/);
});

test('the admin preview has example chats for the QA card: each one runs through the real description and gives the verdict it is meant to show', () => {
  const examples = buildExamples(Date.UTC(2026, 9, 14, 12, 0));
  assert.deepEqual(examples.map((e) => e.id), ['logged', 'mismatch', 'missing', 'ticked', 'claimed', 'nothing']);
  const verdicts = Object.fromEntries(examples.map((e) => [e.id, describeChatLog(e.data).verdict]));
  assert.deepEqual(verdicts, { logged: 'logged', mismatch: 'mismatch', missing: 'incomplete', ticked: 'ticked', claimed: 'mismatch', nothing: 'nothing' });
  const mismatch = describeChatLog(examples[1].data);
  assert.deepEqual(mismatch.rows[0].claims.map((c) => [c.inquiryOk, c.amountOk]), [[false, false]], 'the example shows both warnings');
  const logged = describeChatLog(examples[0].data);
  assert.deepEqual(logged.rows[0].claims.map((c) => [c.inquiryOk, c.amountOk]), [[true, true]]);
  assert.ok(examples.every((e) => !JSON.stringify(e.data).match(/@|password|token/i)), 'made-up data only');
});

test('the QA page shows the examples only when the admin preview asks for them (?preview=1), and then reads nothing from the server', () => {
  const script = readFileSync(new URL('../qa/qa.js', import.meta.url), 'utf8');
  assert.match(script, /new URLSearchParams\(location\.search\)\.get\("preview"\) === "1"/);
  const preview = script.slice(script.indexOf('// The admin preview (the QA tab opened with ?preview=1)'));
  const previewBranch = preview.slice(0, preview.indexOf('} else {'));
  assert.doesNotMatch(previewBranch, /resumeLogin|createClient|fetch\(/, 'the preview branch makes no request');
  assert.match(preview.slice(preview.indexOf('} else {')), /resumeLogin\(\)/, 'the real tab still signs in and reads');
  assert.match(script, /"ca-qa-chat" \|\| PREVIEW\) return;/, 'the preview ignores the open chat');
  assert.match(app, /frame\.dataset\.src \+ \(previewMode \? "\?preview=1" : ""\)/);
});

test('a QA login without an agent name can choose one: the picker can be skipped, and Settings offers it later', () => {
  assert.match(app, /function pickAgentName\(accountKey, token, available, \{ skippable = false \} = \{\}\)/);
  assert.match(app, /id="agentLoginSkip"/);
  assert.match(app, /\{ skippable: true \}\); \/\/ QA is part of the Retention team/);
  assert.match(app, /qaView && !selectedAgent \? `<button type="button" class="secondary-btn" id="settingsQaName">Choose my agent name<\/button>`/);
  assert.match(app, /async function chooseQaAgentName\(\)/);
});
