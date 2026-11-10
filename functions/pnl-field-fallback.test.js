import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, searchRecords, searchAllRecords } from "./_lib/lark.js";
import { handler } from "./lark-search.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const conditions = [
  { field_name: "Username", operator: "is", value: ["test-player"] },
  { field_name: "Brand", operator: "is", value: ["PP"] },
];

async function withLark(reply, run) {
  initEnv({
    LARK_APP_ID: "pnl-fallback-app", LARK_APP_SECRET: "fake-secret", LARK_BASE_APP_TOKEN: "fake-base",
    LARK_TABLE_PNL: "pnl-fallback-table", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table",
    LARK_TABLE_REDEEM_CODE: "redeem-table",
  });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "fake-token", expire: 3600 });
    if (path.endsWith("/fields")) return json({ code: 0, data: { items: [] } });
    assert.ok(path.endsWith("/records/search"), "tests must only read mocked records");
    if (path.includes("/pnl-fallback-table/")) {
      const body = JSON.parse(options.body);
      calls.push(body);
      return reply(body, calls.length);
    }
    return json({ code: 0, data: { items: [], has_more: false } });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test("P&L lookup recovers from a compact FieldNameNotFound projection error", async () => {
  await withLark((body) => body.field_names
    ? json({ code: 1254043, msg: "FieldNameNotFound" })
    : json({ code: 0, data: { items: [{ record_id: "pnl-row", fields: { Tier: "Tier V" } }], has_more: false } }), async (calls) => {
    const result = await handler({ body: JSON.stringify({ username: "test-player", brand: "PP", preview: true }) });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(body.row.tier, "Tier V");
    assert.equal(body.row.customerName, "", "a missing optional name does not discard the tier");
    assert.equal(body.notVip, false);
    assert.deepEqual(body.lookupWarnings, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].field_names, ["Tier", "Title name"]);
    assert.equal(calls[1].field_names, undefined);
    assert.deepEqual(calls[1].filter.conditions, conditions, "fallback preserves the player and brand filter");
  });
});

test("whole-table searches also recover from compact FieldNameNotFound", async () => {
  await withLark((body) => body.field_names
    ? json({ code: 1254043, msg: "FieldNameNotFound" })
    : json({ code: 0, data: { items: [{ record_id: "pnl-row", fields: {} }], has_more: false } }), async (calls) => {
    const rows = await searchAllRecords("pnl-fallback-table", conditions, { fieldNames: ["Tier", "Title name"] });
    assert.equal(rows.length, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].filter.conditions, conditions);
    assert.equal(calls[1].field_names, undefined);
  });
});

test("a missing filter column is still reported and the fallback stops after one retry", async () => {
  await withLark(() => json({ code: 1254043, msg: "FieldNameNotFound" }), async (calls) => {
    const result = await handler({ body: JSON.stringify({ username: "test-player", brand: "PP", preview: true }) });
    const body = JSON.parse(result.body);
    assert.deepEqual(body.lookupWarnings, ["P&L tier"]);
    assert.equal(body.row.tier, "");
    assert.equal(body.notVip, false, "an unavailable check does not mean the player is not VIP");
    assert.equal(calls.length, 2);
  });
});

test("compact field errors do not bypass rate limits or an explicit no-fallback option", async () => {
  for (const [status, opts] of [[429, {}], [200, { noProjectionFallback: true }]]) {
    await withLark(() => json({ code: 1254043, msg: "FieldNameNotFound" }, status), async (calls) => {
      await assert.rejects(searchRecords("pnl-fallback-table", conditions, undefined, { fieldNames: ["Tier"], ...opts }));
      assert.equal(calls.length, 1);
    });
  }
});
