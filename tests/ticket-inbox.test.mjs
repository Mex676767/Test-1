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
    previewMode: true, ticketConfigError: '', ticketDepartments: [], ticketMarkets: [], ticketNotifications: [],
    ticketFields: [{ key: 'member_id' }],
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
    renderTicketNotifications: () => '',
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    fetch: async url => { requests.push(url); return { json: async () => ({ ok: true, tickets: [], total: 0 }) }; },
  });
  vm.runInContext(['ticketWorkspaceView', 'ticketStatusTone', 'ticketStatusLabel', 'ticketTitle', 'ticketUpdatedLabel', 'ticketUiIcon', 'renderTicketExplorer', 'renderTicketStatus', 'renderEscalationSection', 'searchTickets', 'refreshTicketInbox'].map(fn).join('\n'), context);
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
    loadTicketStatus: async () => {}, chatListEl: { querySelector: () => ({}) },
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
      logDiagnostic() {}, ...settings,
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
