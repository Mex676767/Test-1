import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

const NAMES = ['ticketEditFor', 'ticketEditableSpecs', 'ticketFieldText', 'buildTicketChange', 'describeTicketChanges', 'ticketChangeFor', 'ticketLiveTyping', 'ticketForgetTyping', 'commitTicketChange', 'saveTicketChange'];
const SOURCE = ['const ticketEditByChat = new Map(); const ticketSaveChains = new Map();', ...NAMES.map(fn)].join('\n');

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
const TICKET = (extra = {}) => ({
  ref: 'TK2610190001',
  fields: { member_id: 'p1', member_platform: 'VS96', query_type: 'wd_delay', status: 'OPEN', amount: 58, remarks: 'first', attachment: [{ name: 'a.png' }] },
  currentDepartment: { id: 3, code: 'PYM', name: 'Payment' }, market: { id: 1, code: 'MYR', label: 'Malaysia' },
  assignees: [{ id: 44, name: 'Ann' }, { id: 31, name: 'Bob' }], comments: [{ id: 1, body: 'hi' }], commentCount: 1, updatedAt: '2026-10-19T02:00:00.000Z', ...extra,
});

// reply(body, number of the call): what the fake /ticket-update answers. gate: a promise the first answer waits for.
function world({ reply, gate } = {}) {
  const calls = { fetches: [], renders: 0, statuses: [], problems: 0, absorbed: [], loads: 0 };
  const context = vm.createContext({
    Number, String, JSON, Object, Array, Promise, Map, Error,
    TICKET_FIELD_SPECS: SPECS, ticketFields: FIELDS,
    ticketFieldFor: (spec) => FIELDS.find((field) => spec.keys.includes(field.key)),
    state: { chat1: { escalation: {}, ticketRecord: TICKET(), ticketView: 'detail' } },
    ticketAuthor: () => ({ accountKey: 'lc1', agentToken: 't' }),
    renderTicketSlot: () => { calls.renders += 1; },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.fetches.push({ url, body });
      if (gate && calls.fetches.length === 1) await gate;
      return { json: async () => (reply ? reply(body, calls.fetches.length) : { ok: true, ref: body.ref, changed: [], visible: true, ticket: { ...TICKET(), comments: [] } }) };
    },
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
const build = (w, change, ticket = 'state.chat1.ticketRecord') => plain(w.run(`buildTicketChange(${ticket}, ${JSON.stringify(change)})`));
const edit = (w) => plain(w.run('ticketEditByChat.get("chat1")'));
const savedTicket = (status) => ({ ...TICKET(), fields: { ...TICKET().fields, status }, comments: [], updatedAt: '2026-10-19T03:00:00.000Z' });

test('a field edit sends only that field, with the value the agent saw as expect', () => {
  const w = world();
  assert.deepEqual(build(w, { type: 'field', stateKey: 'status', value: 'IN_PROGRESS' }), { payload: { fields: { status: 'IN_PROGRESS' }, expect: { status: 'OPEN' } } });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'remarks', value: '  Moved to payments ' }).payload.fields, { remarks: 'Moved to payments' });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'amount', value: '60.5' }).payload, { fields: { amount: 60.5 }, expect: { amount: 58 } });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'transactionId', value: 'ABC' }).payload.expect, { transaction_id: null }, 'a field that was empty is expected empty');
});

test('an edit that leaves the value as it is sends nothing; a cleared field is cleared; a bad number is refused before sending', () => {
  const w = world();
  assert.deepEqual(build(w, { type: 'field', stateKey: 'status', value: 'OPEN' }), { unchanged: true });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'remarks', value: ' first ' }), { unchanged: true });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'amount', value: '58' }), { unchanged: true });
  assert.deepEqual(build(w, { type: 'field', stateKey: 'remarks', value: '' }).payload.fields, { remarks: null });
  assert.match(build(w, { type: 'field', stateKey: 'amount', value: '1,500' }).error, /Amount must be a number/);
  assert.match(build(w, { type: 'field', stateKey: 'nope', value: 'x' }).error, /not on the ticket form/);
});

test('department, market and assignees: each is its own edit, with what it was', () => {
  const w = world();
  assert.deepEqual(build(w, { type: 'department', value: 'CS' }).payload, { toDepartment: 'CS', expect: { Department: 'PYM' } });
  assert.deepEqual(build(w, { type: 'department', value: 'PYM' }), { unchanged: true });
  assert.deepEqual(build(w, { type: 'market', value: '' }).payload, { market: null, expect: { Market: 'MYR' } });
  assert.deepEqual(build(w, { type: 'market', value: 'IDR' }).payload, { market: 'IDR', expect: { Market: 'MYR' } });
  assert.deepEqual(build(w, { type: 'assigneeAdd', value: ' cara@x.com, Dan ;' }).payload, { assignees: { add: ['cara@x.com', 'Dan'], remove: [] } });
  assert.deepEqual(build(w, { type: 'assigneeAdd', value: '  ' }), { unchanged: true });
  assert.deepEqual(build(w, { type: 'assigneeRemove', value: '31' }).payload, { assignees: { add: [], remove: [31] } });
  assert.deepEqual(build(w, { type: 'assigneeRemove', value: '99' }), { unchanged: true }, 'not on the ticket');
});

test('what changed is told in words, list changes by name', () => {
  const w = world();
  const say = (changed) => w.run(`describeTicketChanges(${JSON.stringify(changed)})`);
  assert.equal(say([{ key: 'status', label: 'Status', fromText: 'Open', toText: 'PYM PROCESSING' }, { key: 'assignee', label: 'Assignee', added: [{ id: 1, name: 'Ann Lee' }], removed: [{ id: 2, name: 'Bob Tan' }] }]),
    'Status: Open → PYM PROCESSING · Assignee: + Ann Lee − Bob Tan');
  assert.match(say([]), /Nothing needed to change/);
});

test('a box on the page maps to the right edit', () => {
  const w = world();
  const change = (name, value) => plain(w.run(`ticketChangeFor(${JSON.stringify(name)}, ${JSON.stringify(value)})`));
  assert.deepEqual(change('departmentCode', 'CS'), { type: 'department', value: 'CS' });
  assert.deepEqual(change('marketCode', ''), { type: 'market', value: '' });
  assert.deepEqual(change('addPeople', 'a@x.com'), { type: 'assigneeAdd', value: 'a@x.com' });
  assert.deepEqual(change('status', 'SOLVED'), { type: 'field', stateKey: 'status', value: 'SOLVED' });
});

test('saving: one request for that edit; the ticket is replaced but keeps its conversation; the inbox list is dropped; typing is cleared', async () => {
  const w = world({ reply: () => ({ ok: true, ref: 'TK2610190001', changed: [{ key: 'status', label: 'Status', fromText: 'Open', toText: 'PYM PROCESSING' }], visible: true, ticket: savedTicket('IN_PROGRESS') }) });
  w.run('ticketLiveTyping("chat1", "status", "IN_PROGRESS")');
  await w.run('commitTicketChange("chat1", ticketChangeFor("status", "IN_PROGRESS"))');
  assert.equal(w.calls.fetches.length, 1);
  const sent = w.calls.fetches[0];
  assert.equal(sent.url, '/ticket-update');
  assert.deepEqual([sent.body.ref, sent.body.fields, sent.body.expect], ['TK2610190001', { status: 'IN_PROGRESS' }, { status: 'OPEN' }]);
  assert.equal(sent.body.author.accountKey, 'lc1');
  assert.equal(w.run('state.chat1.ticketRecord.fields.status'), 'IN_PROGRESS');
  assert.equal(w.run('state.chat1.ticketRecord.comments.length'), 1, 'the conversation is kept');
  const now = edit(w);
  assert.deepEqual(now.typing, {});
  assert.equal(now.saving, 0);
  assert.equal(now.notice, 'Status: Open → PYM PROCESSING');
  assert.equal(w.run('ticketSearchResultsByChat.has("chat1")'), false);
  assert.deepEqual(w.calls.absorbed, ['TK2610190001']);
});

test('an edit that changes nothing sends nothing', async () => {
  const w = world();
  await w.run('commitTicketChange("chat1", ticketChangeFor("status", "OPEN"))');
  assert.equal(w.calls.fetches.length, 0);
});

test('edits made quickly are saved one after another, each against the ticket the one before left', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = world({ gate, reply: (body, n) => ({ ok: true, ref: 'TK2610190001', changed: [], visible: true, ticket: n === 1 ? savedTicket('IN_PROGRESS') : { ...savedTicket('IN_PROGRESS'), fields: { ...savedTicket('IN_PROGRESS').fields, remarks: 'done' } } }) });
  const first = w.run('commitTicketChange("chat1", ticketChangeFor("status", "IN_PROGRESS"))');
  const second = w.run('commitTicketChange("chat1", ticketChangeFor("remarks", "done"))');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.calls.fetches.length, 1, 'the second edit waits for the first');
  release();
  await Promise.all([first, second]);
  assert.equal(w.calls.fetches.length, 2);
  assert.deepEqual(w.calls.fetches[1].body.expect, { remarks: 'first' });
  assert.equal(w.run('state.chat1.ticketRecord.fields.remarks'), 'done');
  assert.equal(w.run('state.chat1.ticketRecord.fields.status'), 'IN_PROGRESS');
});

test('a refusal shows its message and the box goes back to the real value', async () => {
  const w = world({ reply: () => ({ ok: false, code: 'field_forbidden', error: 'Your role may view "Status" but not change it.' }) });
  w.run('ticketLiveTyping("chat1", "status", "SOLVED")');
  await w.run('commitTicketChange("chat1", ticketChangeFor("status", "SOLVED"))');
  const now = edit(w);
  assert.equal(now.error, 'Your role may view "Status" but not change it.');
  assert.deepEqual(now.typing, {}, 'the typed value is dropped, so the field shows what the ticket holds');
  assert.equal(now.saving, 0);
  assert.equal(w.run('state.chat1.ticketRecord.fields.status'), 'OPEN');
});

test('someone else changed it first (412): the edit is not saved, the ticket is reloaded and the agent is told what it is now', async () => {
  const w = world({ reply: () => ({ ok: false, code: 'precondition_failed', error: 'x', mismatched: [{ name: 'Status', key: 'status', expected: 'OPEN', actual: 'SOLVED' }] }) });
  await w.run('commitTicketChange("chat1", ticketChangeFor("status", "IN_PROGRESS"))');
  assert.match(edit(w).error, /Someone changed this ticket.*Status is now SOLVED.*not saved/s);
  assert.equal(w.calls.loads, 1);
});

test('a ticket account that is not found asks for the email and tries the same edit again afterwards', async () => {
  const w = world({ reply: () => ({ ok: false, needTicketEmail: true, error: 'Ticket account not found.' }) });
  await w.run('commitTicketChange("chat1", ticketChangeFor("status", "IN_PROGRESS"))');
  assert.equal(w.calls.problems, 1);
});

test('a change that takes the ticket out of the agent\'s reach is saved and the inbox is shown instead', async () => {
  const w = world({ reply: () => ({ ok: true, ref: 'TK2610190001', changed: [{ key: 'department', label: 'Department', fromText: 'PYM', toText: 'CS' }], visible: false }) });
  await w.run('commitTicketChange("chat1", ticketChangeFor("departmentCode", "CS"))');
  assert.equal(w.run('state.chat1.ticketRecord'), null);
  assert.equal(w.run('state.chat1.ticketView'), 'list');
  assert.match(w.calls.statuses.at(-1).text, /Saved\. Department: PYM → CS.*no longer see TK2610190001/);
});

test('the detail is always editable and saves as you go: no Edit, Save or Cancel buttons, and every kind of box is wired', () => {
  for (const gone of ['data-action="editTicket"', 'data-action="saveTicketEdit"', 'data-action="cancelTicketEdit"', 'toggleEditAssignee']) assert.ok(!app.includes(gone), `${gone} is gone`);
  assert.ok(app.includes('${renderTicketEditForm(chatId, ticket)}'), 'the form is part of every ticket detail');
  assert.ok(app.includes('data-action="removeTicketAssignee"') && app.includes('btn.dataset.action === "removeTicketAssignee"'), 'removing a person saves at once');
  assert.ok(app.includes('commitTicketChange(chatId, ticketChangeFor(name, value))'), 'a picked option saves at once');
  assert.ok(app.includes('liveInput.dataset.field?.startsWith("edit:")'), 'a typed box saves when it is left');
  assert.ok(app.includes('escInput.dataset.field.startsWith("edit:")) ticketLiveTyping'), 'typing is kept until then');
  assert.ok(app.includes('url.pathname === "/ticket-update"'), 'the demo mode sends nothing to the ticket system');
});

test('a refresh that returns an older copy of the ticket does not undo an edit just saved', () => {
  assert.ok(app.includes('Date.parse(data.ticket.updatedAt) < Date.parse(s.ticketRecord.updatedAt)) return s.ticketRecord;'));
});
