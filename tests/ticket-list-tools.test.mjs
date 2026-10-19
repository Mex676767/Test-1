import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];
const plain = (value) => JSON.parse(JSON.stringify(value));
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// ---- the ticket account line: shown for a few seconds, then it lives in Settings ----------------------------
const ACCOUNT_SOURCE = [
  'let ticketAccount = { status: "unknown", email: "", source: "", message: "", detail: "", checking: false, at: 0, shownUntil: 0 };',
  line(/const TICKET_ACCOUNT_RECHECK_MS = [^;]+;/), line(/const TICKET_ACCOUNT_FOUND_SHOWN_MS = [^;]+;/),
  ...['hideTicketAccountLineLater', 'checkTicketAccount', 'noteTicketAccountUsed', 'renderTicketAccountLine', 'ticketAccountSettingsVisible', 'ticketAccountSettingsChat', 'renderTicketAccountSettings'].map(fn),
].join('\n');

function accountWorld({ reply = { ok: true, enabled: true, status: 'found', email: 'alice@company.com', source: 'livechat' }, preview = true, live = false } = {}) {
  const calls = { fetches: 0, timers: [], renders: [] };
  const state = { chat: { escalation: {} }, other: { escalation: {} } };
  const context = vm.createContext({
    state, Object, Date, Number, String, JSON, escapeHtml, queueMicrotask,
    setTimeout: (callback, ms) => { calls.timers.push({ callback, ms }); },
    currentLiveChatAccount: 'lc1', ticketConfigError: '', ticketFields: [{ key: 'member_id' }], fetchTicketConfig: async () => {},
    ticketAuthor: () => ({ accountKey: 'lc1', agentToken: 't' }), storeTicketEmail: () => {}, showTicketProblem: () => {},
    pollTicketNotifications: async () => {}, ticketWorkspaceView: () => 'detail', ticketSearchResultsByChat: new Map(), refreshTicketInbox: async () => {},
    renderTicketSlot: (id) => calls.renders.push(id),
    ESCALATION_TICKET_ENABLED: true, previewMode: preview, DEPARTMENT_TABS_LIVE: live, activeChats: [{ chatId: 'chat' }],
    fetch: async () => { calls.fetches += 1; return { json: async () => reply }; },
  });
  vm.runInContext(ACCOUNT_SOURCE, context);
  return { calls, run: (code) => vm.runInContext(code, context) };
}

test('ticket account line: "found" shows when the account is first confirmed, hides itself after a few seconds, and a redraw is scheduled', async () => {
  const w = accountWorld();
  await w.run('checkTicketAccount("chat")');
  assert.match(w.run('renderTicketAccountLine("chat")'), /✓ Ticket account found: <strong>alice@company\.com/);
  assert.equal(w.calls.timers.length, 1);
  assert.ok(w.calls.timers[0].ms > 6000 && w.calls.timers[0].ms < 8000);
  w.calls.renders.length = 0;
  w.calls.timers[0].callback();
  assert.deepEqual([...new Set(w.calls.renders)].sort(), ['chat', 'other'], 'every ticket view is redrawn when the time is up');
  w.run('ticketAccount.shownUntil = Date.now() - 1');
  assert.equal(w.run('renderTicketAccountLine("chat")'), '');
  assert.match(w.run('renderTicketAccountLine("chat", { always: true })'), /Ticket account found/, 'Settings always shows it');
});

test('ticket account line: the five-minute re-check does not show it again; "Check again" does', async () => {
  const w = accountWorld();
  await w.run('checkTicketAccount("chat")');
  w.run('ticketAccount.shownUntil = 0; ticketAccount.at = Date.now() - 6 * 60_000');
  await w.run('checkTicketAccount("chat")');
  assert.equal(w.calls.fetches, 2);
  assert.equal(w.run('renderTicketAccountLine("chat")'), '', 'checked again quietly');
  await w.run('checkTicketAccount("chat", { force: true })');
  assert.match(w.run('renderTicketAccountLine("chat")'), /Ticket account found/, 'asked for on purpose, so it shows');
});

test('ticket account line: a problem never hides, and a ticket made as the agent does not bring the line back', async () => {
  for (const [status, pattern] of [['notFound', /Ticket account not found/], ['keyNeedsGrant', /api-keys:act-on-behalf/], ['keyRejected', /does not accept the integration key/]]) {
    const w = accountWorld({ reply: { ok: true, enabled: true, status, email: 'a@b.co', source: 'livechat' } });
    await w.run('checkTicketAccount("chat")');
    w.run('ticketAccount.shownUntil = 0');
    assert.match(w.run('renderTicketAccountLine("chat")'), pattern, status);
  }
  const used = accountWorld();
  used.run('noteTicketAccountUsed({ actedAs: "alice@company.com" })');
  assert.equal(used.run('renderTicketAccountLine("chat")'), '');
});

test('Settings has a Ticket account card with the line, Check again and the email button; it is not there when the ticket system is not acting as the agent or the Tickets tab does not exist', async () => {
  const w = accountWorld();
  assert.match(w.run('renderTicketAccountSettings()'), /Not checked yet/);
  await w.run('checkTicketAccount("chat")');
  w.run('ticketAccount.shownUntil = 0');
  const html = w.run('renderTicketAccountSettings()');
  assert.match(html, /Ticket account<\/span>/);
  assert.match(html, /✓ Ticket account found: <strong>alice@company\.com/);
  assert.match(html, /data-settings-ticket-recheck/);
  assert.equal(w.run('ticketAccountSettingsVisible()'), true);
  assert.equal(accountWorld({ preview: false }).run('ticketAccountSettingsVisible()'), false, 'the installed widget has no Tickets tab yet');
  assert.equal(accountWorld({ preview: false, live: true }).run('ticketAccountSettingsVisible()'), true);
  const off = accountWorld({ reply: { ok: true, enabled: false } });
  await off.run('checkTicketAccount("chat")');
  assert.equal(off.run('ticketAccountSettingsVisible()'), false);
  assert.ok(app.includes('id="settingsTicketAccountCard"') && app.includes('data-settings-ticket-recheck'));
  assert.ok(app.includes('showTicketProblem(chatId, { needTicketEmail: true, triedEmail: ticketAccount.email, error: "Enter the email of your ticket-system account." }'), 'Enter your ticket email works from Settings too');
});

// ---- the Agent filter's "Me" ------------------------------------------------------------------------------
test('Me filter: tickets the agent raised or is assigned to, by their ticket account email, or ones raised from here', () => {
  const source = [line(/const TICKET_FILTER_ME = "[^"]+";/), fn('ticketNotePeople'), fn('ticketIsMine')].join('\n');
  const make = (email, mine = []) => {
    const context = vm.createContext({ ticketAccount: { email }, ticketNoteLoad: () => ({ me: { email: '' }, mine }), String, Boolean });
    vm.runInContext(source, context);
    return (ticket) => vm.runInContext(`ticketIsMine(${JSON.stringify(ticket)})`, context);
  };
  const isMine = make('Me@Company.com', ['TK7']);
  assert.equal(isMine({ ref: 'TK1', raisedBy: { email: 'me@company.com' }, assignees: [] }), true, 'raised by me, case ignored');
  assert.equal(isMine({ ref: 'TK2', raisedBy: { email: 'a@x.com' }, assignees: [{ email: 'ME@company.com' }] }), true, 'assigned to me');
  assert.equal(isMine({ ref: 'TK3', raisedBy: { email: 'a@x.com' }, assignees: [{ email: 'b@x.com' }] }), false);
  assert.equal(isMine({ ref: 'TK7', raisedBy: null, assignees: [] }), true, 'raised from this widget');
  assert.equal(make('')({ ref: 'TK4', raisedBy: { email: '' }, assignees: [] }), false, 'an unknown email never matches blank emails');
});

test('Me filter: "Me" is the first choice after All agents, and picking it lists only my tickets', () => {
  assert.ok(app.includes('<option value="all">All agents</option><option value="${TICKET_FILTER_ME}"'));
  assert.ok(app.includes('s.ticketExplorerAgent === TICKET_FILTER_ME ? ticketIsMine(ticket)'));
});

// ---- bulk status edit -----------------------------------------------------------------------------------------
const BULK_SOURCE = [
  line(/const TICKET_BULK_MAX = \d+;/), 'const ticketBulkByChat = new Map();',
  ...['ticketBulkFor', 'ticketBulkStatusOptions', 'ticketBulkToggle', 'ticketBulkSelectAll', 'ticketNoteSeen', 'applyBulkStatus', 'renderTicketBulkBar'].map(fn),
].join('\n');

const row = (ref, status = 'OPEN') => ({ ref, fields: { status }, commentCount: 0, assignees: [], raisedBy: null });
function bulkWorld({ tickets, reply } = {}) {
  const calls = { fetches: [], renders: 0, seen: [], used: 0 };
  const results = new Map([['chat', { loading: false, tickets: tickets || [row('TK1'), row('TK2'), row('TK3', 'SOLVED')] }]]);
  const context = vm.createContext({
    Map, Set, Number, String, JSON, Array, Object, Error, escapeHtml,
    state: { chat: { escalation: {} } }, ticketSearchResultsByChat: results,
    TICKET_FIELD_SPECS: [{ stateKey: 'status', keys: ['status'] }],
    ticketFieldFor: () => ({ key: 'status' }),
    ticketFieldOptions: () => [{ value: 'OPEN', label: 'Open' }, { value: 'IN_PROGRESS', label: 'PYM PROCESSING' }, { value: 'SOLVED', label: 'CS TEAM SOLVED' }],
    ticketChoiceDisplayLabel: (_key, value) => ({ IN_PROGRESS: 'PYM PROCESSING', OPEN: 'Open', SOLVED: 'CS TEAM SOLVED' })[value] || value,
    ticketAuthor: () => ({ accountKey: 'lc1', agentToken: 't' }), noteTicketAccountUsed: () => { calls.used += 1; },
    renderTicketSlot: () => { calls.renders += 1; },
    ticketNoteLoad: () => ({ startedAt: 1, seen: {} }), ticketNoteSnapshot: (ticket) => ({ ref: ticket.ref }), ticketNoteSave: () => { calls.seen.push('saved'); },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.fetches.push({ url, body });
      const out = reply ? reply(body, calls.fetches.length) : { status: 200, body: { ok: true, ref: body.ref, changed: [], visible: true, ticket: { ...row(body.ref, body.fields.status), comments: [], updatedAt: 'now' } } };
      return { status: out.status, json: async () => out.body };
    },
  });
  vm.runInContext(BULK_SOURCE, context);
  return { calls, results, run: (code) => vm.runInContext(code, context), bulk: () => plain(vm.runInContext('ticketBulkFor("chat")', context)) };
}
const ok = (status = 200, body) => ({ status, body });

test('bulk: ticking one by one, Select all and Clear selection; the cap is explained', () => {
  const w = bulkWorld();
  w.run('ticketBulkFor("chat").visibleRefs = ["TK1", "TK2", "TK3"]; ticketBulkToggle("chat", "TK1", true); ticketBulkToggle("chat", "TK2", true)');
  assert.deepEqual(w.bulk().selected, ['TK1', 'TK2']);
  w.run('ticketBulkToggle("chat", "TK1", false)');
  assert.deepEqual(w.bulk().selected, ['TK2']);
  w.run('ticketBulkSelectAll("chat")');
  assert.deepEqual(w.bulk().selected, ['TK1', 'TK2', 'TK3'], 'Select all ticks everything the list shows');
  w.run('ticketBulkSelectAll("chat")');
  assert.deepEqual(w.bulk().selected, [], 'and a second press clears it');
  const many = Array.from({ length: 80 }, (_, i) => `TK${i}`);
  w.run(`ticketBulkFor("chat").visibleRefs = ${JSON.stringify(many)}; ticketBulkSelectAll("chat")`);
  assert.equal(w.bulk().selected.length, 60);
  assert.match(w.bulk().summary, /first 60 of 80/);
});

test('bulk: the bar offers Select all always, and the status and the Update button once something is ticked', () => {
  const w = bulkWorld();
  const empty = w.run('renderTicketBulkBar("chat", [{ ref: "TK1" }, { ref: "TK2" }])');
  assert.match(empty, /data-action="bulkSelectAll"[^>]*>Select all</);
  assert.doesNotMatch(empty, /ticket-bulk-status/);
  w.run('ticketBulkToggle("chat", "TK1", true)');
  let html = w.run('renderTicketBulkBar("chat", [{ ref: "TK1" }, { ref: "TK2" }])');
  assert.match(html, /1 selected/);
  assert.match(html, /<option value="IN_PROGRESS" >PYM PROCESSING<\/option>/, 'any status the ticket system offers');
  assert.match(html, /data-action="bulkApplyStatus"[^>]*disabled/, 'nothing happens until a status is chosen');
  w.run('ticketBulkFor("chat").status = "IN_PROGRESS"; ticketBulkToggle("chat", "TK2", true)');
  html = w.run('renderTicketBulkBar("chat", [{ ref: "TK1" }, { ref: "TK2" }])');
  assert.match(html, /Update 2<\/button>/);
  assert.doesNotMatch(html.match(/<button[^>]*bulkApplyStatus[^>]*>/)[0], /disabled/);
  assert.match(html, /Clear selection/);
  const hidden = w.run('renderTicketBulkBar("chat", [{ ref: "TK2" }])');
  assert.match(hidden, /1 selected/, 'a ticket the filters hide is dropped from the selection');
});

test('bulk: each ticked ticket is set to the chosen status, guarded by the status the list showed; the list and the summary follow', async () => {
  const w = bulkWorld();
  w.run('ticketBulkFor("chat").selected = ["TK1", "TK2"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await w.run('applyBulkStatus("chat")');
  assert.deepEqual(w.calls.fetches.map((call) => call.body.ref), ['TK1', 'TK2']);
  assert.deepEqual(w.calls.fetches[0].body.fields, { status: 'IN_PROGRESS' });
  assert.deepEqual(w.calls.fetches[0].body.expect, { status: 'OPEN' });
  assert.equal(w.calls.fetches[0].url, '/ticket-update');
  assert.equal(w.calls.fetches[0].body.author.accountKey, 'lc1');
  assert.deepEqual(w.results.get('chat').tickets.map((ticket) => ticket.fields.status), ['IN_PROGRESS', 'IN_PROGRESS', 'SOLVED']);
  assert.equal('comments' in w.results.get('chat').tickets[0], false, 'the list keeps no conversation');
  assert.equal(w.bulk().summary, 'Set 2 tickets to PYM PROCESSING.');
  assert.deepEqual(w.bulk().selected, []);
  assert.equal(w.bulk().running, false);
  assert.equal(w.calls.used, 2);
  assert.equal(w.calls.seen.length, 2, 'the agent is not notified of their own change');
});

test('bulk: a ticket that already has the status is not sent; one changed by someone else is reported and stays ticked', async () => {
  const w = bulkWorld({ reply: (body) => (body.ref === 'TK2' ? ok(412, { ok: false, code: 'precondition_failed', error: 'x' }) : ok(200, { ok: true, ref: body.ref, changed: [], visible: true, ticket: { ...row(body.ref, body.fields.status), comments: [] } })) });
  w.run('ticketBulkFor("chat").selected = ["TK1", "TK2", "TK3"]; ticketBulkFor("chat").status = "SOLVED"');
  await w.run('applyBulkStatus("chat")');
  assert.deepEqual(w.calls.fetches.map((call) => call.body.ref), ['TK1', 'TK2'], 'TK3 is solved already');
  assert.equal(w.bulk().summary, 'Set 1 ticket to CS TEAM SOLVED. 1 already had it. 1 not changed: TK2 (someone changed it first).');
  assert.deepEqual(w.bulk().selected, ['TK2']);
});

test('bulk: a refusal that would repeat for every ticket stops the run; one that is about this ticket only does not', async () => {
  const stopped = bulkWorld({ reply: () => ok(403, { ok: false, code: 'field_forbidden', error: 'Your role may view "Status" but not change it.' }) });
  stopped.run('ticketBulkFor("chat").selected = ["TK1", "TK2"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await stopped.run('applyBulkStatus("chat")');
  assert.equal(stopped.calls.fetches.length, 1);
  assert.match(stopped.bulk().summary, /No ticket was changed\..*not changed: TK1.*Stopped: Your role may view "Status" but not change it\./);
  const busy = bulkWorld({ reply: () => ok(429, { ok: false, error: 'The ticket system is busy (request limit reached). Try again in 20 s.' }) });
  busy.run('ticketBulkFor("chat").selected = ["TK1", "TK2"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await busy.run('applyBulkStatus("chat")');
  assert.equal(busy.calls.fetches.length, 1);
  assert.match(busy.bulk().summary, /Stopped: The ticket system is busy/);
  const own = bulkWorld({ reply: (body) => (body.ref === 'TK1' ? ok(403, { ok: false, code: 'ticket_not_editable', error: 'Your role may not edit this ticket.' }) : ok(200, { ok: true, ref: body.ref, changed: [], visible: true, ticket: { ...row(body.ref, 'IN_PROGRESS'), comments: [] } })) });
  own.run('ticketBulkFor("chat").selected = ["TK1", "TK2"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await own.run('applyBulkStatus("chat")');
  assert.equal(own.calls.fetches.length, 2, 'the next ticket is still tried');
  assert.match(own.bulk().summary, /Set 1 ticket.*1 not changed: TK1 \(Your role may not edit this ticket\.\)/);
});

test('bulk: a ticket that the change moves out of reach leaves the list; running twice at once sends one run', async () => {
  const w = bulkWorld({ reply: (body) => ok(200, { ok: true, ref: body.ref, changed: [], visible: false }) });
  w.run('ticketBulkFor("chat").selected = ["TK1"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await Promise.all([w.run('applyBulkStatus("chat")'), w.run('applyBulkStatus("chat")')]);
  assert.equal(w.calls.fetches.length, 1);
  assert.deepEqual(w.results.get('chat').tickets.map((ticket) => ticket.ref), ['TK2', 'TK3']);
});

test('bulk: the list rows have tick boxes, and the page wires the ticks, the status box and the two buttons', () => {
  assert.ok(app.includes('class="ticket-bulk-tick"'));
  assert.ok(app.includes('data-ref="${escapeHtml(ticket.ref)}" ${ticketBulkFor(chatId).selected.includes(ticket.ref) ? "checked" : ""}'));
  assert.ok(app.includes('ticketBulkToggle(bulkTick.dataset.chat, bulkTick.dataset.ref, bulkTick.checked)'));
  assert.ok(app.includes('ticketBulkFor(bulkStatus.dataset.chat).status = bulkStatus.value'));
  assert.ok(app.includes('btn.dataset.action === "bulkSelectAll"') && app.includes('btn.dataset.action === "bulkApplyStatus"'));
});
