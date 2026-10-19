import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

const NAMES = ['ticketEditableSpecs', 'ticketEditStart', 'buildTicketEdit', 'describeTicketChanges', 'setTicketEditValue', 'saveTicketEdit'];
const SOURCE = ['const ticketEditByChat = new Map();', ...NAMES.map(fn)].join('\n');

const FIELDS = [
  { key: 'member_id', label: 'Member / User ID', type: 'TEXT' },
  { key: 'member_platform', label: 'Brand', type: 'SELECT' },
  { key: 'query_type', label: 'Query type', type: 'SELECT' },
  { key: 'status', label: 'Status', type: 'SELECT' },
  { key: 'transaction_id', label: 'Transaction ID', type: 'TEXT' },
  { key: 'payment_gateway', label: 'Payment Gateway', type: 'SELECT' },
  { key: 'amount', label: 'Amount', type: 'CURRENCY' },
  { key: 'remarks', label: 'Remarks', type: 'LONGTEXT' },
  { key: 'member_level', label: 'Level', type: 'SELECT' },
  { key: 'attachment', label: 'Attachment', type: 'ATTACHMENT' },
];
const SPECS = [
  { stateKey: 'memberUserId', keys: ['member_id'], labels: [] }, { stateKey: 'brand', keys: ['member_platform'], labels: [] },
  { stateKey: 'queries', keys: ['query_type'], labels: [] }, { stateKey: 'status', keys: ['status'], labels: [] },
  { stateKey: 'transactionId', keys: ['transaction_id'], labels: [] }, { stateKey: 'paymentGateway', keys: ['payment_gateway'], labels: [] },
  { stateKey: 'amount', keys: ['amount'], labels: [] }, { stateKey: 'remarks', keys: ['remarks'], labels: [] },
  { stateKey: 'vipLevel', keys: ['member_level'], labels: [] },
];
const TICKET = () => ({
  ref: 'TK2610190001',
  fields: { member_id: 'p1', member_platform: 'VS96', query_type: 'wd_delay', status: 'OPEN', amount: 58, remarks: 'first', attachment: [{ name: 'a.png' }] },
  currentDepartment: { id: 3, code: 'PYM', name: 'Payment' }, market: { id: 1, code: 'MYR', label: 'Malaysia' },
  assignees: [{ id: 44, name: 'Ann' }, { id: 31, name: 'Bob' }], comments: [{ id: 1, body: 'hi' }], commentCount: 1,
});

function world({ reply } = {}) {
  const calls = { fetches: [], renders: 0, statuses: [], problems: 0, absorbed: [], loads: 0 };
  const context = vm.createContext({
    Number, String, JSON, Object, Array, Promise, Map, Error,
    TICKET_FIELD_SPECS: SPECS, ticketFields: FIELDS,
    ticketFieldFor: (spec) => FIELDS.find((field) => spec.keys.includes(field.key)),
    state: { chat1: { escalation: {}, ticketRecord: TICKET(), ticketView: 'detail' } },
    ticketAuthor: () => ({ accountKey: 'lc1', agentToken: 't' }),
    renderTicketSlot: () => { calls.renders += 1; },
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.fetches.push({ url, body }); return { json: async () => (reply ? reply(body) : { ok: true, ref: body.ref, changed: [], visible: true, ticket: { ...TICKET(), comments: [] } }) }; },
    loadTicketStatus: async () => { calls.loads += 1; },
    rememberTicketSnapshot: () => {}, ticketNoteAbsorb: (ticket) => calls.absorbed.push(ticket.ref),
    noteTicketAccountUsed: () => {}, storeTicketEmail: () => {}, saveState: () => {},
    ticketSearchResultsByChat: new Map([['chat1', {}]]), currentLiveChatAccount: 'lc1',
    setStatus: (text, kind) => calls.statuses.push({ text, kind }),
    showTicketProblem: () => { calls.problems += 1; },
  });
  vm.runInContext(SOURCE, context);
  return { calls, context, run: (code) => vm.runInContext(code, context) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const start = (w) => w.run('ticketEditByChat.set("chat1", ticketEditStart(state.chat1.ticketRecord)); ticketEditByChat.get("chat1")');

test('the edit form starts from the ticket as it is: every field, the department, the market, nobody removed', () => {
  const w = world();
  const draft = plain(start(w));
  assert.deepEqual(draft.values, { memberUserId: 'p1', brand: 'VS96', queries: 'wd_delay', status: 'OPEN', transactionId: '', paymentGateway: '', amount: '58', remarks: 'first', vipLevel: '' });
  assert.deepEqual([draft.departmentCode, draft.marketCode, draft.removeIds, draft.editing], ['PYM', 'MYR', [], true]);
});

test('nothing changed means nothing is sent', () => {
  const w = world();
  start(w);
  assert.deepEqual(plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))')), { error: 'Nothing was changed.' });
});

test('only what changed is sent, with the value the agent saw as expect', () => {
  const w = world();
  start(w);
  w.run('setTicketEditValue("chat1", "status", "IN_PROGRESS"); setTicketEditValue("chat1", "remarks", "  Moved to payments "); setTicketEditValue("chat1", "amount", "60.5"); setTicketEditValue("chat1", "transactionId", "ABC")');
  const { payload } = plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))'));
  assert.deepEqual(payload.fields, { status: 'IN_PROGRESS', remarks: 'Moved to payments', amount: 60.5, transaction_id: 'ABC' });
  assert.deepEqual(payload.expect, { status: 'OPEN', remarks: 'first', amount: 58, transaction_id: null });
  assert.equal('toDepartment' in payload, false);
  assert.equal('market' in payload, false);
  assert.equal('assignees' in payload, false);
});

test('a field emptied by the agent is cleared (null), and a number that is not a number is refused before anything is sent', () => {
  const w = world();
  start(w);
  w.run('setTicketEditValue("chat1", "remarks", "")');
  assert.deepEqual(plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))')).payload.fields, { remarks: null });
  w.run('setTicketEditValue("chat1", "remarks", "first"); setTicketEditValue("chat1", "amount", "1,500")');
  assert.match(plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))')).error, /Amount must be a number/);
});

test('a field the form never held is not sent as cleared', () => {
  const w = world();
  start(w);
  w.run('delete ticketEditByChat.get("chat1").values.remarks; setTicketEditValue("chat1", "status", "SOLVED")');
  assert.deepEqual(plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))')).payload.fields, { status: 'SOLVED' });
});

test('department, market and assignees: moved, cleared, added and removed in the one request, each with what it was', () => {
  const w = world();
  start(w);
  w.run('setTicketEditValue("chat1", "departmentCode", "CS"); setTicketEditValue("chat1", "marketCode", ""); setTicketEditValue("chat1", "addPeople", " cara@x.com, Dan ;"); ticketEditByChat.get("chat1").removeIds = [31, 44]');
  const { payload } = plain(w.run('buildTicketEdit(state.chat1.ticketRecord, ticketEditByChat.get("chat1"))'));
  assert.equal(payload.toDepartment, 'CS');
  assert.equal(payload.market, null);
  assert.deepEqual(payload.assignees, { add: ['cara@x.com', 'Dan'], remove: [31, 44] });
  assert.deepEqual(payload.expect, { Department: 'PYM', Market: 'MYR' });
});

test('what changed is told in words, list changes by name', () => {
  const w = world();
  const say = (changed) => w.run(`describeTicketChanges(${JSON.stringify(changed)})`);
  assert.equal(say([{ key: 'status', label: 'Status', fromText: 'Open', toText: 'PYM PROCESSING' }, { key: 'assignee', label: 'Assignee', added: [{ id: 1, name: 'Ann Lee' }], removed: [{ id: 2, name: 'Bob Tan' }] }]),
    'Status: Open → PYM PROCESSING · Assignee: + Ann Lee − Bob Tan');
  assert.match(say([]), /Nothing needed to change/);
});

test('saving: the request carries the ref, the changes and the agent; the ticket is replaced but keeps its conversation, and the inbox list is dropped', async () => {
  const w = world({ reply: () => ({ ok: true, ref: 'TK2610190001', changed: [{ key: 'status', label: 'Status', fromText: 'Open', toText: 'PYM PROCESSING' }], visible: true, ticket: { ...TICKET(), fields: { ...TICKET().fields, status: 'IN_PROGRESS' }, comments: [] } }) });
  start(w);
  w.run('setTicketEditValue("chat1", "status", "IN_PROGRESS")');
  await w.run('saveTicketEdit("chat1")');
  const sent = w.calls.fetches[0];
  assert.equal(sent.url, '/ticket-update');
  assert.equal(sent.body.ref, 'TK2610190001');
  assert.deepEqual(sent.body.fields, { status: 'IN_PROGRESS' });
  assert.equal(sent.body.author.accountKey, 'lc1');
  assert.equal(w.run('state.chat1.ticketRecord.fields.status'), 'IN_PROGRESS');
  assert.equal(w.run('state.chat1.ticketRecord.comments.length'), 1, 'the conversation is kept');
  const draft = plain(w.run('ticketEditByChat.get("chat1")'));
  assert.equal(draft.editing, false);
  assert.match(draft.notice, /^Saved\. Status: Open → PYM PROCESSING/);
  assert.equal(w.run('ticketSearchResultsByChat.has("chat1")'), false);
  assert.deepEqual(w.calls.absorbed, ['TK2610190001']);
});

test('saving twice at once sends one request', async () => {
  const w = world();
  start(w);
  w.run('setTicketEditValue("chat1", "status", "IN_PROGRESS")');
  await Promise.all([w.run('saveTicketEdit("chat1")'), w.run('saveTicketEdit("chat1")')]);
  assert.equal(w.calls.fetches.length, 1);
});

test('a refusal stays on the form with its message and the typed changes kept', async () => {
  const w = world({ reply: () => ({ ok: false, code: 'field_forbidden', error: 'Your role may view "Status" but not change it.' }) });
  start(w);
  w.run('setTicketEditValue("chat1", "status", "SOLVED")');
  await w.run('saveTicketEdit("chat1")');
  const draft = plain(w.run('ticketEditByChat.get("chat1")'));
  assert.equal(draft.editing, true);
  assert.equal(draft.error, 'Your role may view "Status" but not change it.');
  assert.equal(draft.values.status, 'SOLVED');
  assert.equal(draft.busy, false);
});

test('someone else changed it first (412): nothing is saved, the ticket is reloaded and the agent is told what it is now', async () => {
  const w = world({ reply: () => ({ ok: false, code: 'precondition_failed', error: 'x', mismatched: [{ name: 'Status', key: 'status', expected: 'OPEN', actual: 'SOLVED' }] }) });
  start(w);
  w.run('setTicketEditValue("chat1", "status", "IN_PROGRESS")');
  await w.run('saveTicketEdit("chat1")');
  const draft = plain(w.run('ticketEditByChat.get("chat1")'));
  assert.equal(draft.editing, false);
  assert.match(draft.notice, /Someone changed this ticket.*Status is now SOLVED.*nothing was saved/s);
  assert.equal(w.calls.loads, 1);
});

test('a ticket account that is not found asks for the email and tries the same save again afterwards', async () => {
  const w = world({ reply: () => ({ ok: false, needTicketEmail: true, error: 'Ticket account not found.' }) });
  start(w);
  w.run('setTicketEditValue("chat1", "status", "IN_PROGRESS")');
  await w.run('saveTicketEdit("chat1")');
  assert.equal(w.calls.problems, 1);
  assert.equal(plain(w.run('ticketEditByChat.get("chat1")')).editing, true, 'the form stays open');
});

test('a change that takes the ticket out of the agent\'s reach is saved and the inbox is shown instead', async () => {
  const w = world({ reply: () => ({ ok: true, ref: 'TK2610190001', changed: [{ key: 'department', label: 'Department', fromText: 'PYM', toText: 'CS' }], visible: false }) });
  start(w);
  w.run('setTicketEditValue("chat1", "departmentCode", "CS")');
  await w.run('saveTicketEdit("chat1")');
  assert.equal(w.run('state.chat1.ticketRecord'), null);
  assert.equal(w.run('state.chat1.ticketView'), 'list');
  assert.match(w.calls.statuses.at(-1).text, /Saved\. Department: PYM → CS.*no longer see TK2610190001/);
});

test('the edit controls exist in the ticket detail and are wired (edit, cancel, remove a person, save, choices, typing)', () => {
  for (const action of ['editTicket', 'cancelTicketEdit', 'toggleEditAssignee', 'saveTicketEdit']) {
    assert.ok(app.includes(`data-action="${action}"`), `${action} button`);
    assert.ok(app.includes(`btn.dataset.action === "${action}"`), `${action} handler`);
  }
  assert.ok(app.includes('btn.dataset.field.startsWith("edit:")'), 'a chosen option goes to the edit draft');
  assert.ok(app.includes('escInput.dataset.field.startsWith("edit:")'), 'typing goes to the edit draft');
  assert.ok(app.includes('url.pathname === "/ticket-update"'), 'the demo mode sends nothing to the ticket system');
});
