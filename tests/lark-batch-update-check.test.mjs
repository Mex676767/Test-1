import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatchUpdateCheck, scrub } from '../scripts/lark-batch-update-check.mjs';

const TOKEN = 't-SECRETTOKEN0123456789abcdef';
const BASE_ENV = { LARK_APP_ID: 'app', LARK_APP_SECRET: 'secret', LARK_BASE_APP_TOKEN: 'basetok', BATCH_TEST_TABLE_ID: 'tblTEST', LARK_TABLE_CUSTOMER_APPROACHING: 'tblPROD' };
const ARGS = ['--i-understand-this-writes-to-a-test-table'];

// A small fake Lark: token, columns, create, get, delete, and batch_update that is either atomic or not.
function fakeLark({ atomic = true, honourClientToken = true, columns = [{ field_name: 'Text', type: 1 }, { field_name: 'Number', type: 2 }] } = {}) {
  const rows = new Map(); let next = 0; const requests = []; const replies = new Map();
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'x-tt-logid': 'LOG123' } });
  const impl = async (url, init = {}) => {
    const text = String(url), method = init.method || 'GET';
    requests.push({ url: text, method, auth: (init.headers || {}).Authorization });
    if (text.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: TOKEN, expire: 7200 });
    if ((init.headers || {}).Authorization !== `Bearer ${TOKEN}`) return json({ code: 99991663, msg: 'Invalid access token for authorization' });
    const body = init.body ? JSON.parse(init.body) : {};
    const path = text.split('?')[0], clientToken = new URL(text).searchParams.get('client_token');
    if (clientToken && honourClientToken && replies.has(clientToken)) return replies.get(clientToken).clone(); // Lark's documented repeat-of-the-same-request behaviour
    const remember = (response) => { if (clientToken) replies.set(clientToken, response.clone()); return response; };
    if (method === 'GET' && path.endsWith('/records')) return json({ code: 0, data: { items: [...rows].map(([record_id, fields]) => ({ record_id, fields })), has_more: false } });
    if (method === 'POST' && path.endsWith('/records/batch_create')) { const made = body.records.map((r) => { const id = `rec${++next}`; rows.set(id, { ...r.fields }); return { record_id: id, fields: rows.get(id) }; }); return remember(json({ code: 0, data: { records: made } })); }
    if (text.endsWith('/fields?page_size=100')) return json({ code: 0, data: { items: columns } });
    if (method === 'POST' && path.endsWith('/records')) { const id = `rec${++next}`; rows.set(id, { ...body.fields }); return remember(json({ code: 0, data: { record: { record_id: id, fields: rows.get(id) } } })); }
    if (method === 'POST' && path.endsWith('/records/batch_update')) {
      const bad = body.records.filter((r) => !rows.has(r.record_id) || Object.values(r.fields).some((v) => typeof v === 'string' && /not a number/.test(v)));
      if (bad.length && atomic) return json({ code: 1254043, msg: 'RecordIdNotFound or invalid field' });
      const done = body.records.filter((r) => !bad.includes(r));
      for (const r of done) rows.set(r.record_id, { ...rows.get(r.record_id), ...r.fields });
      return json({ code: 0, data: { records: done.map((r) => ({ record_id: r.record_id, fields: rows.get(r.record_id) })) } });
    }
    const id = text.split('/').pop();
    if (method === 'GET') return rows.has(id) ? json({ code: 0, data: { record: { record_id: id, fields: rows.get(id) } } }) : json({ code: 1254043, msg: 'RecordIdNotFound' });
    if (method === 'DELETE') { rows.delete(id); return json({ code: 0, data: { deleted: true } }); }
    return json({ code: -1, msg: 'unexpected ' + method + ' ' + text });
  };
  return { impl, rows, requests };
}
const run = async (lark, { env = BASE_ENV, argv = ARGS } = {}) => { const lines = []; const result = await runBatchUpdateCheck({ env, argv, fetchImpl: lark.impl, out: (l) => lines.push(l) }); return { result, text: lines.join('\n'), lines }; };

test('refuses without the confirmation flag, without its settings, and for any table that is also an application table', async () => {
  const lark = fakeLark();
  let r = await run(lark, { argv: [] });
  assert.equal(r.result.reason, 'no-confirmation');
  assert.equal(lark.requests.length, 0, 'nothing was sent');
  r = await run(lark, { env: { ...BASE_ENV, LARK_APP_SECRET: '' } });
  assert.equal(r.result.reason, 'missing-env');
  r = await run(lark, { env: { ...BASE_ENV, BATCH_TEST_TABLE_ID: 'tblPROD' } });
  assert.equal(r.result.reason, 'production-table');
  assert.match(r.text, /LARK_TABLE_CUSTOMER_APPROACHING/);
  assert.equal(lark.requests.length, 0);
});

test('runs the four experiments against its own rows only, prints Lark\'s raw replies, reads every row back, and never prints the token', async () => {
  const lark = fakeLark({ atomic: true });
  const { result, text } = await run(lark);
  assert.equal(result.ok, true);
  for (const heading of ['(a) valid batch', '(b) one record_id that does not exist', '(c) one invalid field value', '(d) the same record_id twice']) assert.ok(text.includes(heading), heading);
  assert.match(text, /RAW reply: \{"code":0,"data":\{"records":\[/, 'the valid batch reply is printed verbatim');
  assert.match(text, /RAW reply: \{"code":1254043,"msg":"RecordIdNotFound or invalid field"\}/, 'an error reply is printed verbatim');
  assert.match(text, /x-tt-logid LOG123/);
  assert.match(text, /request body: \{"records":\[\{"record_id":"rec3".*\{"record_id":"recDOESNOTEXIST000"/);
  assert.ok((text.match(/read back [A-F] \(/g) || []).length === 6, 'every row was read back after each experiment');
  assert.match(text, /read back C \(rec3\).*init-C/, 'atomic case: the valid record in the failed batch is visibly unchanged');
  assert.doesNotMatch(text, /SECRETTOKEN/);
  assert.doesNotMatch(text, /Bearer\s+t-/);
  const urls = lark.requests.filter((q) => !q.url.includes('tenant_access_token')).map((q) => q.url);
  assert.ok(urls.length > 10 && urls.every((u) => u.includes('/tables/tblTEST/')), 'only the dedicated table was touched');
  assert.equal(lark.rows.size, 8, 'its own six rows plus the two client_token rows were left in the table (no --cleanup)');
  assert.match(text, /\(e1\) single create sent twice with the same client_token/);
  assert.match(text, /\(e2\) batch_create sent twice with the same client_token/);
  assert.equal((text.match(/1st reply: HTTP 200/g) || []).length, 2);
  assert.equal((text.match(/2nd reply: HTTP 200/g) || []).length, 2);
  assert.match(text, /same record id\(s\) in both replies: true/, 'a repeat of the same request is answered with the same record');
  assert.match(text, /rows carrying the marker after \(e1\).*: 1 /);
  assert.match(text, /rows carrying the marker after \(e2\).*: 2 /, 'e1 row + e2 row; the repeats added nothing');
  assert.match(text, /total rows left carrying the marker: 2/);
});

test('(e) shows the bad outcome too: a Lark that ignores client_token leaves a second row, and the output says so', async () => {
  const lark = fakeLark({ honourClientToken: false });
  const { text } = await run(lark);
  assert.match(text, /same record id\(s\) in both replies: false/);
  assert.match(text, /total rows left carrying the marker: 4/);
});

test('the non-atomic variant is visible in the read-back (the valid record WAS applied), and --cleanup deletes only the rows the script made', async () => {
  const lark = fakeLark({ atomic: false });
  const { text } = await run(lark, { argv: [...ARGS, '--cleanup'] });
  assert.match(text, /read back C \(rec3\).*b-1/, 'non-atomic: the valid record in the failed batch changed');
  assert.match(text, /deleted A \(rec1\): HTTP 200/);
  assert.equal(lark.rows.size, 0);
  assert.equal(lark.requests.filter((q) => q.method === 'DELETE').length, 8, 'six experiment rows + the two client_token rows, nothing else');
});

test('a table without the two columns is reported, nothing is written', async () => {
  const lark = fakeLark({ columns: [{ field_name: 'Name', type: 1 }] });
  const { result, text } = await run(lark);
  assert.equal(result.reason, 'columns');
  assert.match(text, /needs a text column named "Text" and a number column named "Number"/);
  assert.equal(lark.requests.filter((q) => q.method === 'POST' && q.url.endsWith('/records')).length, 0);
});

test('scrub removes anything shaped like a token or an Authorization value', () => {
  assert.equal(scrub('Authorization: Bearer abc.DEF-123 / t-12345678901234567890abcd / u-12345678901234567890abcd'), 'Authorization: Bearer [token] / [token] / [token]');
  assert.equal(scrub(undefined), '');
});
