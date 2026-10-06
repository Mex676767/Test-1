import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, searchRecords, searchAllRecords } from "./_lib/lark.js";
import { CA, CA_SUMMARY_FIELDS, summarizeRow } from "./_lib/ca-row.js";
import { handler as lastUsername } from "./lark-last-username.js";
import { handler as chatRecords } from "./lark-chat-records.js";
import { handler as staleRecords } from "./lark-stale-records.js";

const ENV = {
  LARK_APP_ID: "cost-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
  LARK_TABLE_PNL: "pnl-table", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isToken = (url) => String(url).includes("tenant_access_token");
async function withLark(onSearch, run) {
  const searches = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const body = options.body ? JSON.parse(options.body) : {};
    const u = new URL(String(url));
    const call = { table: u.pathname.match(/tables\/([^/]+)\//)?.[1], pageSize: u.searchParams.get("page_size"), pageToken: u.searchParams.get("page_token"), body };
    searches.push(call);
    return onSearch(call, searches.length);
  };
  try { await run(searches); } finally { globalThis.fetch = original; }
}

// ---- item 1: first-match-only callers --------------------------------------------------
test("maxRows reads ONE small page: no paging, no 'too many rows' refusal, and only that many rows come back", async () => {
  initEnv({ ...ENV });
  await withLark(() => json({ code: 0, data: { items: [{ record_id: "a", fields: {} }, { record_id: "b", fields: {} }], has_more: true, page_token: "next" } }), async (searches) => {
    const rows = await searchRecords("any-table", [{ field_name: "Username", operator: "is", value: ["p"] }], undefined, { maxRows: 1 });
    assert.deepEqual(rows.map((r) => r.record_id), ["a"]);
    assert.equal(searches.length, 1, "did not follow has_more");
    assert.equal(searches[0].pageSize, "1");
  });
});

test("last-username check asks each P&L search for one row and only the columns it uses", async () => {
  initEnv({ ...ENV });
  await withLark((call) => json({ code: 0, data: { items: call.body.filter.conditions.some((c) => c.field_name === "Live Chat link")
    ? [{ record_id: "r1", fields: { Username: "player-one" } }, { record_id: "r2", fields: { Username: "player-two" } }] : [], has_more: true, page_token: "more" } }), async (searches) => {
    const result = await lastUsername({ body: JSON.stringify({ chatId: "CHAT1", brand: "PP" }) });
    const body = JSON.parse(result.body);
    assert.equal(body.found, true);
    assert.equal(body.username, "player-one", "first match, as before");
    assert.equal(searches.length, 2, "two searches, no paging follow-ups");
    for (const call of searches) {
      assert.equal(call.pageSize, "1");
      assert.ok(call.body.field_names.includes("Username"));
    }
    const live = searches.find((c) => c.body.filter.conditions.some((x) => x.field_name === "Live Chat link"));
    const telegram = searches.find((c) => c.body.filter.conditions.some((x) => x.field_name === "Telegram"));
    assert.ok(!live.body.field_names.includes("Telegram"), "a renamed Telegram column cannot break the Live Chat link search");
    assert.ok(telegram.body.field_names.includes("Telegram"));
  });
});

// ---- item 2: Customer Approaching projections --------------------------------------------
test("CA_SUMMARY_FIELDS covers every column summarizeRow reads", () => {
  const touched = new Set();
  const spy = new Proxy({}, { get: (_t, key) => { touched.add(String(key)); return undefined; } });
  summarizeRow({ record_id: "r", fields: spy });
  assert.ok(touched.size >= 10, "summarizeRow reads its columns through the fields object");
  const missing = [...touched].filter((name) => !CA_SUMMARY_FIELDS.includes(name));
  assert.deepEqual(missing, [], "no column summarizeRow reads is left out of the projection");
});

test("chat-records and stale-records project to the summary columns (plus automatic fields)", async () => {
  initEnv({ ...ENV });
  await withLark(() => json({ code: 0, data: { items: [], has_more: false } }), async (searches) => {
    await chatRecords({ body: JSON.stringify({ agentName: "Agent A", threadId: "TM25Q40O8Q" }) });
    await staleRecords({ body: JSON.stringify({ agentName: "Agent A" }) });
    const caSearches = searches.filter((c) => c.table === "customer-table");
    assert.ok(caSearches.length >= 2);
    for (const call of caSearches) {
      assert.deepEqual([...call.body.field_names].sort(), [...CA_SUMMARY_FIELDS].sort());
      assert.equal(call.body.automatic_fields, true);
    }
  });
});

test("a projected column that no longer exists retries ONCE without the projection instead of failing", async () => {
  initEnv({ ...ENV });
  await withLark((call, n) => n === 1
    ? json({ code: 1254045, msg: "FieldNameNotFound: field Player D.O.B not found" })
    : json({ code: 0, data: { items: [{ record_id: "ok", fields: {} }], has_more: false } }), async (searches) => {
    const rows = await searchRecords("proj-table", [{ field_name: "Username", operator: "is", value: ["p"] }], undefined, { fieldNames: ["Username", "Player D.O.B"] });
    assert.equal(rows[0].record_id, "ok");
    assert.equal(searches.length, 2);
    assert.ok(searches[0].body.field_names);
    assert.equal(searches[1].body.field_names, undefined, "second attempt has no projection");
  });
});

test("the projection fallback never retries a rate limit or an unrelated error", async () => {
  initEnv({ ...ENV });
  await withLark(() => json({ code: 1254290, msg: "TooManyRequest" }, 429), async (searches) => {
    await assert.rejects(searchRecords("proj-table-2", [{ field_name: "Username", operator: "is", value: ["p"] }], undefined, { fieldNames: ["Username"], timeoutMs: 4_000 }));
    assert.equal(searches.length, 1);
  });
});

test("scanning a whole table also accepts a projection, with the same fallback", async () => {
  initEnv({ ...ENV });
  await withLark((call, n) => n === 1
    ? json({ code: 1254045, msg: "field not found" })
    : json({ code: 0, data: { items: [{ record_id: "z", fields: {} }], has_more: false } }), async (searches) => {
    const rows = await searchAllRecords("scan-table", [{ field_name: "Agent Name", operator: "is", value: ["A"] }], { fieldNames: CA_SUMMARY_FIELDS });
    assert.equal(rows.length, 1);
    assert.ok(searches[0].body.field_names);
    assert.equal(searches[1].body.field_names, undefined);
  });
});
