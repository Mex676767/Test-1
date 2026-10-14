import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ALWAYS_EXCLUDED_HASHES, emailHash, loadLogged, loggedIssues, planAll, scanChats, summarizeLogged, toLoggedCsv } from '../qa/scan.js';

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
  assert.ok(ALWAYS_EXCLUDED_HASHES.size >= 1);
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
