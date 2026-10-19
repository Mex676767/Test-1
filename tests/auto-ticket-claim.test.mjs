import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];

const NAMES = ['autoTicketEnabled', 'ticketChoiceSlug', 'randomTransactionId', 'autoTicketQueryOption', 'buildClaimTicketFields', 'loadDefaultMarket', 'saveDefaultMarket', 'raiseClaimTicket'];
const SOURCE = [
  line(/const AUTO_TICKET_DEPARTMENT = "[^"]+";/), line(/const AUTO_TICKET_LEVEL = "[^"]+";/),
  line(/const AUTO_TICKET_PROGRAMS = \{[\s\S]*?\n\};/), line(/const DEFAULT_MARKET_LOCAL_KEY = "[^"]+";/),
  'let agentDefaultMarket = { account: "", code: "" }; const claimTicketBusy = new Set();',
  ...NAMES.map(fn),
].join('\n');

const FIELDS = [
  { key: 'member_id', label: 'Member / User ID', type: 'TEXT' },
  { key: 'member_platform', label: 'Brand', type: 'SELECT' },
  { key: 'query_type', label: 'Query type', type: 'SELECT', options: [
    { value: 'wd_delay', label: 'WD DELAY' },
    { value: 'others', label: 'OTHERS' },
    { value: 'vvip_ltv_70_bonus', label: 'VVIP LTV 70 BONUS' },
    { value: 'vvip_top_p_l_bonus', label: 'VVIP TOP P&L BONUS' },
    { value: 'vvip_grace_period_bonus', label: 'VVIP Grace Period BONUS' },
    { value: 'vvip_risk_player_bonus', label: 'VVIP Risk Player BONUS' },
  ] },
  { key: 'status', label: 'Status', type: 'SELECT' },
  { key: 'transaction_id', label: 'Transaction ID', type: 'TEXT' },
  { key: 'payment_gateway', label: 'Payment Gateway', type: 'SELECT' },
  { key: 'amount', label: 'Amount', type: 'CURRENCY' },
  { key: 'remarks', label: 'Remarks', type: 'LONGTEXT' },
  { key: 'member_level', label: 'Level', type: 'SELECT', options: [{ value: '0_3', label: '0-3' }, { value: 'VVIP', label: 'VVIP' }] },
  { key: 'attachment', label: 'Attachment', type: 'ATTACHMENT' },
];
const SPECS = [
  { stateKey: 'memberUserId', keys: ['member_id'], labels: ['Member / User ID'] },
  { stateKey: 'brand', keys: ['member_platform', 'brand'], labels: ['Brand'] },
  { stateKey: 'queries', keys: ['query_type'], labels: ['Query type'] },
  { stateKey: 'status', keys: ['status'], labels: ['Status'] },
  { stateKey: 'transactionId', keys: ['transaction_id'], labels: ['Transaction ID'] },
  { stateKey: 'paymentGateway', keys: ['payment_gateway'], labels: ['Payment Gateway'] },
  { stateKey: 'amount', keys: ['amount'], labels: ['Amount'] },
  { stateKey: 'remarks', keys: ['remarks'], labels: ['Remarks'] },
  { stateKey: 'vipLevel', keys: ['member_level', 'level'], labels: ['Level'] },
];

function world({ preview = true, live = false, author, fields = FIELDS, ticketReply, marketReply, modal } = {}) {
  const calls = { fetches: [], statuses: [], modals: 0, saves: 0 };
  const store = new Map();
  const context = vm.createContext({
    Number, String, Math, JSON, Object, Promise, Set, Map, Array, Error, FormData, File, Uint8Array,
    crypto: webcrypto,
    previewMode: preview, ESCALATION_TICKET_ENABLED: true, AUTO_TICKET_LIVE: live,
    TICKET_FIELD_SPECS: SPECS,
    ticketFields: fields,
    ticketDepartments: [{ id: 3, code: 'PYM_MYR', name: 'PAYMENT MYR/PHP/PKR' }, { id: 4, code: 'CS', name: 'Customer Service' }],
    ticketMarkets: [{ id: 1, code: 'MYR', label: 'Malaysia' }, { id: 2, code: 'IDR', label: 'Indonesia' }],
    ticketConfigError: '',
    ticketFieldFor: (spec) => fields.find((field) => spec.keys.includes(field.key)),
    ticketFieldOptions: (field) => field?.options || [],
    ticketAuthor: () => author,
    ticketAttachmentField: () => fields.find((field) => field.type === 'ATTACHMENT'),
    ticketCreateInFlight: new Set(), ticketSearchResultsByChat: new Map(),
    fetchTicketConfig: async () => {},
    noteTicketAccountUsed: () => {}, storeTicketEmail: () => {}, saveState: () => {},
    currentLiveChatAccount: 'lc1',
    escapeHtml: (value) => String(value),
    setStatus: (text, kind) => calls.statuses.push({ text, kind }),
    state: { chat1: { username: 'zzplayer', escalation: { brand: 'VS96' }, claimTickets: {} } },
    localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) },
    openClaimTicketModal: async (options) => {
      calls.modals += 1;
      return modal ? modal(options) : (await options.onSubmit({ files: [new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })], market: 'MYR', ticketEmail: '' })).ok;
    },
    fetch: async (url, options = {}) => {
      const body = options.body instanceof FormData ? { ticket: JSON.parse(options.body.get('ticket')), files: options.body.getAll('attachment').map((file) => file.name) } : JSON.parse(options.body || '{}');
      calls.fetches.push({ url, body });
      if (url === '/agent-market') {
        if (body.market) calls.saves += 1;
        return { json: async () => (marketReply ? marketReply(body) : { ok: true, market: body.market || '' }) };
      }
      return { json: async () => (ticketReply ? ticketReply(body) : { ok: true, ref: 'TK2610190001' }) };
    },
  });
  vm.runInContext(SOURCE, context);
  return { calls, store, context, run: (code) => vm.runInContext(code, context) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('transaction id: 32 capital letters and digits, different every time', () => {
  const w = world();
  const ids = new Set();
  for (let i = 0; i < 300; i += 1) {
    const id = w.run('randomTransactionId()');
    assert.match(id, /^[A-Z0-9]{32}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 300);
});

test('query type: the bonus keyword is found inside the ticket system query type, whatever the case or punctuation', () => {
  const w = world();
  const options = plain(FIELDS[2].options);
  const pick = (keyword) => plain(w.run(`autoTicketQueryOption(${JSON.stringify(options)}, ${JSON.stringify(keyword)})`))?.label;
  assert.equal(pick('TOP P&L'), 'VVIP TOP P&L BONUS');
  assert.equal(pick('LTV'), 'VVIP LTV 70 BONUS');
  assert.equal(pick('Grace Period'), 'VVIP Grace Period BONUS');
  assert.equal(pick('Risk Player'), 'VVIP Risk Player BONUS');
  assert.equal(pick('Birthday'), undefined, 'no query type contains it: nothing is guessed');
});

test('query type: with several matches the VVIP bonus one is used', () => {
  const w = world();
  const options = [{ value: 'ltv_other', label: 'LTV OTHER' }, { value: 'vvip_ltv_70_bonus', label: 'VVIP LTV 70 BONUS' }];
  assert.equal(plain(w.run(`autoTicketQueryOption(${JSON.stringify(options)}, "LTV")`)).label, 'VVIP LTV 70 BONUS');
});

test('the ticket carries exactly what was asked for, and leaves status, gateway, remarks and manual deposit empty', () => {
  const w = world();
  const out = plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR")'));
  assert.equal(out.error, undefined);
  const { fields } = out;
  assert.match(fields.transaction_id, /^[A-Z0-9]{32}$/);
  delete fields.transaction_id;
  assert.deepEqual(fields, { member_id: 'zzplayer', member_platform: 'VS96', query_type: 'vvip_top_p_l_bonus', amount: 58, member_level: 'VVIP', toDepartment: 'PYM_MYR', market: 'MYR' });
  assert.equal(out.departmentName, 'PAYMENT MYR/PHP/PKR');
});

test('the ticket cannot be built without a player, a brand, a readable amount, a market or a matching query type', () => {
  const w = world();
  const error = (code) => plain(w.run(code)).error;
  assert.match(error('buildClaimTicketFields({ username: "", escalation: { brand: "VS96" } }, "topPnl", "5", "MYR")'), /username/i);
  assert.match(error('buildClaimTicketFields({ username: "p", escalation: { brand: "" } }, "topPnl", "5", "MYR")'), /brand/i);
  assert.match(error('buildClaimTicketFields(state.chat1, "topPnl", "", "MYR")'), /amount/i);
  assert.match(error('buildClaimTicketFields(state.chat1, "topPnl", "0", "MYR")'), /amount/i);
  assert.match(error('buildClaimTicketFields(state.chat1, "topPnl", "5", "")'), /market/i);
  const noMatch = world({ fields: FIELDS.map((field) => (field.key === 'query_type' ? { ...field, options: [{ value: 'wd_delay', label: 'WD DELAY' }] } : field)) });
  assert.match(plain(noMatch.run('buildClaimTicketFields(state.chat1, "topPnl", "5", "MYR")')).error, /TOP P&L/);
});

test('claim: asks for the proof, raises the ticket, remembers its ref and lets the claim go ahead', async () => {
  const w = world();
  assert.equal(await w.run('raiseClaimTicket("chat1", "ltvTest", "88")'), true);
  assert.equal(w.calls.modals, 1);
  const post = w.calls.fetches.find((call) => call.url === '/ticket-create');
  assert.equal(post.body.ticket.fields.query_type, 'vvip_ltv_70_bonus');
  assert.equal(post.body.ticket.fields.amount, 88);
  assert.equal(post.body.ticket.fields.toDepartment, 'PYM_MYR');
  assert.equal(post.body.ticket.fields.market, 'MYR');
  assert.deepEqual(post.body.files, ['proof.png']);
  assert.equal(w.run('state.chat1.claimTickets.ltvTest'), 'TK2610190001');
});

test('claim: a second claim of the same bonus in the same case does not raise a second ticket', async () => {
  const w = world();
  await w.run('raiseClaimTicket("chat1", "riskPlayer", "30")');
  assert.equal(await w.run('raiseClaimTicket("chat1", "riskPlayer", "30")'), true);
  assert.equal(w.calls.modals, 1);
  assert.equal(w.calls.fetches.filter((call) => call.url === '/ticket-create').length, 1);
});

test('claim: cancelling the dialog, or a refused ticket, stops the claim and records no ticket', async () => {
  const cancelled = world({ modal: async () => false });
  assert.equal(await cancelled.run('raiseClaimTicket("chat1", "topPnl", "58")'), false);
  assert.deepEqual(plain(cancelled.run('state.chat1.claimTickets')), {});

  const refused = world({ ticketReply: () => ({ ok: false, error: 'Ticket account not found.', needTicketEmail: true }), modal: async (options) => options.onSubmit({ files: [], market: 'MYR', ticketEmail: '' }).then((r) => { refused.seen = r; return r.ok; }) });
  assert.equal(await refused.run('raiseClaimTicket("chat1", "topPnl", "58")'), false);
  assert.equal(refused.seen.needTicketEmail, true);
  assert.deepEqual(plain(refused.run('state.chat1.claimTickets')), {});
});

test('claim: a problem found before asking (no matching query type, no amount) is shown and nothing is asked', async () => {
  const w = world();
  assert.equal(await w.run('raiseClaimTicket("chat1", "gracePeriod", "")'), false);
  assert.equal(w.calls.modals, 0);
  assert.match(w.calls.statuses.at(-1).text, /amount.*Nothing was claimed/s);
  assert.equal(w.calls.statuses.at(-1).kind, 'error');
});

test('bonuses without a ticket, and any build where the feature is off, claim exactly as before', async () => {
  const w = world();
  assert.equal(await w.run('raiseClaimTicket("chat1", "vipBooster", "10")'), true);
  const off = world({ preview: false, live: false });
  assert.equal(await off.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.equal(off.calls.modals, 0);
  assert.equal(off.calls.fetches.length, 0);
  const live = world({ preview: false, live: true });
  assert.equal(await live.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.equal(live.calls.modals, 1, 'AUTO_TICKET_LIVE turns it on in the installed widget');
});

test('default market: asked once and saved on the server for a signed-in agent; the saved one wins and is not asked again', async () => {
  const w = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: (body) => ({ ok: true, market: body.market ? 'IDR' : '' }), modal: async (options) => {
    assert.equal(options.marketLocked, false);
    const result = await options.onSubmit({ files: [new File([new Uint8Array([1])], 'p.png', { type: 'image/png' })], market: 'MYR', ticketEmail: '' });
    return result.ok;
  } });
  assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.equal(w.calls.saves, 1);
  assert.equal(plain(w.calls.fetches.find((call) => call.url === '/ticket-create').body.ticket.fields).market, 'IDR', 'the market the server kept is the one used');
  w.run('state.chat1.claimTickets = {}');
  const second = [];
  w.context.openClaimTicketModal = async (options) => { second.push(options); return true; };
  await w.run('raiseClaimTicket("chat1", "ltvTest", "20")');
  assert.equal(second[0].marketLocked, true);
  assert.equal(second[0].market, 'IDR');
  assert.equal(w.calls.fetches.filter((call) => call.url === '/agent-market').length, 2, 'one read + one save; the saved market is remembered, not re-read');
});

test('default market: if it cannot be read the claim is stopped with the reason', async () => {
  const w = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: false, error: 'LiveChat login expired or invalid — connect LiveChat again.' }) });
  assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), false);
  assert.equal(w.calls.modals, 0);
  assert.match(w.calls.statuses.at(-1).text, /LiveChat login expired.*Nothing was claimed/s);
});

test('admin preview without a LiveChat login keeps the market in this browser only', async () => {
  const w = world({ author: undefined });
  await w.run('raiseClaimTicket("chat1", "topPnl", "58")');
  assert.equal(w.store.get('rc-default-market'), 'MYR');
  assert.equal(w.calls.fetches.filter((call) => call.url === '/agent-market').length, 0);
});
