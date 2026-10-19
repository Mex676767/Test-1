import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = name => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
function widget() {
  const state = { chat: { escalation: {}, ticketView: 'list' } };
  const requests = [];
  const context = vm.createContext({
    state, Map, Set, Date, Number, String,
    previewMode: true, ticketConfigError: '', ticketDepartments: [], ticketMarkets: [], 
    ticketFields: [{ key: 'member_id' }], liveChatAgentTokens: () => ({}), currentLiveChatAccount: '', storedTicketEmail: () => '', queueMicrotask, showTicketProblem() {},
    TICKET_FIELD_SPECS: [{ stateKey: 'memberUserId' }, { stateKey: 'remarks' }, { stateKey: 'amount' }],
    ticketCreateInFlight: new Set(), ticketDetailInFlight: new Set(), ticketSearchResultsByChat: new Map(),
    ticketPeople: t => [t.raisedBy?.name, ...(t.assignees || []).map(p => p.name)].filter(Boolean),
    ticketStatusValue: t => String(t.fields?.status || ''),
    ticketChoiceDisplayLabel: (_key, value) => value,
    ticketFieldDisplay: value => String(value),
    ticketValueDisplay: (_key, value) => String(value),
    ticketFieldFor: () => ({}),
    renderTicketInput: (_id, spec) => `<input data-field="${spec.stateKey}">`,
    renderTicketChoice: () => '<button>Choice</button>',
    renderTicketAttachments: () => '<div>Attachments</div>',
    renderTicketBell: () => '',
    renderTicketAccountLine: () => '',
    renderTicketAccountGate: () => '',
    TICKET_FILTER_ME: '@me', ticketIsMine: () => false, ticketAgentRoster: { agents: [], loading: false }, ticketBulkStatusOptions: () => [], ticketPollPausedUntil: 0, ticketPollBackoff: () => {},
    ticketBulkFor: () => ({ selected: [], visibleRefs: [], running: false, summary: '', status: '' }), renderTicketBulkBar: () => '',
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    fetch: async url => { requests.push(url); return { json: async () => ({ ok: true, tickets: [], total: 0 }) }; },
  });
  vm.runInContext(['ticketWorkspaceView', 'ticketStatusTone', 'ticketStatusLabel', 'ticketTitle', 'ticketUpdatedLabel', 'ticketUiIcon', 'ticketScopedWho', 'ticketServerFilters', 'ticketListStale', 'ticketMatchesAgent', 'ticketActiveList', 'fetchTicketList', 'renderTicketExplorer', 'renderTicketStatus', 'renderEscalationSection', 'ticketReadAuthor', 'ticketReadFailure', 'searchTickets', 'refreshTicketInbox'].map(fn).join('\n'), context);
  context.renderTicketSlot = () => {};
  return { state, context, requests, run: code => vm.runInContext(code, context) };
}

test('the installed widget: Retention keeps all four tabs, Customer Service gets Tickets and Knowledge, an unknown department hides nothing', () => {
  const tabs = (settings) => {
    const context = vm.createContext({ previewMode: false, BLAST_LIVE: true, ESCALATION_TICKET_ENABLED: true, DEPARTMENT_TABS_LIVE: true, DEPARTMENT_SEPARATION_ENABLED: true, currentDepartment: 'cs', departmentKnown: false, ...settings });
    vm.runInContext(fn('mainTabAvailability'), context);
    return JSON.parse(JSON.stringify(vm.runInContext('mainTabAvailability()', context)));
  };
  const all = { customer: true, tickets: true, blast: true, knowledge: true };
  assert.deepEqual(tabs({ currentDepartment: 'rtn', departmentKnown: true }), all);
  assert.deepEqual(tabs({ currentDepartment: 'cs', departmentKnown: true }), { customer: false, tickets: true, blast: false, knowledge: true });
  assert.deepEqual(tabs({ departmentKnown: false }), all, 'until LiveChat says, nothing is hidden');
  assert.equal(tabs({ currentDepartment: 'rtn', departmentKnown: true, BLAST_LIVE: false }).blast, false, 'the Blast switch still wins');
  assert.deepEqual(tabs({ DEPARTMENT_TABS_LIVE: false }), { customer: true, tickets: false, blast: true, knowledge: false }, 'with the rollout switch off the installed widget is as before');
  assert.match(app, /const DEPARTMENT_TABS_LIVE = false;/);
  assert.match(app, /const DEPARTMENT_SEPARATION_ENABLED = true;/);
});

test('Active includes unsolved tickets; solved, closed and completed tickets are separated', () => {
  const w = widget();
  for (const status of ['UNSOLVED_TICKET', 'PENDING_CUSTOMER', 'OPEN']) {
    w.context.ticket = { fields: { status } };
    assert.equal(w.run('ticketStatusTone(ticket)'), 'active');
  }
  for (const status of ['PYM_SOLVED', 'Closed', 'ONSITE_TEAM_DONE', 'X_VOID_TICKET']) {
    w.context.ticket = { fields: { status } };
    assert.equal(w.run('ticketStatusTone(ticket)'), 'solved');
  }
});

test('list filters apply to searched results too and escape ticket content', () => {
  const w = widget();
  w.context.ticketSearchResultsByChat.set('chat', { mode: 'search', total: 3, tickets: [
    { ref: 'TK1', raisedBy: { name: 'Alya' }, fields: { status: 'UNSOLVED_TICKET', query_type: '<script>bad</script>' } },
    { ref: 'TK2', raisedBy: { name: 'Alya' }, fields: { status: 'PYM_SOLVED' } },
    { ref: 'TK3', raisedBy: { name: 'Other' }, fields: { status: 'OPEN' } },
  ] });
  w.state.chat.ticketInboxFilter = 'active';
  w.state.chat.ticketExplorerAgent = 'Alya';
  const html = w.run('renderTicketExplorer("chat")');
  assert.match(html, /data-ref="TK1"/);
  assert.doesNotMatch(html, /data-ref="TK2"|data-ref="TK3"|<script>/);
  assert.match(html, /&lt;script>/);
});

test('the Agent filter has "Me" after "All agents": picking it lists only the tickets that are mine', () => {
  const w = widget();
  w.context.ticketBulkFor = () => ({ selected: [], visibleRefs: [], running: false, summary: '', status: '' });
  w.context.renderTicketBulkBar = () => '';
  w.context.ticketIsMine = ticket => ticket.ref === 'TK3';
  w.context.ticketSearchResultsByChat.set('chat', { mode: 'search', total: 3, tickets: [
    { ref: 'TK1', raisedBy: { name: 'Alya' }, fields: { status: 'OPEN' } },
    { ref: 'TK3', raisedBy: { name: 'Other' }, fields: { status: 'OPEN' } },
  ] });
  w.state.chat.ticketFiltersOpen = true;
  w.state.chat.ticketExplorerAgent = '@me';
  const choices = [];
  w.context.renderTicketChoice = (chat, field, value, options) => { choices.push({ field, value, options }); return `<choice ${field}>`; };
  const html = w.run('renderTicketExplorer("chat")');
  const agent = choices.find(choice => choice.field === 'filter:ticketExplorerAgent');
  assert.equal(agent.value, '@me', 'the filter is the custom dropdown and shows Me as picked');
  assert.deepEqual(JSON.parse(JSON.stringify(agent.options.slice(0, 2))), [{ value: 'all', label: 'All agents' }, { value: '@me', label: 'Me' }]);
  assert.deepEqual(choices.map(choice => choice.field), ['filter:ticketExplorerAgent', 'filter:ticketExplorerStatus', 'filter:ticketExplorerDepartment', 'filter:ticketExplorerMarket'], 'all four filters are custom dropdowns');
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /data-ref="TK3"/);
  assert.doesNotMatch(html, /data-ref="TK1"/);
});

test('the Agent filter lists every agent of the roster by name (picked by id) once it is loaded, and a roster agent filters the loaded tickets by id meanwhile', () => {
  const w = widget();
  w.context.ticketBulkFor = () => ({ selected: [], visibleRefs: [], running: false, summary: '', status: '' });
  w.context.renderTicketBulkBar = () => '';
  w.context.ticketAgentRoster = { agents: [{ id: 44, name: 'Ann' }, { id: 31, name: 'Bob' }, { id: 7, name: 'Abby' }], loading: false };
  w.context.ticketSearchResultsByChat.set('chat', { mode: 'all', total: 2, tickets: [
    { ref: 'TK1', raisedBy: { id: 31, name: 'Bob' }, assignees: [], fields: { status: 'OPEN' } },
    { ref: 'TK2', raisedBy: { id: 9, name: 'Zed' }, assignees: [{ id: 44, name: 'Ann' }], fields: { status: 'OPEN' } },
  ] });
  w.state.chat.ticketFiltersOpen = true;
  w.state.chat.ticketExplorerAgent = '#44';
  const choices = [];
  w.context.renderTicketChoice = (chat, field, value, options) => { choices.push({ field, value, options }); return ''; };
  const html = w.run('renderTicketExplorer("chat")');
  const agent = choices.find(choice => choice.field === 'filter:ticketExplorerAgent');
  assert.deepEqual([...agent.options.map(option => option.label)], ['All agents', 'Me', 'Abby', 'Ann', 'Bob'], 'sorted by name, including people on no loaded ticket');
  assert.deepEqual([...agent.options.map(option => option.value)], ['all', '@me', '#7', '#44', '#31']);
  assert.match(html, /data-ref="TK2"/);
  assert.doesNotMatch(html, /data-ref="TK1"/);
});

test('one main view is shown at a time and drafts survive switching back to the inbox', () => {
  const w = widget();
  w.state.chat.escalation.remarks = 'Keep this draft';
  assert.doesNotMatch(w.run('renderEscalationSection("chat")'), /data-action="submitEscalation"/);
  w.state.chat.ticketView = 'create';
  const create = w.run('renderEscalationSection("chat")');
  assert.match(create, /data-action="submitEscalation"/);
  assert.match(create, /data-field="amount"/);
  assert.doesNotMatch(create, /ticket-inbox-rows|ticket-search-input/);
  w.state.chat.ticketView = 'list';
  w.run('renderEscalationSection("chat")');
  assert.equal(w.state.chat.escalation.remarks, 'Keep this draft');
  w.state.chat.ticketView = 'create';
  w.context.ticketCreateInFlight.add('chat');
  assert.match(w.run('renderEscalationSection("chat")'), /disabled>Creating…/);
});

test('an inbox refresh in flight is shared, and a failure clears the loading state', async () => {
  const w = widget();
  let resolve;
  w.context.fetch = () => new Promise(done => { resolve = done; });
  const first = w.run('refreshTicketInbox("chat")');
  await w.run('refreshTicketInbox("chat")');
  assert.equal(w.context.ticketSearchResultsByChat.get('chat').loading, true);
  resolve({ json: async () => ({ ok: false, error: 'Service unavailable' }) });
  await first;
  assert.equal(w.context.ticketSearchResultsByChat.get('chat').loading, false);
  assert.equal(w.context.ticketSearchResultsByChat.get('chat').error, 'Service unavailable');
});

test('ticket polling updates an open ticket without replacing a creation form', async () => {
  const w = widget();
  let rendered = 0;
  w.state.chat.ticketRecord = { ref: 'TK1' };
  Object.assign(w.context, {
    activeMainTab: 'tickets', watchedTicketSnapshots: new Map([['TK1', {}]]),
    loadTicketStatus: async () => {}, chatListEl: { querySelector: () => ({}) }, document: { hidden: false },
    renderTicketSlot: () => { rendered++; },
  });
  vm.runInContext(fn('pollTicketUpdates'), w.context);
  w.state.chat.ticketView = 'create';
  await w.run('pollTicketUpdates()');
  assert.equal(rendered, 0);
  w.state.chat.ticketView = 'detail';
  await w.run('pollTicketUpdates()');
  assert.equal(rendered, 1);
});

test('every ticket value the widget prints reads as the ticket system shows it, not as the backend stores it', () => {
  const fallback = app.match(/const TICKET_FALLBACK_OPTIONS = \{[\s\S]*?\n\};/)[0];
  const context = vm.createContext({ Array, String, Boolean, ticketFields: [{ key: 'new_choice', type: 'SELECT' }, { key: 'remarks', type: 'LONGTEXT' }, { key: 'amount', type: 'NUMBER' }] });
  vm.runInContext([fallback, ...['ticketChoiceSlug', 'ticketChoiceDisplayLabel', 'ticketFieldDisplay', 'ticketValueDisplay'].map(fn)].join('\n'), context);
  const show = (key, value) => vm.runInContext(`ticketValueDisplay(${JSON.stringify(key)}, ${JSON.stringify(value)})`, context);
  assert.equal(show('query_type', 'vvip_ltv_70_bonus'), 'VVIP LTV 70 BONUS');
  assert.equal(show('query_type', 'dp_not_credited'), 'DP NOT CREDITED');
  assert.equal(show('status', 'PYM_SOLVED'), 'PYM TEAM SOLVED');
  assert.equal(show('member_platform', 'pp96'), 'PP96');
  assert.equal(show('brand', 'rm68'), 'RM68');
  assert.equal(show('payment_gateway', 'KAAZPAY'), 'KAAZPAY');
  assert.equal(show('level', '9_and_above'), '9 and above');
  assert.equal(show('new_choice', 'some_new_choice'), 'SOME NEW CHOICE');
  assert.equal(show('query_type', ['vvip_ltv_70_bonus', 'wd_delay']), 'VVIP LTV 70 BONUS, WD DELAY');
  assert.equal(show('remarks', 'keep_this_text'), 'keep_this_text');
  assert.equal(show('amount', 150), '150');
  assert.equal(show('query_type', ''), '—');
});

test('admin preview: the department views apply, the installed widget is untouched while the rollout switch is off', () => {
  const tabs = (settings) => {
    const context = vm.createContext({ previewMode: false, BLAST_LIVE: true, ESCALATION_TICKET_ENABLED: true, DEPARTMENT_TABS_LIVE: false, DEPARTMENT_SEPARATION_ENABLED: true, currentDepartment: 'cs', departmentKnown: false, ...settings });
    vm.runInContext(fn('mainTabAvailability'), context);
    return JSON.parse(JSON.stringify(vm.runInContext('mainTabAvailability()', context)));
  };
  assert.deepEqual(tabs({ previewMode: false, currentDepartment: 'cs', departmentKnown: true }), { customer: true, tickets: false, blast: true, knowledge: false }, 'installed widget: as before');
  assert.deepEqual(tabs({ previewMode: true, currentDepartment: 'cs', departmentKnown: true }), { customer: false, tickets: true, blast: false, knowledge: true });
  assert.deepEqual(tabs({ previewMode: true, currentDepartment: 'rtn', departmentKnown: true }), { customer: true, tickets: true, blast: true, knowledge: true });
});

test('detectDepartment: the installed widget is never asked; the preview can force a department with ?department=', async () => {
  const run = async (settings) => {
    const log = { resolved: [], applied: [] };
    const context = vm.createContext({
      URLSearchParams, previewMode: true, DEPARTMENT_TABS_LIVE: false, DEPARTMENT_SEPARATION_ENABLED: true, location: { search: '' },
      resolveLoggedInDepartment: async () => { log.resolved.push(1); return { department: 'rtn' }; },
      setDepartmentFromGroups: (groups) => log.applied.push(Array.from(groups)),
      logDiagnostic() {}, forgetDepartment() { log.forgotten = (log.forgotten || 0) + 1; }, ...settings,
    });
    vm.runInContext(fn('detectDepartment'), context);
    const department = await vm.runInContext('detectDepartment("lc1", "tok")', context);
    return { department, ...log };
  };
  assert.deepEqual(await run({ previewMode: false }), { department: '', resolved: [], applied: [] }, 'installed widget, switch off');
  assert.equal((await run({ previewMode: false, DEPARTMENT_TABS_LIVE: true })).department, 'rtn', 'installed widget once the rollout switch is on');
  assert.equal((await run({})).department, 'rtn', 'preview: asked of LiveChat');
  const forcedCs = await run({ location: { search: '?department=cs' } });
  assert.deepEqual([forcedCs.department, forcedCs.resolved.length, forcedCs.applied], ['cs', 0, [[]]]);
  const forcedRtn = await run({ location: { search: '?department=rtn' } });
  assert.deepEqual([forcedRtn.department, forcedRtn.applied], ['rtn', [['Priority 96']]]);
  assert.equal((await run({ previewMode: false, DEPARTMENT_TABS_LIVE: true, location: { search: '?department=cs' } })).department, 'rtn', 'the override only exists in the preview');
  const failing = await run({ resolveLoggedInDepartment: async () => { throw new Error('boom'); } });
  assert.equal(failing.department, '', 'a failed check hides nothing');
});

test('Customer Service keeps Settings with Diagnostics and Sign out, and can close the panel without an agent name', () => {
  const view = (settings) => {
    const context = vm.createContext({ DEPARTMENT_SEPARATION_ENABLED: true, previewMode: true, DEPARTMENT_TABS_LIVE: false, departmentKnown: true, currentDepartment: 'cs', ...settings });
    vm.runInContext(fn('isCustomerServiceView'), context);
    return vm.runInContext('isCustomerServiceView()', context);
  };
  assert.equal(view({}), true);
  assert.equal(view({ currentDepartment: 'rtn' }), false);
  assert.equal(view({ departmentKnown: false }), false, 'an unknown department is not treated as Customer Service');
  assert.equal(view({ previewMode: false }), false, 'the installed widget while the rollout switch is off');
  assert.equal(view({ previewMode: false, DEPARTMENT_TABS_LIVE: true }), true);

  const chrome = app.slice(app.indexOf('function applyDepartmentChrome'), app.indexOf('async function resolveLoggedInDepartment'));
  assert.match(chrome, /settingsButton\.hidden = false;/);
  assert.match(chrome, /agentBadge\) agentBadge\.hidden = !rtn;/);
  const panel = app.slice(app.indexOf('function openSettingsPanel'), app.indexOf('function renderDiagnosticsLog'));
  assert.match(panel, /selectedAgent \|\| customerService \?[^\n]*id="settingsClose"/);
  assert.match(panel, /customerService \? `<div class="settings-card">[^\n]*id="settingsSignOut"/);
  assert.match(panel, /<summary>Diagnostics<\/summary>/);
  assert.match(panel, /getElementById\("settingsSave"\)\?\.addEventListener/);
});

test('a stale remembered department never outlives a failed check, and the chrome follows every department change', async () => {
  const log = [];
  const store = new Map([['rc-agent-department', 'cs']]);
  const context = vm.createContext({
    URLSearchParams, previewMode: true, DEPARTMENT_TABS_LIVE: false, DEPARTMENT_SEPARATION_ENABLED: true, location: { search: '' },
    DEPARTMENT_SESSION_KEY: 'rc-agent-department', currentDepartment: 'cs', departmentKnown: true, activeMainTab: 'tickets', activeChats: [],
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    applyDepartmentChrome: () => log.push('chrome'), syncMainTabs: () => log.push('tabs'), renderChats: () => log.push('render'),
    resolveLoggedInDepartment: async () => { throw new Error('LiveChat down'); }, logDiagnostic() {},
  });
  vm.runInContext(['forgetDepartment', 'detectDepartment', 'departmentFromGroups', 'setDepartmentFromGroups'].map(fn).join('\n'), context);
  assert.equal(await vm.runInContext('detectDepartment("lc1", "tok")', context), '');
  assert.equal(vm.runInContext('departmentKnown', context), false, 'the remembered department no longer counts');
  assert.equal(store.has('rc-agent-department'), false);
  assert.deepEqual(log.slice(0, 2), ['chrome', 'tabs']);
  log.length = 0;
  vm.runInContext('setDepartmentFromGroups(["Priority 96"])', context);
  assert.equal(vm.runInContext('currentDepartment', context), 'rtn');
  assert.ok(log.includes('chrome') && log.includes('tabs'), 'Settings and the badge follow a department change');
  assert.equal(store.get('rc-agent-department'), 'rtn');
});

test('polling pauses while the widget is hidden, and polls from the server copy while it is shown', async () => {
  const w = widget();
  const calls = [];
  w.state.chat.ticketRecord = { ref: 'TK1' };
  Object.assign(w.context, {
    activeMainTab: 'tickets', watchedTicketSnapshots: new Map([['TK1', {}]]), document: { hidden: true },
    loadTicketStatus: async (...args) => { calls.push(args); }, chatListEl: { querySelector: () => ({}) }, renderTicketSlot: () => {},
  });
  vm.runInContext(fn('pollTicketUpdates'), w.context);
  w.state.chat.ticketView = 'detail';
  await w.run('pollTicketUpdates()');
  assert.equal(calls.length, 0, 'hidden: no call to the shared ticket API');
  w.context.document.hidden = false;
  await w.run('pollTicketUpdates()');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['chat', 'TK1', { fresh: false }]]);
});

test('explicit reads skip the server copy; the automatic first load and the poll use it', () => {
  assert.ok(app.includes('async function loadTicketStatus(chatId, ref, { silent = false, fresh = true } = {}) {'));
  assert.ok(app.includes('`/ticket-status?ref=${encodeURIComponent(normalized)}${fresh ? "&fresh=1" : ""}`'));
  assert.ok(app.includes('${fresh ? "&fresh=1" : ""}`);'));
  assert.equal((app.match(/refreshTicketInbox\([^)]*\{ fresh: false \}\)/g) || []).length, 5, 'the two automatic loads, the load once the account is found, and the two when a filter is changed (while a read is on its way, and after it)');
});

test('a ticket value shows the ticket system\'s own label from /ticket-config before any built-in guess', () => {
  const fallback = app.match(/const TICKET_FALLBACK_OPTIONS = \{[\s\S]*?\n\};/)[0];
  const context = vm.createContext({ Array, String, Boolean, ticketFields: [
    { key: 'payment_gateway', type: 'SELECT', options: [{ value: 'dumpling_pay_dpp', label: 'DUMPLING PAY (DPP)' }, { value: 'KAAZPAY', label: 'KAAZPAY' }] },
    { key: 'query_type', type: 'SELECT', options: [{ value: 'brand_new_choice', label: 'A Brand New Choice' }] },
  ] });
  vm.runInContext([fallback, ...['ticketChoiceSlug', 'ticketChoiceDisplayLabel', 'ticketFieldDisplay', 'ticketValueDisplay'].map(fn)].join('\n'), context);
  const show = (key, value) => vm.runInContext(`ticketValueDisplay(${JSON.stringify(key)}, ${JSON.stringify(value)})`, context);
  assert.equal(show('payment_gateway', 'dumpling_pay_dpp'), 'DUMPLING PAY (DPP)');
  assert.equal(show('payment_gateway', 'KAAZPAY'), 'KAAZPAY');
  assert.equal(show('query_type', 'brand_new_choice'), 'A Brand New Choice', 'a choice added after this widget was built');
  assert.equal(show('query_type', 'vvip_ltv_70_bonus'), 'VVIP LTV 70 BONUS', 'still the built-in list when the live one lacks it');
});

test('"Ticket account not found": the widget asks for the ticket account email, sends it with the ticket and remembers it', () => {
  const store = new Map();
  const context = vm.createContext({ localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, String });
  vm.runInContext(['const ticketEmailKey = (accountKey) => `rc-ticket-email:${accountKey || ""}`;', fn('storedTicketEmail'), fn('storeTicketEmail')].join('\n'), context);
  assert.equal(vm.runInContext('storedTicketEmail("lc1")', context), '');
  vm.runInContext('storeTicketEmail("lc1", " Alice@Company.com ")', context);
  assert.equal(vm.runInContext('storedTicketEmail("lc1")', context), 'alice@company.com');
  assert.equal(vm.runInContext('storedTicketEmail("lc2")', context), '', 'remembered per LiveChat account');
  // The create form shows the box only after the server said the account was not found, and a typed value is what gets sent.
  assert.ok(app.includes('${s.ticketEmailNeeded ? `<div class="escalation-field escalation-field-wide"><label class="field-label"'));
  assert.ok(app.includes('data-field=\\"ticketEmail\\"') || app.includes('data-field="ticketEmail"'));
  assert.ok(app.includes('ticketEmail: s.escalation.ticketEmail || storedTicketEmail(currentLiveChatAccount)'));
  assert.ok(app.includes('if (data.needTicketEmail) s.ticketEmailNeeded = true;'));
});

// ---- comments in the widget ---------------------------------------------------------------------------------
function commentWorld(over = {}) {
  const calls = { fetches: [], problems: [], loads: [], renders: 0 };
  const state = { chat: { escalation: { commentDraft: 'Customer confirmed.' }, ticketRecord: { ref: 'TK2610150001' }, commentReplyTo: null, escalationError: '' } };
  const context = vm.createContext({
    state, Set, Map, String, Number, JSON, Array, Boolean, currentLiveChatAccount: 'lc1',
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    liveChatAgentTokens: () => ({ lc1: 'tok' }), storedTicketEmail: () => '', storeTicketEmail: (account, email) => { calls.stored = [account, email]; },
    renderTicketSlot: () => { calls.renders += 1; },
    noteTicketAccountUsed: () => {}, ticketNoteRemember: () => {}, ticketNoteRemember: () => {},
    loadTicketStatus: async (...args) => { calls.loads.push(args); },
    showTicketProblem: (chatId, failure, retry) => { calls.problems.push({ chatId, failure, retry }); },
    fetch: async (url, options) => { calls.fetches.push({ url, body: JSON.parse(options.body) }); return { json: async () => (over.reply || { ok: true, comment: { id: 9 } }) }; },
    ...over.context,
  });
  vm.runInContext(['const ticketCommentInFlight = new Set();', 'const ticketCommentFilesByChat = new Map();', app.match(/const TICKET_IMAGE_LINK = [^\n]+;/)[0], 'const ticketImageUrls = new Map();', app.match(/const isTicketImage = [^\n]+;/)[0], 'const commentFileUrl = () => "blob:x";', 'function clearCommentFiles(chatId) { ticketCommentFilesByChat.delete(chatId); }', fn('splitImageLinks'), fn('renderTicketThumb'), fn('renderCommentFiles'), fn('ticketAuthor'), fn('renderTicketComment'), fn('renderTicketConversation'), fn('sendTicketComment')].join('\n'), context);
  return { state, calls, context, run: (code) => vm.runInContext(code, context) };
}

test('comments: the thread shows authors, times, replies, files and a deleted comment without its text; everything is escaped', () => {
  const w = commentWorld();
  const html = w.run(`renderTicketConversation('chat', state.chat, ${JSON.stringify([
    { id: 41, author: { id: 7, name: 'Alice' }, body: '<b>deposit</b>?', createdAt: '2026-10-15T08:01:00.000Z', attachments: [{ name: 'slip.png' }], replies: [{ id: 42, author: { id: 8, name: 'Bob' }, body: 'Done.' }] },
    { id: 43, author: { id: 9, name: 'Cara' }, deleted: true, body: '' },
    { author: 'R. Maxine', role: 'CS agent', time: '29 Sep · 8:31 PM', body: 'sample style' },
  ])})`);
  assert.match(html, /&lt;b&gt;deposit&lt;\/b&gt;\?/);
  assert.doesNotMatch(html, /<b>deposit/);
  assert.match(html, /ticket-comment-reply[\s\S]*Bob[\s\S]*Done\./);
  assert.match(html, /📎 slip\.png/);
  assert.match(html, /This comment was deleted/);
  assert.match(html, /R\. Maxine[\s\S]*CS agent[\s\S]*sample style/);
  assert.equal((html.match(/data-action="replyTicketComment"/g) || []).length, 1, 'only a live top-level comment with an id can be replied to');
  assert.match(html, /data-field="commentDraft"[^>]*>Customer confirmed\.<\/textarea>/);
  assert.match(w.run('renderTicketConversation("chat", state.chat, [])'), /No comments yet/);
});

test('comments: replying shows who to, and the box says Sending while it is on its way', () => {
  const w = commentWorld();
  w.state.chat.commentReplyTo = 41;
  const html = w.run(`renderTicketConversation('chat', state.chat, [{ id: 41, author: { name: 'Alice' }, body: 'hi' }])`);
  assert.match(html, /Replying to Alice/);
  assert.match(html, /data-action="cancelReplyTicketComment"/);
  w.run('ticketCommentInFlight.add("chat")');
  assert.match(w.run('renderTicketConversation("chat", state.chat, [])'), /disabled>Sending…/);
});

test('comments: sending posts as the signed-in agent, clears the box and reloads the ticket', async () => {
  const w = commentWorld();
  w.state.chat.commentReplyTo = 41;
  w.state.chat.escalation.ticketEmail = 'alice@company.com';
  await w.run('sendTicketComment("chat")');
  assert.equal(w.calls.fetches.length, 1);
  assert.equal(w.calls.fetches[0].url, '/ticket-comment');
  assert.deepEqual(w.calls.fetches[0].body, { ref: 'TK2610150001', body: 'Customer confirmed.', parentId: 41, author: { accountKey: 'lc1', agentToken: 'tok', ticketEmail: 'alice@company.com' } });
  assert.equal(w.state.chat.escalation.commentDraft, '');
  assert.equal(w.state.chat.commentReplyTo, null);
  assert.deepEqual(w.calls.stored, ['lc1', 'alice@company.com']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.loads)), [['chat', 'TK2610150001', { silent: true }]]);
  assert.equal(w.run('ticketCommentInFlight.size'), 0);
});

test('comments: an empty box sends nothing; a refusal keeps the text and opens the dialog, which sends again with the typed email', async () => {
  const empty = commentWorld();
  empty.state.chat.escalation.commentDraft = '   ';
  await empty.run('sendTicketComment("chat")');
  assert.equal(empty.calls.fetches.length, 0);
  assert.equal(empty.state.chat.escalationError, 'Write a comment first.');

  const refused = commentWorld({ reply: { ok: false, needTicketEmail: true, triedEmail: 'alice@x.com', error: 'Ticket account not found. Please enter your ticket account email.' } });
  await refused.run('sendTicketComment("chat")');
  assert.equal(refused.state.chat.escalation.commentDraft, 'Customer confirmed.', 'the text is kept');
  assert.match(refused.state.chat.escalationError, /Comment failed: Ticket account not found/);
  assert.equal(refused.calls.problems.length, 1);
  assert.equal(refused.calls.problems[0].failure.needTicketEmail, true);
  assert.equal(refused.run('ticketCommentInFlight.size'), 0);
  refused.state.chat.escalation.ticketEmail = 'alice@company.com';
  refused.context.fetch = async (url, options) => { refused.calls.fetches.push({ url, body: JSON.parse(options.body) }); return { json: async () => ({ ok: true, comment: { id: 1 } }) }; };
  await refused.calls.problems[0].retry();
  assert.equal(refused.calls.fetches.at(-1).body.author.ticketEmail, 'alice@company.com');
});

test('ticket problems open a dialog: the email box for "account not found", a message for anything else; creating a ticket retries by pressing its button again', () => {
  assert.ok(app.includes('if (failure) showTicketProblem(chatId, failure, () => resubmitTicket(chatId));'));
  assert.ok(app.includes('failure = data; if (data.needTicketEmail) s.ticketEmailNeeded = true;'));
  const dialog = fn('showTicketProblem');
  assert.match(dialog, /Ticket account not found/);
  assert.match(dialog, /Save and try again/);
  assert.match(dialog, /state\[chatId\]\.escalation\.ticketEmail = value;[\s\S]*retry\(\);/);
  assert.match(fn('resubmitTicket'), /data-action="submitEscalation"/);
  for (const action of ['sendTicketComment', 'replyTicketComment', 'cancelReplyTicketComment']) assert.ok(app.includes(`btn.dataset.action === "${action}"`), action);
});

// ---- the ticket account line -------------------------------------------------------------------------------
function accountWorld(over = {}) {
  const calls = { fetches: [], renders: 0, stored: null, problems: [], inbox: [], timers: [] };
  const state = { chat: { escalation: { ticketEmail: over.typed || '' } } };
  const context = vm.createContext({
    state, JSON, Date, Number, String, Object, setTimeout: (callback, ms) => { calls.timers.push({ callback, ms }); }, currentLiveChatAccount: 'lc1', ticketConfigError: '', ticketFields: [{ key: 'member_id' }], fetchTicketConfig: async () => { calls.config = (calls.config || 0) + 1; },
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    pollTicketNotifications: async () => {}, queueMicrotask, ticketWorkspaceView: () => 'list', ticketSearchResultsByChat: new Map(), refreshTicketInbox: async (...args) => { calls.inbox.push(args); },
    showTicketProblem: (chatId, failure, retry) => { calls.problems.push({ chatId, failure, retry }); },
    ticketAuthor: () => (over.signedOut ? undefined : { accountKey: 'lc1', agentToken: 'tok', ticketEmail: over.typed || '' }),
    storeTicketEmail: (account, email) => { calls.stored = [account, email]; },
    renderTicketSlot: () => { calls.renders += 1; }, pollTicketNotifications: async () => {},
    fetch: async (url, options) => { calls.fetches.push({ url, body: JSON.parse(options.body) }); if (over.fail) throw new Error('boom'); return { json: async () => over.reply }; },
  });
  vm.runInContext(['let ticketAccount = { status: "unknown", email: "", source: "", message: "", checking: false, at: 0, shownUntil: 0 };', 'const TICKET_ACCOUNT_RECHECK_MS = 5 * 60_000;', 'const TICKET_ACCOUNT_FOUND_SHOWN_MS = 6000;', fn('hideTicketAccountLineLater'), fn('checkTicketAccount'), fn('noteTicketAccountUsed'), fn('renderTicketAccountLine'), 'const TICKET_ACCOUNT_BLOCKING = ["notFound", "noEmail", "adminEmailInvalid", "keyNeedsGrant", "outranks"];', fn('ticketAccountBlocks'), fn('renderTicketAccountGate')].join('\n'), context);
  return { state, calls, run: (code) => vm.runInContext(code, context) };
}

test('ticket account line: it says found with the email and where it came from, or not found with a button to enter it', async () => {
  const found = accountWorld({ reply: { ok: true, enabled: true, status: 'found', email: 'alice@company.com', source: 'ticket-email' } });
  await found.run('checkTicketAccount("chat")');
  assert.equal(found.calls.fetches[0].url, '/ticket-account');
  assert.deepEqual(found.calls.fetches[0].body, { author: { accountKey: 'lc1', agentToken: 'tok', ticketEmail: '' } });
  let html = found.run('renderTicketAccountLine("chat")');
  assert.match(html, /✓ Ticket account found: <strong>alice@company\.com<\/strong>[\s\S]*your saved Ticket Email/);
  const missing = accountWorld({ reply: { ok: true, enabled: true, status: 'notFound', email: 'alice@x.com', source: 'livechat' } });
  await missing.run('checkTicketAccount("chat")');
  html = missing.run('renderTicketAccountLine("chat")');
  assert.match(html, /✗ Ticket account not found for <strong>alice@x\.com<\/strong>/);
  assert.match(html, /data-action="enterTicketEmail"/);
  for (const [status, pattern] of [['noEmail', /No ticket account email for you/], ['adminEmailInvalid', /Ask your admin to correct it/], ['keyNeedsGrant', /api-keys:act-on-behalf/], ['outranks', /senior to the integration key/]]) {
    const w = accountWorld({ reply: { ok: true, enabled: true, status, email: 'a@b.co', source: 'ticket-email' } });
    await w.run('checkTicketAccount("chat")');
    assert.match(w.run('renderTicketAccountLine("chat")'), pattern, status);
  }
});

test('ticket account line: nothing is shown when the feature is off or nobody is signed in; a check is not repeated within five minutes; a failure is shown, not hidden', async () => {
  const off = accountWorld({ reply: { ok: true, enabled: false } });
  await off.run('checkTicketAccount("chat")');
  assert.equal(off.run('renderTicketAccountLine("chat")'), '');
  const signedOut = accountWorld({ signedOut: true, reply: {} });
  await signedOut.run('checkTicketAccount("chat")');
  assert.equal(signedOut.calls.fetches.length, 0);
  const again = accountWorld({ reply: { ok: true, enabled: true, status: 'found', email: 'a@b.co', source: 'livechat' } });
  await again.run('checkTicketAccount("chat")');
  await again.run('checkTicketAccount("chat")');
  assert.equal(again.calls.fetches.length, 1);
  await again.run('checkTicketAccount("chat", { force: true })');
  assert.equal(again.calls.fetches.length, 2, 'force asks again');
  const broken = accountWorld({ fail: true });
  await broken.run('checkTicketAccount("chat")');
  assert.match(broken.run('renderTicketAccountLine("chat")'), /Could not check your ticket account: boom/);
  const used = accountWorld({ reply: {} });
  used.run('noteTicketAccountUsed({ actedAs: "alice@company.com" })');
  assert.equal(used.run('renderTicketAccountLine("chat")'), '', 'a ticket made as the agent confirms the account without showing the line again');
  assert.match(used.run('renderTicketAccountLine("chat", { always: true })'), /✓ Ticket account found: <strong>alice@company\.com/);
});

test('ticket account line: it sits at the top of every Tickets view, is checked when the tab is drawn, and Enter your ticket email opens the dialog', () => {
  assert.ok(app.includes('${renderTicketBell(chatId)}</span>'));
  assert.ok(app.includes('${renderTicketAccountLine(chatId)}'));
  assert.ok(app.includes('void checkTicketAccount(chat.chatId);'));
  assert.ok(app.includes('btn.dataset.action === "enterTicketEmail"'));
  assert.ok(app.includes('() => checkTicketAccount(chatId, { force: true })'));
});

test('ticket account gate: while it checks, and when the account is missing or cannot be acted for, only the account screen shows; found, off, failed or unknown lets the tab through', async () => {
  const gated = { notFound: /Ticket account not found/, noEmail: /No ticket account email/, adminEmailInvalid: /Ask your admin/, keyNeedsGrant: /api-keys:act-on-behalf/, outranks: /senior/ };
  for (const [status, pattern] of Object.entries(gated)) {
    const w = accountWorld({ reply: { ok: true, enabled: true, status, email: 'a@b.co', source: 'livechat' } });
    await w.run('checkTicketAccount("chat")');
    assert.equal(w.run('ticketAccountBlocks()'), true, status);
    const html = w.run('renderTicketAccountGate("chat")');
    assert.match(html, pattern, status);
    assert.match(html, /data-action="recheckTicketAccount"/);
    assert.match(html, /has to be recognised before tickets can be used here/);
  }
  for (const [status, extra] of [['found', {}], ['off', { enabled: false }]]) {
    const w = accountWorld({ reply: { ok: true, enabled: status !== 'off', status, email: 'a@b.co', source: 'livechat', ...extra } });
    await w.run('checkTicketAccount("chat")');
    assert.equal(w.run('ticketAccountBlocks()'), false, status);
    assert.equal(w.run('renderTicketAccountGate("chat")'), '');
  }
  const failed = accountWorld({ fail: true });
  await failed.run('checkTicketAccount("chat")');
  assert.equal(failed.run('ticketAccountBlocks()'), false, 'a failed check does not lock anyone out');
  assert.equal(accountWorld({}).run('ticketAccountBlocks()'), false, 'nothing checked yet (nobody signed in)');
});

test('ticket account gate: the first screen is already "Checking your ticket account"; a missing account opens the email popup by itself; once found the inbox loads', async () => {
  const w = accountWorld({ reply: { ok: true, enabled: true, status: 'notFound', email: 'alice@x.com', source: 'livechat' } });
  const pending = w.run('checkTicketAccount("chat")');
  assert.equal(w.run('ticketAccountBlocks()'), true, 'blocked from the moment the check starts');
  assert.match(w.run('renderTicketAccountGate("chat")'), /Checking your ticket account…/);
  await pending;
  await Promise.resolve();
  assert.equal(w.calls.problems.length, 1);
  assert.equal(w.calls.problems[0].failure.needTicketEmail, true);
  assert.equal(w.calls.problems[0].failure.triedEmail, 'alice@x.com');
  assert.equal(w.calls.inbox.length, 0, 'no ticket calls while gated');
  const found = accountWorld({ reply: { ok: true, enabled: true, status: 'found', email: 'alice@x.com', source: 'livechat' } });
  await found.run('checkTicketAccount("chat")');
  assert.deepEqual(JSON.parse(JSON.stringify(found.calls.inbox)), [['chat', '', 'all', { fresh: false }]]);
  assert.equal(found.calls.problems.length, 0);
});

test('ticket account gate: it replaces every Tickets view and the automatic inbox loads wait for it', () => {
  assert.ok(app.includes('const gate = renderTicketAccountGate(chatId);'));
  assert.ok(app.includes('if (gate) return gate;'));
  assert.equal((app.match(/!ticketAccountBlocks\(\)\) void refreshTicketInbox/g) || []).length, 2);
  assert.ok(app.includes('btn.dataset.action === "recheckTicketAccount"'));
  const draw = app.indexOf('void checkTicketAccount(chat.chatId);');
  assert.ok(draw > 0 && draw < app.indexOf('card.innerHTML = renderAdminTicketWorkspace(chat);'), 'the check starts before the tab is drawn');
});

test('ticket account line: a refusal shows the ticket system\'s own words, in the line and in the dialog', async () => {
  const words = 'This API key is not bound to a role, so it may not act on behalf of other people.';
  const w = accountWorld({ reply: { ok: true, enabled: true, status: 'keyNeedsGrant', email: 'a@b.co', source: 'livechat', detail: words } });
  await w.run('checkTicketAccount("chat")');
  assert.match(w.run('renderTicketAccountLine("chat")'), /The ticket system said: "This API key is not bound to a role/);
  assert.ok(app.includes('The ticket system said: "${escapeHtml(failure.detail)}"'), 'the dialog for a refused ticket or comment says it too');
});

test('reads are made as the signed-in agent: the list, a ticket and the field lists send who they are; signed out they use the plain call', async () => {
  const w = widget();
  Object.assign(w.context, { liveChatAgentTokens: () => ({ lc1: 'tok' }), currentLiveChatAccount: 'lc1', storedTicketEmail: () => 'me@x.com' });
  const seen = [];
  w.context.fetch = async (url, options) => { seen.push([url, options && options.method, options && JSON.parse(options.body)]); return { json: async () => ({ ok: true, tickets: [], total: 0 }) }; };
  await w.run('searchTickets("chat", "abc", "search", { fresh: true })');
  assert.deepEqual(seen[0], ['/ticket-list', 'POST', { q: 'abc', fresh: true, author: { accountKey: 'lc1', agentToken: 'tok', ticketEmail: 'me@x.com' } }]);
  Object.assign(w.context, { liveChatAgentTokens: () => ({}) });
  await w.run('searchTickets("chat", "abc", "search", { fresh: false })');
  assert.equal(seen[1][0], '/ticket-list?q=abc');
  assert.ok(app.includes('? await fetch("/ticket-status", { method: "POST"'));
  assert.ok(app.includes('? await fetch("/ticket-config", { method: "POST"'));
  assert.ok(app.includes('if (data.status === "found" && (ticketConfigError || !ticketFields.length)) await fetchTicketConfig({ fresh: true });'));
});

test('a refused read asks for the ticket email like a refused ticket does', () => {
  const w = widget();
  const problems = [];
  Object.assign(w.context, { showTicketProblem: (...args) => problems.push(args), checkTicketAccount: async () => {} });
  const error = w.run('ticketReadFailure("chat", { ok: false, needTicketEmail: true, error: "Ticket account not found. Please enter your ticket account email." }, "x")');
  assert.equal(error.message, 'Ticket account not found. Please enter your ticket account email.');
  return Promise.resolve().then(() => assert.equal(problems.length, 1));
});

test('pictures: a comment shows its pictures as thumbnails (the ticket system\'s by path, this site\'s by link), the link text is hidden, other files stay names', () => {
  const w = commentWorld();
  const link = 'https://app.test/ticket-image?k=tickets%2F20261017%2F3f2a9c1e-0000-4000-8000-123456789abc.png';
  const html = w.run(`renderTicketComment(${JSON.stringify({ id: 1, author: { name: 'Mike' }, body: `done team\n\nImages:\n${link}`, attachments: [{ name: 'slip.webp', mime: 'image/webp', path: '2026-10/17/aa.webp' }, { name: 'a.pdf', mime: 'application/pdf', path: '2026-10/17/a.pdf' }] })}, 'chat')`);
  assert.match(html, /data-ticket-image="2026-10\/17\/aa\.webp"/);
  assert.match(html, /<img src="https:\/\/app\.test\/ticket-image\?k=tickets%2F20261017/);
  assert.match(html, /data-action="openTicketImage"/);
  assert.ok(!html.includes('Images:'), 'the link text is replaced by the picture');
  assert.match(html, /done team/);
  assert.match(html, /📎 a\.pdf/);
  assert.ok(!html.includes('data-ticket-image="2026-10/17/a.pdf"'), 'a PDF is not shown as a picture');
});

test('pictures: only this site\'s picture links are turned into pictures, never a link someone typed', () => {
  const w = commentWorld();
  const html = w.run(`renderTicketComment(${JSON.stringify({ id: 1, author: { name: 'X' }, body: 'see https://evil.test/track.png and https://evil.test/page' })}, 'chat')`);
  assert.ok(!html.includes('<img'), 'nothing is fetched from an arbitrary address');
  assert.match(html, /https:\/\/evil\.test\/track\.png/);
});

test('pictures: the comment box shows what is waiting, sends it as multipart with the text, and clears it', async () => {
  const w = commentWorld({ context: { FormData, File } });
  w.state.chat.ticketRecord = { ref: 'TK2610170001' };
  w.state.chat.escalation.commentDraft = 'slip';
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', { type: 'image/png' });
  w.context.testPng = png;
  w.run('ticketCommentFilesByChat.set("chat", [testPng])');
  w.context.fetch = async (url, options) => { w.calls.fetches.push({ url, options }); return { json: async () => ({ ok: true, comment: { id: 9 } }) }; };
  assert.match(w.run('renderCommentFiles("chat")'), /p\.png/);
  await w.run('sendTicketComment("chat")');
  const sent = w.calls.fetches[0];
  assert.equal(sent.url, '/ticket-comment');
  assert.ok(sent.options.body instanceof FormData);
  assert.equal(JSON.parse(sent.options.body.get('comment')).body, 'slip');
  assert.equal(sent.options.body.get('file').name, 'p.png');
  assert.equal(w.run('ticketCommentFilesByChat.has("chat")'), false, 'the files are cleared after sending');
});

test('pictures: paste in the comment box, attach button, remove, lightbox and loading are wired', () => {
  assert.ok(app.includes('event.target.closest?.(".ticket-comment-input")'));
  assert.ok(app.includes('closest?.(".ticket-comment-file-input")'));
  assert.ok(app.includes('btn.dataset.action === "removeCommentFile"'));
  assert.ok(app.includes('btn.dataset.action === "openTicketImage"'));
  assert.ok(app.includes('new MutationObserver(hydrateTicketImages).observe(chatListEl'));
  assert.ok(app.includes('fetch("/ticket-attachment", { method: "POST"'));
  assert.ok(app.includes('data-problem="open"'), 'a refused duplicate offers to open the existing ticket');
});

test('pictures: an attachment is a picture by its type or, when the ticket system leaves the type blank, by its name; one without a path cannot be shown', () => {
  const w = commentWorld();
  const html = w.run(`renderTicketComment(${JSON.stringify({ id: 1, author: { name: 'Mike' }, body: 'done', attachments: [{ name: 'pasted-1.webp', mime: '', path: '2026-10/13/aa.webp' }, { name: 'nopath.png', mime: 'image/png', path: '' }] })}, 'chat')`);
  assert.match(html, /data-ticket-image="2026-10\/13\/aa\.webp"/);
  assert.match(html, /📎 nopath\.png/);
});

test('pictures: a picture that cannot be loaded says why, on the thumbnail and in the diagnostics', () => {
  assert.ok(app.includes('thumb.classList.add("failed");'));
  assert.ok(app.includes('note.className = "ticket-thumb-error";'));
  assert.ok(app.includes('Could not show the picture'));
});

test('pictures: every picture is compressed before it is sent, to the same size and similar quality, and ticket and comment files all go through it', () => {
  assert.ok(app.includes('async function compressPicture(file)'));
  assert.equal((app.match(/map\(compressPicture\)/g) || []).length, 5, 'paste and choose, for tickets and for comments, and the proof dialog when a bonus is claimed');
  assert.ok(app.includes('const PICTURE_STEPS = [[1, 0.92]'), 'full size and high quality come first');
  assert.ok(!app.includes('TICKET_IMAGE_MAX_BYTES'), 'no 5MB image limit any more');
});

test('pictures: one the key cannot load opens in the ticket system instead (the agent is signed in there), and works with the lightbox otherwise', () => {
  assert.ok(app.includes('thumb.dataset.fallbackUrl = `https://tickets.96ghq.com/api/attachments/'));
  assert.ok(app.includes('if (btn.dataset.fallbackUrl) window.open(btn.dataset.fallbackUrl, "_blank", "noopener")'));
  assert.ok(app.includes('else if (img && img.src) openTicketImageLightbox'));
});
