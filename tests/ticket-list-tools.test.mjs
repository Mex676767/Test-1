import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];
const plain = (value) => JSON.parse(JSON.stringify(value));
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const ACCOUNT_SOURCE = [
  'let ticketNotePollInfo = { at: 0, watching: 0, error: "" };',
  'let ticketAccount = { status: "unknown", email: "", source: "", message: "", detail: "", checking: false, at: 0, shownUntil: 0 };',
  line(/const TICKET_ACCOUNT_RECHECK_MS = [^;]+;/), line(/const TICKET_ACCOUNT_FOUND_SHOWN_MS = [^;]+;/),
  ...['hideTicketAccountLineLater', 'checkTicketAccount', 'noteTicketAccountUsed', 'renderTicketAccountLine', 'ticketAccountSettingsVisible', 'ticketAccountSettingsChat', 'renderTicketAccountSettings', 'renderTicketNotesStatus'].map(fn),
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
  assert.ok(app.includes('filterChoice("ticketExplorerAgent", "All agents", agents, agentLabel, [{ value: TICKET_FILTER_ME, label: "Me" }])'));
  assert.ok(app.includes('if (agent === TICKET_FILTER_ME) return ticketIsMine(ticket);'));
});

const BULK_SOURCE = [
  line(/const TICKET_BULK_MAX = \d+;/), 'const ticketBulkByChat = new Map();',
  ...['ticketScopedWho', 'ticketActiveList', 'ticketBulkFor', 'ticketBulkStatusOptions', 'ticketBulkToggle', 'ticketBulkSelectAll', 'ticketNoteSeen', 'applyBulkStatus', 'renderTicketBulkBar'].map(fn),
].join('\n');

const row = (ref, status = 'OPEN') => ({ ref, fields: { status }, commentCount: 0, assignees: [], raisedBy: null });
function bulkWorld({ tickets, reply } = {}) {
  const calls = { fetches: [], renders: 0, seen: [], used: 0 };
  const results = new Map([['chat', { loading: false, tickets: tickets || [row('TK1'), row('TK2'), row('TK3', 'SOLVED')] }]]);
  const context = vm.createContext({
    Map, Set, Number, String, JSON, Array, Object, Error, escapeHtml,
    state: { chat: { escalation: {}, ticketExplorerAgent: 'all' } }, ticketSearchResultsByChat: results, TICKET_FILTER_ME: '@me',
    TICKET_FIELD_SPECS: [{ stateKey: 'status', keys: ['status'] }],
    ticketFieldFor: () => ({ key: 'status' }),
    ticketFieldOptions: () => [{ value: 'OPEN', label: 'Open' }, { value: 'IN_PROGRESS', label: 'PYM PROCESSING' }, { value: 'SOLVED', label: 'CS TEAM SOLVED' }],
    ticketChoiceDisplayLabel: (_key, value) => ({ IN_PROGRESS: 'PYM PROCESSING', OPEN: 'Open', SOLVED: 'CS TEAM SOLVED' })[value] || value,
    renderTicketChoice: (_chat, field, value, options, config) => `<choice field="${field}" value="${value}" placeholder="${config.placeholder}" options="${options.map((option) => option.value + ':' + option.label).join(',')}">`,
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
  assert.doesNotMatch(empty, /bulk:status/);
  w.run('ticketBulkToggle("chat", "TK1", true)');
  let html = w.run('renderTicketBulkBar("chat", [{ ref: "TK1" }, { ref: "TK2" }])');
  assert.match(html, /1 selected/);
  assert.match(html, /<choice field="bulk:status" value="" placeholder="Set status to…" options="OPEN:Open,IN_PROGRESS:PYM PROCESSING,SOLVED:CS TEAM SOLVED">/, 'the custom dropdown, with any status the ticket system offers');
  assert.doesNotMatch(html, /<select/);
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
  assert.ok(app.includes('ticketBulkFor(chatId).status = btn.dataset.value || ""'));
  assert.ok(app.includes('btn.dataset.action === "bulkSelectAll"') && app.includes('btn.dataset.action === "bulkApplyStatus"'));
});

function meWorld({ agent = '@me', author = true, mineFails = false } = {}) {
  const calls = [];
  const results = new Map();
  const context = vm.createContext({
    Map, Promise, String, Object, Error, JSON, Boolean, Array, ticketBulkStatusOptions: () => [{ value: 'PYM_SOLVED' }, { value: 'OPEN' }], ticketDepartments: [{ id: 60, name: 'Payment' }, { id: 'CS', code: 'CS' }], ticketMarkets: [{ id: 1, label: 'Malaysia' }],
    state: { chat: { ticketExplorerAgent: agent } }, ticketSearchResultsByChat: results,
    TICKET_FILTER_ME: '@me', renderTicketSlot: () => { calls.push({ rendered: true }); }, saveState: () => {}, refreshTicketInbox: async (...args) => { calls.push({ refresh: args }); }, ticketReadAuthor: () => (author ? { accountKey: 'lc1', agentToken: 't' } : undefined),
    ticketReadFailure: (_id, data, fallback) => new Error(data.error || fallback),
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      const mine = body ? body.mine === true || body.agent !== undefined : /mine=1|agent=/.test(String(url));
      if (mine && mineFails) return { json: async () => ({ ok: false, error: 'mine broke' }) };
      return { json: async () => ({ ok: true, total: mine ? 216 : 500, tickets: [{ ref: mine ? 'TK-MINE' : 'TK-ALL' }] }) };
    },
  });
  vm.runInContext(['fetchTicketList', 'ticketServerFilters', 'ticketListStale', 'ticketScopedWho', 'ticketActiveList', 'searchTickets', 'applyTicketFilter'].map(fn).join('\n'), context);
  return { calls, results, run: (code) => vm.runInContext(code, context) };
}

test('Me: the list is read twice at once, everyone\'s newest and mine as the ticket system lists them, and the explorer shows mine', async () => {
  const w = meWorld();
  await w.run('searchTickets("chat", "hong", "search", { fresh: true })');
  assert.deepEqual(w.calls.map((call) => [call.url, call.body.mine === true, call.body.q]), [['/ticket-list', false, 'hong'], ['/ticket-list', true, 'hong']]);
  assert.equal(plain(w.results.get('chat')).mineFor, '@me');
  const entry = plain(w.results.get('chat'));
  assert.deepEqual([entry.tickets[0].ref, entry.mine.tickets[0].ref, entry.mine.total, entry.query], ['TK-ALL', 'TK-MINE', 216, 'hong']);
  assert.equal(w.run('ticketActiveList("chat")').tickets[0].ref, 'TK-MINE');
  w.run('state.chat.ticketExplorerAgent = "all"');
  assert.equal(w.run('ticketActiveList("chat")').tickets[0].ref, 'TK-ALL', 'back to everyone\'s list without another read');
  assert.equal(w.calls.length, 2);
});

test('Me: without that filter only the one list is read; signed out, the plain call carries mine=1', async () => {
  const w = meWorld({ agent: 'all' });
  await w.run('searchTickets("chat", "", "all", { fresh: false })');
  assert.equal(w.calls.length, 1);
  assert.equal('mine' in w.calls[0].body, false);
  assert.equal(plain(w.results.get('chat')).mine, undefined);
  const plainCall = meWorld({ author: false });
  await plainCall.run('searchTickets("chat", "x", "search", { fresh: true })');
  assert.deepEqual(plainCall.calls.map((call) => call.url), ['/ticket-list?q=x&fresh=1', '/ticket-list?q=x&fresh=1&mine=1']);
});

test('Me: if my own tickets cannot be read the search fails with the reason instead of showing a wrong list', async () => {
  const w = meWorld({ mineFails: true });
  await assert.rejects(() => w.run('searchTickets("chat", "", "all")'), /mine broke/);
});

test('Me: the explorer lists what the ticket system says is mine without filtering it again, and picking Me the first time reads the list again', () => {
  assert.ok(app.includes('const serverMine = Boolean(ticketScopedWho(s.ticketExplorerAgent) && result?.mine && result.mineFor === s.ticketExplorerAgent);'));
  assert.ok(app.includes('(serverMine || ticketMatchesAgent(ticket, s.ticketExplorerAgent))'));
  assert.ok(app.includes('(Boolean(ticketScopedWho(agent)) && loaded.mineFor !== agent)'));
  assert.ok(app.includes('const result = ticketActiveList(chatId);'), 'the bulk update works on the list that is shown');
});

test('bulk with Me picked: the tickets of the "mine" list are the ones changed, and a ticket in both lists is right in both', async () => {
  const w = bulkWorld();
  w.results.get('chat').mine = { tickets: [row('TK1'), row('TK9')], total: 2 };
  w.results.get('chat').mineFor = '@me';
  w.run('state.chat.ticketExplorerAgent = "@me"; ticketBulkFor("chat").selected = ["TK1", "TK9"]; ticketBulkFor("chat").status = "IN_PROGRESS"');
  await w.run('applyBulkStatus("chat")');
  assert.deepEqual(w.calls.fetches.map((call) => call.body.ref), ['TK1', 'TK9'], 'TK9 is only in the mine list');
  assert.equal(w.results.get('chat').tickets[0].fields.status, 'IN_PROGRESS', 'everyone\'s list is kept right too');
  assert.deepEqual(w.results.get('chat').mine.tickets.map((ticket) => ticket.fields.status), ['IN_PROGRESS', 'IN_PROGRESS']);
});

test('an agent picked from the roster is asked of the ticket system by id; the list is read again the first time, and the filter value is the id', async () => {
  const w = meWorld({ agent: '#44' });
  await w.run('searchTickets("chat", "", "all", { fresh: true })');
  const sent = w.calls.filter((call) => call.url).map((call) => call.body);
  assert.deepEqual(sent.map((body) => body.agent ?? null), [null, '44']);
  assert.equal(plain(w.results.get('chat')).mineFor, '#44');
  assert.equal(w.run('ticketActiveList("chat")').tickets[0].ref, 'TK-MINE');
  w.run('state.chat.ticketExplorerAgent = "#45"');
  assert.equal(w.run('ticketActiveList("chat")').tickets[0].ref, 'TK-ALL', 'another agent is not shown the list read for #44');
  assert.deepEqual([w.run('ticketScopedWho("@me")'), w.run('ticketScopedWho("#7")'), w.run('ticketScopedWho("Ann")'), w.run('ticketScopedWho("all")')], ['me', '7', '', '']);
});

test('picking a filter in the custom dropdown applies it; a person is read again only when that list is not loaded yet', () => {
  const w = meWorld({ agent: 'all' });
  w.results.set('chat', { loading: false, tickets: [], mode: 'all', query: 'abc' });
  w.run('applyTicketFilter("chat", "ticketExplorerAgent", "@me")');
  assert.equal(w.run('state.chat.ticketExplorerAgent'), '@me');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.find((call) => call.refresh).refresh)), ['chat', 'abc', 'all', { fresh: false }]);
  w.calls.length = 0;
  w.results.set('chat', { loading: false, tickets: [], mine: { tickets: [] }, mineFor: '@me', mode: 'all', filtersKey: '{}' });
  w.run('applyTicketFilter("chat", "ticketExplorerAgent", "@me")');
  assert.equal(w.calls.some((call) => call.refresh), false, 'already loaded for Me and these filters');
  w.run('applyTicketFilter("chat", "ticketExplorerStatus", "OPEN")');
  assert.equal(w.run('state.chat.ticketExplorerStatus'), 'OPEN');
  assert.equal(w.calls.some((call) => call.refresh), true, 'a status is asked of the ticket system, so the list is read again for it');
  w.run('applyTicketFilter("chat", "nope", "x")');
  assert.equal(w.run('state.chat.nope'), undefined, 'only the four filters can be set');
});

test('the filters and the bulk status are custom dropdowns wired through the shared choice handler', () => {
  assert.ok(app.includes('btn.dataset.field.startsWith("filter:")') && app.includes('applyTicketFilter(chatId, btn.dataset.field.slice(7), btn.dataset.value || "all")'));
  assert.ok(app.includes('btn.dataset.field === "bulk:status"'));
  assert.doesNotMatch(app, /<select class="input ticket-explorer-filter"/);
  assert.doesNotMatch(app, /<select class="input ticket-bulk-status"/);
  assert.ok(app.includes('void loadTicketAgentRoster(chatId);'));
});

test('status, department and market offer every choice, not only those on the loaded tickets; a left-over filter value that is no longer offered is not applied', () => {
  assert.ok(app.includes('unique([...ticketBulkStatusOptions().map(option => String(option.value)), ...tickets.map(ticketStatusValue)])'));
  assert.ok(app.includes('unique([...ticketDepartments.map(item => item.name || item.code)'));
  assert.ok(app.includes('unique([...ticketMarkets.map(item => item.label || item.code)'));
  assert.ok(app.includes('const effective = (key, values) =>'));
});

test('roster: loaded once when the filters open, kept ten minutes, and a failure leaves the filter working', async () => {
  const source = [line(/let ticketAgentRoster = [^;]+;/), line(/const TICKET_ROSTER_MAX_AGE_MS = [^;]+;/), fn('loadTicketAgentRoster')].join('\n');
  let calls = 0;
  const make = (reply) => {
    const context = vm.createContext({ Date, Object, Array, state: { chat: {} }, renderTicketSlot: () => {}, ticketReadAuthor: () => ({ accountKey: 'lc1', agentToken: 't' }), ticketReadFailure: (_id, data) => new Error(data.error),
      fetch: async (url) => { calls += 1; return { json: async () => reply, url }; } });
    vm.runInContext(source, context);
    return { run: (code) => vm.runInContext(code, context) };
  };
  const ok = make({ ok: true, agents: [{ id: 1, name: 'Ann' }] });
  await ok.run('loadTicketAgentRoster("chat")');
  assert.deepEqual(plain(ok.run('ticketAgentRoster.agents')), [{ id: 1, name: 'Ann' }]);
  await ok.run('loadTicketAgentRoster("chat")');
  assert.equal(calls, 1, 'not asked again within ten minutes');
  ok.run('ticketAgentRoster.at = Date.now() - 11 * 60_000');
  await ok.run('loadTicketAgentRoster("chat")');
  assert.equal(calls, 2);
  const bad = make({ ok: false, error: 'busy' });
  await bad.run('loadTicketAgentRoster("chat")');
  assert.equal(bad.run('ticketAgentRoster.error'), 'busy');
  assert.equal(bad.run('ticketAgentRoster.loading'), false);
  assert.deepEqual(plain(bad.run('ticketAgentRoster.agents')), []);
});

test('the status, department and market filters go to the ticket system as the ids and value it takes', () => {
  const w = meWorld({ agent: 'all' });
  const filters = (patch) => { w.run(`Object.assign(state.chat, ${JSON.stringify(patch)})`); return plain(w.run('ticketServerFilters("chat")')); };
  assert.deepEqual(filters({ ticketExplorerStatus: 'PYM_SOLVED', ticketExplorerDepartment: 'Payment', ticketExplorerMarket: 'Malaysia' }), { status: 'PYM_SOLVED', department: '60', market: '1' });
  assert.deepEqual(filters({ ticketExplorerStatus: 'all', ticketExplorerDepartment: 'all', ticketExplorerMarket: 'all' }), {});
  assert.deepEqual(filters({ ticketExplorerDepartment: 'CS' }), {}, 'a department known only by its code cannot be asked of the ticket system; it is filtered on the loaded tickets');
  assert.deepEqual(filters({ ticketExplorerDepartment: 'all', ticketExplorerStatus: 'GONE' }), {}, 'a status that is no longer offered is not sent');
});

test('the list is read with those filters, for everyone and for the person picked, and read again when they change or a change came in mid-read', async () => {
  const w = meWorld({ agent: '@me' });
  w.run('Object.assign(state.chat, { ticketExplorerStatus: "PYM_SOLVED", ticketExplorerMarket: "Malaysia" })');
  await w.run('searchTickets("chat", "", "all", { fresh: true })');
  const bodies = w.calls.filter((call) => call.url).map((call) => call.body);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.status === 'PYM_SOLVED' && body.market === '1'), 'both lists are narrowed');
  assert.equal(plain(w.results.get('chat')).filtersKey, '{"status":"PYM_SOLVED","market":"1"}');
  assert.equal(w.run('ticketListStale("chat")'), false);
  w.run('state.chat.ticketExplorerStatus = "OPEN"');
  assert.equal(w.run('ticketListStale("chat")'), true, 'another status than the list was read for');
  w.run('state.chat.ticketExplorerStatus = "PYM_SOLVED"; state.chat.ticketExplorerAgent = "#44"');
  assert.equal(w.run('ticketListStale("chat")'), true, 'another person than the list was read for');
  const plainCall = meWorld({ agent: 'all', author: false });
  plainCall.run('state.chat.ticketExplorerStatus = "OPEN"');
  await plainCall.run('searchTickets("chat", "x", "search", { fresh: true })');
  assert.equal(plainCall.calls[0].url, '/ticket-list?q=x&fresh=1&status=OPEN');
});
