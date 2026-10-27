import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];

const NAMES = ['applyDefaultMarketToNewTicket', 'ticketAccountForClaim', 'autoTicketEnabled', 'ticketChoiceSlug', 'randomTransactionId', 'autoTicketQueryOption', 'buildClaimTicketFields', 'loadDefaultMarket', 'saveDefaultMarket', 'raiseClaimTicket'];
const SOURCE = [
  line(/const AUTO_TICKET_DEPARTMENT = "[^"]+";/), line(/const AUTO_TICKET_LEVEL = "[^"]+";/),
  line(/const AUTO_TICKET_PROGRAMS = \{[\s\S]*?\n\};/), line(/const DEFAULT_MARKET_LOCAL_KEY = "[^"]+";/), line(/const CLAIM_TICKET_USABLE_ACCOUNT = \[[^\]]+\];/),
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

function world({ preview = true, live = false, author, fields = FIELDS, ticketReply, marketReply, modal, account = { status: 'found', at: Date.now(), checking: false }, checkResult } = {}) {
  const calls = { fetches: [], statuses: [], modals: 0, saves: 0 };
  const store = new Map();
  const context = vm.createContext({
    Number, String, Math, JSON, Object, Promise, Set, Map, Array, Error, FormData, File, Uint8Array,
    crypto: webcrypto, setTimeout,
    ticketAccount: { ...account },
    checkTicketAccount: async (chatId, options) => { calls.checks = [...(calls.checks || []), options]; if (checkResult) context.ticketAccount = { ...checkResult, at: Date.now(), checking: false }; },
    previewMode: preview, ESCALATION_TICKET_ENABLED: true, AUTO_TICKET_LIVE: live,
    TICKET_FIELD_SPECS: SPECS,
    ticketFields: fields,
    ticketDepartments: [{ id: 3, code: 'PYM_MYR', name: 'PAYMENT MYR/PHP/PKR' }, { id: 4, code: 'CS', name: 'Customer Service' }],
    ticketMarkets: [{ id: 1, code: 'MYR', label: 'Malaysia' }, { id: 2, code: 'IDR', label: 'Indonesia' }],
    renderTicketSlot: () => { calls.renders = (calls.renders || 0) + 1; },
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

test('the ticket carries exactly what was asked for, with status Open, and leaves gateway, remarks and manual deposit empty', () => {
  const w = world();
  const out = plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR")'));
  assert.equal(out.error, undefined);
  const { fields } = out;
  assert.match(fields.transaction_id, /^[A-Z0-9]{32}$/);
  delete fields.transaction_id;
  assert.deepEqual(fields, { member_id: 'zzplayer', member_platform: 'VS96', query_type: 'vvip_top_p_l_bonus', status: 'OPEN', amount: 58, member_level: 'VVIP', toDepartment: 'PYM_MYR', market: 'MYR' });
  assert.equal(out.departmentName, 'PAYMENT MYR/PHP/PKR');
});

test('a Halloween claim ticket carries the remark "3X Turnover Team"; other bonuses still leave Remarks empty', () => {
  const withComplain = FIELDS.map((field) => (field.key === 'query_type' ? { ...field, options: [...field.options, { value: 'vvip_complain_players', label: 'VVIP Complain Players' }] } : field));
  const w = world({ fields: withComplain });
  const out = plain(w.run('buildClaimTicketFields(state.chat1, "halloween", "120", "MYR")'));
  assert.equal(out.error, undefined);
  assert.equal(out.fields.remarks, '3X Turnover Team');
  assert.equal(out.fields.query_type, 'vvip_complain_players');
  assert.equal(out.fields.amount, 120);
  assert.equal(plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR")')).fields.remarks, undefined);
  const noRemarks = world({ fields: withComplain.filter((field) => field.key !== 'remarks') });
  assert.match(plain(noRemarks.run('buildClaimTicketFields(state.chat1, "halloween", "120", "MYR")')).error, /no Remarks field.*3X Turnover Team/);
});

test('a Telegram RM28 claim raises a VVIP Complain Players ticket (amount falls back to 28); VS96 Feedback raises none', () => {
  const withComplain = FIELDS.map((field) => (field.key === 'query_type' ? { ...field, options: [...field.options, { value: 'vvip_complain_players', label: 'VVIP Complain Players' }] } : field));
  const w = world({ fields: withComplain });
  const telegram = plain(w.run('buildClaimTicketFields(state.chat1, "telegram28", "28", "MYR")'));
  assert.equal(telegram.error, undefined);
  assert.equal(telegram.fields.query_type, 'vvip_complain_players');
  assert.equal(telegram.fields.amount, 28);
  assert.equal(telegram.fields.remarks, undefined);
  assert.equal(plain(w.run('buildClaimTicketFields(state.chat1, "telegram28", "", "MYR")')).fields.amount, 28, 'amount missing in the table: RM28 by name');
  assert.equal(w.run('AUTO_TICKET_PROGRAMS.vs96Feedback'), undefined, 'VS96 Feedback is a redeem code: no ticket');
  assert.equal(plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "", "MYR")')).error?.includes('amount could not be read'), true, 'other bonuses still need an amount');
});

test('Halloween in admin preview opens the same proof popup, but submitting it creates no ticket; other bonuses still create one', async () => {
  const withComplain = FIELDS.map((field) => (field.key === 'query_type' ? { ...field, options: [...field.options, { value: 'vvip_complain_players', label: 'VVIP Complain Players' }] } : field));
  let seen;
  const halloween = world({ fields: withComplain, preview: true, modal: async (options) => { seen = options; return (await options.onSubmit({ files: [new File([new Uint8Array([1])], 'proof.png', { type: 'image/png' })], market: 'MYR', ticketEmail: '' })).ok; } });
  assert.equal(await halloween.run('raiseClaimTicket("chat1", "halloween", "120")'), true);
  assert.equal(halloween.calls.modals, 1, 'the popup opened');
  assert.match(seen.previewNote, /no ticket is created/);
  assert.deepEqual(plain(seen.rows.find((row) => row[0] === 'Remarks')), ['Remarks', '3X Turnover Team']);
  assert.equal(halloween.calls.fetches.filter((call) => call.url === '/ticket-create').length, 0, 'nothing was sent to the ticket system');
  assert.deepEqual(plain(halloween.run('state.chat1.claimTickets')), {}, 'no ticket ref is remembered');
  assert.equal(await halloween.run('raiseClaimTicket("chat1", "halloween", "120")'), true);
  assert.equal(halloween.calls.modals, 2, 'it can be opened again');

  const other = world({ fields: withComplain, preview: true, modal: async (options) => { seen = options; return (await options.onSubmit({ files: [new File([new Uint8Array([1])], 'proof.png', { type: 'image/png' })], market: 'MYR', ticketEmail: '' })).ok; } });
  assert.equal(await other.run('raiseClaimTicket("chat1", "ltvTest", "88")'), true);
  assert.match(seen.previewNote, /creates a real ticket/);
  assert.equal(other.calls.fetches.filter((call) => call.url === '/ticket-create').length, 1);

  const live = world({ fields: withComplain, preview: false, live: true });
  assert.equal(await live.run('raiseClaimTicket("chat1", "halloween", "120")'), true);
  assert.equal(live.calls.fetches.filter((call) => call.url === '/ticket-create').length, 1, 'a live Halloween claim still creates the ticket');
  assert.equal(plain(live.run('state.chat1.claimTickets')).halloween, 'TK2610190001');
});

test('status: the ticket system default is used, else its Open option, so a required Status never blocks the claim', () => {
  const status = (extra) => plain(world({ fields: FIELDS.map((field) => (field.key === 'status' ? { ...field, ...extra } : field)) }).run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR")')).fields.status;
  assert.equal(status({ options: [{ value: 'SOLVED', label: 'Solved' }, { value: 'open_ticket', label: 'Open' }] }), 'open_ticket');
  assert.equal(status({ defaultValue: 'NEW', options: [{ value: 'NEW', label: 'New' }, { value: 'OPEN', label: 'Open' }] }), 'NEW');
  assert.equal(status({}), 'OPEN');
  const pym = { defaultValue: 'NEW', options: [{ value: 'NEW', label: 'New' }, { value: 'IN_PROGRESS', label: 'PYM PROCESSING' }] };
  assert.equal(status(pym), 'IN_PROGRESS', 'PYM PROCESSING is the starting status whenever the ticket system has it');
  assert.equal(status({ options: [{ value: 'pym_processing', label: 'Pym  Processing' }] }), 'pym_processing', 'matched by name, not by exact spelling');
});

test('status: the agent can pick another status when the ticket system refuses the default, and it goes on the ticket', async () => {
  const fields = FIELDS.map((field) => (field.key === 'status' ? { ...field, options: [{ value: 'NEW', label: 'New' }, { value: 'PENDING', label: 'Pending' }] } : field));
  const w = world({ fields });
  const built = plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR")'));
  assert.equal(built.status, 'OPEN', 'the default is unchanged');
  assert.deepEqual(built.statusOptions.map((option) => option.value), ['OPEN', 'NEW', 'PENDING'], 'the refused default stays visible, the real choices are offered');
  assert.equal(plain(w.run('buildClaimTicketFields(state.chat1, "topPnl", "58", "MYR", "PENDING")')).fields.status, 'PENDING');

  const offered = [];
  const picked = world({ fields, modal: async (options) => { offered.push(options); return (await options.onSubmit({ files: [new File([new Uint8Array([1])], 'p.png', { type: 'image/png' })], market: 'MYR', status: 'NEW', ticketEmail: '' })).ok; } });
  assert.equal(await picked.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.deepEqual(plain(offered[0].statuses).map((option) => option.value), ['OPEN', 'NEW', 'PENDING']);
  assert.equal(offered[0].status, 'OPEN');
  assert.equal(picked.calls.fetches.find((call) => call.url === '/ticket-create').body.ticket.fields.status, 'NEW', 'the chosen status is what is sent');
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

test('default market: if it cannot be saved on the server (the column is missing, Lark is down) the claim is not blocked: the market is remembered in this browser, used for the ticket and offered next time', async () => {
  const w = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: (body) => (body.market ? { ok: false, error: 'The market could not be saved (is the "Default Market" column in the Agent Logins table?)' } : { ok: true, market: '' }) });
  assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.equal(w.store.get('rc-default-market'), 'MYR');
  assert.equal(plain(w.calls.fetches.find((call) => call.url === '/ticket-create').body.ticket.fields).market, 'MYR');
  w.run('state.chat1.claimTickets = {}');
  const offered = [];
  w.context.openClaimTicketModal = async (options) => { offered.push(options); return true; };
  await w.run('raiseClaimTicket("chat1", "ltvTest", "20")');
  assert.equal(offered[0].market, 'MYR', 'the remembered market is preselected');
  assert.equal(offered[0].marketLocked, false, 'but not locked: the server has none');
});

test('default market: an expired LiveChat login still stops the claim with its reason', async () => {
  const w = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: (body) => (body.market ? { ok: false, loginExpired: true, error: 'LiveChat login expired or invalid — connect LiveChat again.' } : { ok: true, market: '' }) });
  assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), false);
  assert.equal(w.calls.fetches.some((call) => call.url === '/ticket-create'), false, 'no ticket is raised');
});

test('the rollout: Tickets, notifications and the auto-ticket are switched on for the installed widget, and the release id was bumped so agents get the update notice', () => {
  assert.match(app, /const DEPARTMENT_TABS_LIVE = true;/);
  assert.match(app, /const AUTO_TICKET_LIVE = true;/);
  assert.ok(JSON.parse(readFileSync(new URL('../widget-release.json', import.meta.url), 'utf8')).release > '20261019-1', 'the release id was bumped at the rollout and has only gone up since');
});

test('claim: with no usable ticket account (not found, key refused, ticket system not answering) the claim goes ahead as before: no dialog, no ticket', async () => {
  for (const status of ['notFound', 'noEmail', 'adminEmailInvalid', 'keyNeedsGrant', 'outranks', 'keyRejected', 'error']) {
    const w = world({ account: { status, at: Date.now(), checking: false } });
    assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), true, status);
    assert.equal(w.calls.modals, 0, status + ': no dialog');
    assert.equal(w.calls.fetches.length, 0, status + ': nothing sent to the ticket system');
    assert.match(w.calls.statuses.at(-1).text, new RegExp('No ticket was raised for this Top P&L claim \\(ticket account: ' + status + '\\); the claim went ahead as normal'));
    assert.equal(plain(w.run('state.chat1.claimTickets')) && Object.keys(plain(w.run('state.chat1.claimTickets'))).length, 0, 'no ticket recorded');
  }
});

test('claim: with a found ticket account (or the ticket system acting as the key owner) the proof dialog opens as before', async () => {
  for (const status of ['found', 'off']) {
    const w = world({ account: { status, at: Date.now(), checking: false } });
    assert.equal(await w.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
    assert.equal(w.calls.modals, 1, status);
  }
});

test('claim: an account never checked is checked first (quietly), and the dialog follows only if it turns out usable', async () => {
  const usable = world({ account: { status: 'unknown', at: 0, checking: false }, checkResult: { status: 'found' } });
  await usable.run('raiseClaimTicket("chat1", "topPnl", "58")');
  assert.deepEqual(JSON.parse(JSON.stringify(usable.calls.checks)), [{ quiet: true }]);
  assert.equal(usable.calls.modals, 1);
  const missing = world({ account: { status: 'unknown', at: 0, checking: false }, checkResult: { status: 'notFound' } });
  assert.equal(await missing.run('raiseClaimTicket("chat1", "topPnl", "58")'), true);
  assert.equal(missing.calls.modals, 0);
  const noLogin = world({ account: { status: 'unknown', at: 0, checking: false } });
  await noLogin.run('raiseClaimTicket("chat1", "topPnl", "58")');
  assert.equal(noLogin.calls.modals, 1);
});

test('claim: a problem is checked again after a minute, so a fixed key or a new account is noticed without waiting five minutes', async () => {
  const stale = world({ account: { status: 'keyRejected', at: Date.now() - 90_000, checking: false }, checkResult: { status: 'found' } });
  await stale.run('raiseClaimTicket("chat1", "topPnl", "58")');
  assert.deepEqual(JSON.parse(JSON.stringify(stale.calls.checks)), [{ force: true, quiet: true }]);
  assert.equal(stale.calls.modals, 1, 'the key works again, so the dialog opens');
  const fresh = world({ account: { status: 'keyRejected', at: Date.now() - 5_000, checking: false } });
  await fresh.run('raiseClaimTicket("chat1", "topPnl", "58")');
  assert.equal((fresh.calls.checks || []).length, 0, 'a recent answer is trusted');
  assert.equal(fresh.calls.modals, 0);
});

test('the proof dialog is centred in the window on a dimmed backdrop, and is a card with a header, a summary, the proof area and two buttons side by side', () => {
  assert.ok(app.includes('overlay.className = "claim-ticket-backdrop";'));
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.claim-ticket-backdrop \{[^}]*position: fixed; inset: 0;[^}]*display: flex; align-items: center; justify-content: center;/);
  assert.match(css, /\.claim-ticket-actions \{ display: flex;/);
  for (const part of ['claim-ticket-head', 'claim-ticket-summary', 'claim-ticket-drop', 'claim-ticket-actions']) assert.ok(app.includes(part), part);
});

test('a new ticket starts on the agent\'s default market, as the Market box value (the ticket system\'s market id)', async () => {
  const w = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: true, market: 'IDR' }) });
  await w.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(w.run('state.chat1.escalation.marketId'), '2', 'IDR is market id 2');
  assert.equal(w.calls.renders, 1, 'the form is redrawn with it');
});

test('a new ticket does not override what the agent chose, and does nothing when there is no default market or no such market', async () => {
  const touched = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: true, market: 'IDR' }) });
  touched.run('state.chat1.escalation.marketId = ""; state.chat1.escalation.marketTouched = true');
  await touched.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(touched.run('state.chat1.escalation.marketId'), '', 'the agent picked "Use ticket default" on purpose');
  const none = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: true, market: '' }) });
  await none.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(none.run('state.chat1.escalation.marketId || ""'), '');
  const unknown = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: true, market: 'XXX' }) });
  await unknown.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(unknown.run('state.chat1.escalation.marketId || ""'), '');
  const failing = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: false, error: 'LiveChat login expired' }) });
  await failing.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(failing.run('state.chat1.escalation.marketId || ""'), '', 'a market that cannot be read leaves the form as it is');
});

test('a default market replaces the market the form started with (the site-wide default), and without a LiveChat login the one remembered in the browser is used', async () => {
  const replaces = world({ author: { accountKey: 'lc1', agentToken: 't' }, marketReply: () => ({ ok: true, market: 'IDR' }) });
  replaces.run('state.chat1.escalation.marketId = "1"');
  await replaces.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(replaces.run('state.chat1.escalation.marketId'), '2');
  const local = world({ author: undefined });
  local.store.set('rc-default-market', 'MYR');
  await local.run('applyDefaultMarketToNewTicket("chat1")');
  assert.equal(local.run('state.chat1.escalation.marketId'), '1');
});

test('the New ticket button applies the default market, and picking a market (or "Use ticket default") by hand is remembered so it is not put back', () => {
  assert.match(app, /s\.ticketAttachmentError = "";\s+renderTicketSlot\(chatId\);\s+void applyDefaultMarketToNewTicket\(chatId\);/);
  assert.ok(app.includes('if (btn.dataset.field === "marketId") s.escalation.marketTouched = true;'));
});
