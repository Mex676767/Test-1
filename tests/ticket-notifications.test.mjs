import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];

const NAMES = ['ticketNoteLoad', 'ticketNoteSave', 'ticketNotePeople', 'ticketNoteIsMine', 'ticketNoteLearnMe', 'ticketNoteRemember', 'ticketNoteSnapshot', 'ticketNoteAdd', 'ticketNoteSnippet', 'ticketNoteFlatten', 'ticketNoteStatusItem', 'ticketNoteDue', 'ticketNoteApplyThread', 'ticketNoteMarkRead', 'ticketNoteUnread', 'ticketNoteVisible', 'renderTicketBell', 'pollTicketNotifications', 'ticketNoteAbsorb', 'renderTicketNotesStatus', 'ticketPollBackoff'];
const SOURCE = [
  line(/const TICKET_NOTE_MAX = \d+;/), line(/const TICKET_NOTE_KEEP_SEEN = \d+;/), line(/const TICKET_NOTE_READS_PER_POLL = \d+;/),
  'let ticketNoteStore = null; let ticketNoteStoreKey = ""; let ticketNoteTab = "all"; let ticketBellOpen = false; let ticketNotePolling = false; let ticketNotePollRound = 0; let ticketNoteMineRefs = new Set(); let ticketPollPausedUntil = 0; let ticketNotePollInfo = { at: 0, watching: 0, error: "" };',
  ...NAMES.map(fn),
].join('\n');

const ME = { id: 7, name: 'Me', email: 'Me@Company.com' };
const OTHER = { id: 9, name: 'Ashton', email: 'ashton@company.com' };
const T0 = Date.parse('2026-10-19T10:00:00Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

function world({ fetchPlan, sound, preview = true, account = { status: 'found', email: ME.email }, checkResult } = {}) {
  const storage = new Map();
  const calls = { fetches: [], chimes: 0, repaints: 0, checks: [] };
  const context = vm.createContext({
    Date, JSON, Number, String, Boolean, Array, Object, Set, Math, Promise,
    currentLiveChatAccount: 'lc1',
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)) },
    document: { hidden: false },
    ticketAccount: { ...account }, previewMode: preview, DEPARTMENT_TABS_LIVE: false, state: { chat: {} },
    checkTicketAccount: async (chatId, options) => { calls.checks.push({ chatId, options }); if (checkResult) context.ticketAccount = { ...checkResult }; },
    ticketReadAuthor: () => ({ accountKey: 'lc1', agentToken: 'tok' }),
    ticketTitle: (ticket) => ticket.fields?.query_type || 'Ticket',
    ticketChoiceDisplayLabel: (_key, value) => value,
    ticketUiIcon: () => '<svg></svg>',
    ticketUpdatedLabel: () => '5 min ago',
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    repaintTicketBell: () => { calls.repaints += 1; },
    ticketNoteChime: () => { calls.chimes += 1; },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.fetches.push({ url, body });
      return { json: async () => fetchPlan(url, body) };
    },
  });
  vm.runInContext(SOURCE, context);
  if (sound === false) vm.runInContext('ticketNoteLoad().sound = false', context);
  return { calls, storage, run: (code) => vm.runInContext(code, context), context };
}

const ticket = (ref, extra = {}) => ({ ref, fields: { query_type: 'wd_delay', status: 'OPEN' }, raisedBy: OTHER, assignees: [], updatedAt: iso(0), commentCount: 0, comments: [], ...extra });
const comment = (id, author, minutes, extra = {}) => ({ id, author: { id: author.id, name: author.name }, body: `comment ${id}`, createdAt: iso(minutes), mentions: [], attachments: [], ...extra });
const setMe = (w) => w.run(`ticketNoteLoad().me.email = ${JSON.stringify(ME.email.toLowerCase())}`);
const items = (w) => JSON.parse(w.run('JSON.stringify(ticketNoteLoad().items)'));
const show = (w, list, now) => JSON.parse(JSON.stringify(w.run(`ticketNoteDue(ticketNoteLoad(), ${JSON.stringify(list)}, ${now})`)));
const apply = (w, one, now) => w.run(`ticketNoteApplyThread(ticketNoteLoad(), ${JSON.stringify(one)}, ${now})`);

test('the first look only records what is there: nothing is new yet', () => {
  const w = world();
  setMe(w);
  const out = show(w, [ticket('TK2610190001', { raisedBy: ME, commentCount: 3, updatedAt: iso(-5) })], T0);
  assert.deepEqual(out, { due: [], added: 0 });
  assert.equal(items(w).length, 0);
});

test('a comment from someone else on a ticket the agent raised notifies; their own comment does not', () => {
  const w = world();
  setMe(w);
  const before = ticket('TK2610190001', { raisedBy: ME, commentCount: 0, updatedAt: iso(0) });
  show(w, [before], T0);
  const after = ticket('TK2610190001', { raisedBy: ME, commentCount: 2, updatedAt: iso(5), comments: [comment(1, OTHER, 3), comment(2, ME, 4)] });
  const out = show(w, [after], T0 + 6 * 60_000);
  assert.deepEqual(out.due, ['TK2610190001'], 'its thread has to be read');
  assert.equal(apply(w, after, T0 + 6 * 60_000), 1);
  const [note] = items(w);
  assert.equal(note.kind, 'comment');
  assert.equal(note.by, 'Ashton');
  assert.equal(note.read, false);
  assert.equal(apply(w, after, T0 + 7 * 60_000), 0, 'reading the same thread again adds nothing');
});

test('a ticket is the agent\'s when it is assigned to them, or they commented on it through the widget; any other ticket is not', () => {
  const w = world();
  setMe(w);
  assert.equal(w.run(`ticketNoteIsMine(ticketNoteLoad(), ${JSON.stringify(ticket('TK1', { assignees: [ME] }))})`), true, 'assigned, email compared in lower case');
  assert.equal(w.run(`ticketNoteIsMine(ticketNoteLoad(), ${JSON.stringify(ticket('TK2'))})`), false);
  w.run('ticketNoteRemember("TK2", null)');
  assert.equal(w.run(`ticketNoteIsMine(ticketNoteLoad(), ${JSON.stringify(ticket('TK2'))})`), true, 'commented through the widget');
});

test('an @mention on a ticket that is not theirs notifies; a plain comment there does not', () => {
  const w = world();
  setMe(w);
  const start = ticket('TK2610190002', { raisedBy: ME, updatedAt: iso(0) });
  const stranger = ticket('TK2610190009', { updatedAt: iso(0) });
  show(w, [start, stranger], T0);
  const after = ticket('TK2610190009', { updatedAt: iso(8), commentCount: 2, comments: [comment(1, OTHER, 6), comment(2, OTHER, 7, { mentions: [{ userId: ME.id, name: 'Me' }] })] });
  w.run('ticketNoteLoad().me.id = 7');
  const out = show(w, [start, after], T0 + 9 * 60_000);
  assert.deepEqual(out.due, ['TK2610190009']);
  assert.equal(apply(w, after, T0 + 9 * 60_000), 1);
  const [note] = items(w);
  assert.equal(note.kind, 'mention');
  assert.equal(note.id, 'TK2610190009:c2');
});

test('a ticket that is not theirs is not read at all while their ticket-system id is still unknown', () => {
  const w = world();
  setMe(w);
  show(w, [ticket('TK2610190009', { updatedAt: iso(0) })], T0);
  const out = show(w, [ticket('TK2610190009', { updatedAt: iso(8), commentCount: 4 })], T0 + 9 * 60_000);
  assert.deepEqual(out.due, []);
});

test('the agent\'s id is learned from a ticket that names their email, so their own comments are then recognised', () => {
  const w = world();
  setMe(w);
  show(w, [ticket('TK2610190001', { raisedBy: ME })], T0);
  assert.equal(w.run('ticketNoteLoad().me.id'), 7);
});

test('a status change on their ticket notifies straight from the list, with no thread read', () => {
  const w = world();
  setMe(w);
  show(w, [ticket('TK2610190001', { raisedBy: ME })], T0);
  const out = show(w, [ticket('TK2610190001', { raisedBy: ME, updatedAt: iso(9), fields: { query_type: 'wd_delay', status: 'SOLVED' } })], T0 + 10 * 60_000);
  assert.deepEqual(out.due, []);
  assert.equal(out.added, 1);
  assert.equal(items(w)[0].kind, 'status');
  assert.match(items(w)[0].text, /Status changed to SOLVED/);
});

test('the tabs: All shows everything, Mentions only mentions, Comments comments and mentions; opening a ticket marks only its notes read', () => {
  const w = world();
  w.run(`const store = ticketNoteLoad();
    ticketNoteAdd(store, { id: 'a', ref: 'TK1', title: 't', kind: 'comment', by: 'x', text: 'c', at: 1 });
    ticketNoteAdd(store, { id: 'b', ref: 'TK2', title: 't', kind: 'mention', by: 'x', text: 'm', at: 2 });
    ticketNoteAdd(store, { id: 'c', ref: 'TK3', title: 't', kind: 'status', by: '', text: 's', at: 3 });`);
  const ids = (tab) => JSON.parse(w.run(`JSON.stringify(ticketNoteVisible(ticketNoteLoad(), "${tab}").map((item) => item.id))`));
  assert.deepEqual(ids('all'), ['c', 'b', 'a']);
  assert.deepEqual(ids('mentions'), ['b']);
  assert.deepEqual(ids('comments'), ['b', 'a']);
  assert.equal(w.run('ticketNoteUnread(ticketNoteLoad())'), 3);
  w.run('ticketNoteMarkRead("TK2")');
  assert.equal(w.run('ticketNoteUnread(ticketNoteLoad())'), 2);
  w.run('ticketNoteMarkRead("")');
  assert.equal(w.run('ticketNoteUnread(ticketNoteLoad())'), 0);
});

test('unread notifications are kept in this browser and come back after a reload', () => {
  const w = world();
  w.run(`ticketNoteAdd(ticketNoteLoad(), { id: 'a', ref: 'TK1', title: 't', kind: 'comment', by: 'x', text: 'c', at: 1 }); ticketNoteSave();`);
  const again = world();
  for (const [key, value] of w.storage) again.storage.set(key, value);
  assert.equal(again.run('ticketNoteUnread(ticketNoteLoad())'), 1);
  const other = world();
  other.run('currentLiveChatAccount = "lc2"');
  assert.equal(other.run('ticketNoteUnread(ticketNoteLoad())'), 0, 'another LiveChat account has its own');
});

test('the list is kept to the newest notifications', () => {
  const w = world();
  w.run(`for (let i = 0; i < 80; i++) ticketNoteAdd(ticketNoteLoad(), { id: 'n' + i, ref: 'TK1', title: 't', kind: 'comment', by: 'x', text: 'c', at: i });`);
  assert.equal(items(w).length, 60);
  assert.equal(items(w)[0].id, 'n79');
});

test('a deleted comment and a comment older than what was seen never notify', () => {
  const w = world();
  setMe(w);
  show(w, [ticket('TK2610190001', { raisedBy: ME, updatedAt: iso(0) })], T0);
  const after = ticket('TK2610190001', { raisedBy: ME, updatedAt: iso(9), commentCount: 3, comments: [comment(1, OTHER, -30), comment(2, OTHER, 5, { deleted: true }), comment(3, OTHER, 6, { replies: [comment(4, OTHER, 7)] })] });
  assert.equal(apply(w, after, T0 + 10 * 60_000), 2, 'the new comment and its reply');
});

test('polling: the first poll is silent; later news chimes once, reads at most three threads, and a muted bell stays quiet', async () => {
  const list = { tickets: [] };
  const w = world({
    fetchPlan: (url, body) => url === '/ticket-list' ? { ok: true, tickets: list.tickets }
      : { ok: true, ticket: { ...list.tickets.find((t) => t.ref === body.ref), comments: [comment(Number(body.ref.slice(-1)), OTHER, 30)] } },
  });
  const mine = (n, extra = {}) => ticket(`TK261019000${n}`, { raisedBy: ME, updatedAt: iso(0), ...extra });
  list.tickets = [mine(1), mine(2), mine(3), mine(4), mine(5)];
  await w.run('pollTicketNotifications()');
  assert.equal(w.calls.chimes, 0, 'nothing is new on the first look');
  assert.deepEqual(w.calls.fetches.map((f) => f.body.mine === true), [true, false], 'the first poll reads my tickets and the newest of everyone');
  list.tickets = list.tickets.map((t) => ({ ...t, updatedAt: iso(20), commentCount: 1 }));
  await w.run('pollTicketNotifications()');
  assert.equal(w.calls.fetches.filter((f) => f.url === '/ticket-status').length, 3, 'three reads a poll');
  assert.equal(w.calls.chimes, 1, 'one ti-ding however many notes arrived');
  assert.equal(items(w).length, 3);
  await w.run('pollTicketNotifications()');
  assert.equal(items(w).length, 5, 'the other two are picked up next poll');
  const quiet = world({ sound: false, fetchPlan: () => ({ ok: true, tickets: [] }) });
  await quiet.run('pollTicketNotifications()');
  assert.equal(quiet.calls.chimes, 0);
});

test('polling does nothing while the page is hidden or the ticket account is not found', async () => {
  const w = world({ fetchPlan: () => ({ ok: true, tickets: [] }) });
  w.run('document.hidden = true');
  await w.run('pollTicketNotifications()');
  w.run('document.hidden = false; ticketAccount.status = "notFound"');
  await w.run('pollTicketNotifications()');
  assert.equal(w.calls.fetches.length, 0);
});

test('the bell shows the unread count and, when open, the rows with HTML in a comment shown as plain text', () => {
  const w = world();
  w.run(`ticketNoteAdd(ticketNoteLoad(), { id: 'a', ref: 'TK2610190001', title: 'WD DELAY', kind: 'mention', by: 'Ashton', text: '<img src=x onerror=alert(1)>', at: ${T0} });`);
  const closed = w.run('renderTicketBell("chat")');
  assert.match(closed, /ticket-bell-count">1</);
  assert.ok(!closed.includes('ticket-bell-panel'));
  w.run('ticketBellOpen = true');
  const open = w.run('renderTicketBell("chat")');
  assert.match(open, /@ Mentions/);
  assert.match(open, /data-action="openTicketResult"[^>]*data-ref="TK2610190001"/);
  assert.match(open, /mentioned you/);
  assert.ok(!open.includes('<img'), 'a comment can never inject markup');
  assert.match(open, /Sound: on/);
});

test('"new" is judged by the ticket system\'s own times, so a PC clock that runs ahead cannot hide a comment', () => {
  const w = world();
  setMe(w);
  const aheadBy10Min = T0 + 10 * 60_000;
  show(w, [ticket('TK2610190001', { raisedBy: ME, updatedAt: iso(0) })], aheadBy10Min);
  const after = ticket('TK2610190001', { raisedBy: ME, updatedAt: iso(2), commentCount: 1, comments: [comment(1, OTHER, 1)] });
  assert.equal(apply(w, after, aheadBy10Min + 60_000), 1, 'a comment made a minute after the last change is new even though this clock says it is old');
});

test('every thread the agent opens is recorded and marked read, and a sent comment makes the ticket theirs', () => {
  assert.ok(app.includes('ticketNoteAbsorb(data.ticket);'));
  assert.ok(app.includes('ticketNoteRemember(ref, data.comment?.author?.id ?? null);'));
  assert.ok(app.includes('ticketNoteMarkRead(btn.dataset.ref);'));
});

test('polling works on any tab: an account never checked is checked quietly first, then the poll goes on; a quiet check opens no popup', async () => {
  const w = world({ account: { status: 'unknown', email: '' }, checkResult: { status: 'found', email: ME.email }, fetchPlan: () => ({ ok: true, tickets: [ticket('TK2610190001', { raisedBy: ME })] }) });
  await w.run('pollTicketNotifications()');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.checks.map((c) => c.options))), [{ quiet: true }]);
  assert.equal(w.calls.fetches.length, 2, 'the ticket lists were read once the account was found');
  const info = JSON.parse(w.run('JSON.stringify(ticketNotePollInfo)'));
  assert.equal(info.error, '');
  assert.equal(info.watching, 1);
  assert.match(w.run('renderTicketNotesStatus()'), /Notifications: watching 1 ticket, last checked/);
  assert.ok(/if \(!quiet && \(ticketAccount\.status === "notFound"/.test(app), 'the email popup is only for a check the agent asked for');
});

test('polling says why it cannot work: account missing, ticket list refused, a failed call', async () => {
  const missing = world({ account: { status: 'unknown', email: '' }, checkResult: { status: 'notFound', email: 'x@y.co' }, fetchPlan: () => ({ ok: true, tickets: [] }) });
  await missing.run('pollTicketNotifications()');
  assert.equal(missing.calls.fetches.length, 0);
  assert.match(missing.run('renderTicketNotesStatus()'), /Notifications: not working\. The ticket account is not available/);
  const refused = world({ fetchPlan: () => ({ ok: false, error: 'The ticket system is busy (request limit reached). Try again in 20 s.' }) });
  await refused.run('pollTicketNotifications()');
  assert.match(refused.run('renderTicketNotesStatus()'), /Notifications: not working\. The ticket system is busy/);
  const broken = world({ fetchPlan: () => { throw new Error('network down'); } });
  await broken.run('pollTicketNotifications()');
  assert.match(broken.run('renderTicketNotesStatus()'), /not working\. network down/);
  assert.match(world().run('renderTicketNotesStatus()'), /waiting for the first check/);
});

test('polling does not run where the Tickets tab does not exist (the installed widget), and a first look is taken soon after the page opens', async () => {
  const w = world({ preview: false, fetchPlan: () => ({ ok: true, tickets: [] }) });
  await w.run('pollTicketNotifications()');
  assert.equal(w.calls.fetches.length, 0);
  assert.equal(w.calls.checks.length, 0);
  assert.ok(app.includes('setTimeout(() => void pollTicketNotifications(), 8000);'));
  assert.ok(app.includes('id="settingsTicketNotes"'), 'Settings shows whether notifications are being watched');
});

test('my tickets are the ones the ticket system lists as mine, whatever email they carry; everyone\'s newest are read only every fourth poll', async () => {
  const list = { mine: [], all: [] };
  const w = world({ fetchPlan: (url, body) => (url === '/ticket-list' ? { ok: true, tickets: body.mine ? list.mine : list.all } : { ok: true, ticket: { ...list.mine[0], comments: [comment(5, OTHER, 30)] } }) });
  const mineTicket = (extra = {}) => ticket('TK2610170260', { raisedBy: { id: 1, name: '96 Mexha', email: 'another-email@x.com' }, updatedAt: iso(0), ...extra });
  list.mine = [mineTicket()];
  await w.run('pollTicketNotifications()');
  assert.equal(items(w).length, 0, 'the first look is silent');
  list.mine = [mineTicket({ updatedAt: iso(20), commentCount: 1 })];
  await w.run('pollTicketNotifications()');
  assert.equal(w.calls.fetches.filter((f) => f.url === '/ticket-list').length, 3, 'two lists the first time, then only mine');
  assert.equal(items(w).length, 1, 'a comment on a ticket that is mine notifies although its email is not mine');
  assert.equal(items(w)[0].ref, 'TK2610170260');
  assert.equal(w.calls.chimes, 1);
  for (let i = 0; i < 3; i += 1) await w.run('pollTicketNotifications()');
  assert.equal(w.calls.fetches.filter((f) => f.url === '/ticket-list' && f.body.mine !== true).length, 2, 'everyone\'s newest are read again on the fourth poll');
});

test('if only one of the two lists can be read, the other still gives notifications; if neither, Settings says why and polling backs off while the ticket system is busy', async () => {
  const half = world({ fetchPlan: (url, body) => (url === '/ticket-list' ? (body.mine ? { ok: false, error: 'no mine' } : { ok: true, tickets: [ticket('TK2610190001', { raisedBy: ME })] }) : { ok: true, ticket: ticket('TK2610190001') }) });
  await half.run('pollTicketNotifications()');
  assert.match(half.run('renderTicketNotesStatus()'), /Part of the list could not be read: no mine/);
  const busy = world({ fetchPlan: () => ({ ok: false, error: 'The ticket system is busy (request limit reached). Try again in 20 s.' }) });
  await busy.run('pollTicketNotifications()');
  assert.match(busy.run('renderTicketNotesStatus()'), /not working\. The ticket system is busy/);
  const paused = busy.run('ticketPollPausedUntil - Date.now()');
  assert.ok(paused > 20_000 && paused <= 22_500, `paused for what the ticket system asked, not longer (${paused})`);
  const calls = busy.calls.fetches.length;
  await busy.run('pollTicketNotifications()');
  assert.equal(busy.calls.fetches.length, calls, 'no call while paused');
});

test('open tickets are polled every 8 s and notifications every 15 s, each waits out a "busy" answer, and coming back to the page looks at once', () => {
  assert.ok(app.includes('const TICKET_NOTE_POLL_MS = 15_000;'));
  assert.ok(app.includes('const TICKET_OPEN_POLL_MS = 8000;'));
  assert.ok(app.includes('setInterval(pollTicketUpdates, TICKET_OPEN_POLL_MS);'));
  assert.ok(app.includes('document.addEventListener("visibilitychange", () => { if (!document.hidden) void pollTicketUpdates(); });'));
  assert.match(fn('pollTicketUpdates'), /Date\.now\(\) < ticketPollPausedUntil/);
  assert.match(fn('pollTicketUpdates'), /ticketPollBackoff\(err\)/);
});
