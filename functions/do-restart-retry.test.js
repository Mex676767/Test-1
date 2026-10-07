import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, getRecord, deleteRecord, createRecord, searchRecords, larkClientStats, flushCounters, doResetReason } from "./_lib/lark.js";
import { handler as searchHandler } from "./lark-search.js";

// The queue (a Durable Object) is restarted by a deploy: calls to it fail for a moment with errors like "Durable Object reset because
// its code was updated". Fakes only: the stub below plays the Durable Object, fetch plays Lark.
const ENV = { LARK_APP_ID: "restart-app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base-token", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const ok = (data) => ({ status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ code: 0, data }) });
const resetError = (text = "Durable Object reset because its code was updated.") => Object.assign(new Error(text), { retryable: true, remote: true });

function makeQueue(overrides = {}) {
  const calls = [], reports = [];
  const impls = {
    acquire: async () => ({ ticket: "t", retryAfterMs: 0 }), release: async () => {}, penalize: async () => {},
    reportCounters: async (report) => { reports.push(report); },
    searchBatch: async () => ok({ items: [], has_more: false }),
    createBatch: async () => ok({ record: { record_id: "rec-new" } }),
    larkCall: async () => ok({ record: { record_id: "r1", fields: {} } }),
    cachedCall: async () => ok({ items: [] }),
    ...overrides,
  };
  const stub = { calls, reports };
  for (const [name, impl] of Object.entries(impls)) stub[name] = async (...args) => { calls.push(name); return impl(...args, calls.filter((c) => c === name).length); };
  return stub;
}
const queueEnv = (stub, extra = {}) => ({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2", ...extra });
const countersAfter = async (stub) => { stub.reports.length = 0; await flushCounters(); return Object.assign({}, ...stub.reports); };
async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (String(url).includes("tenant_access_token") ? json({ code: 0, tenant_access_token: "tok", expire: 7200 }) : impl(String(url), init));
  try { return await run(); } finally { globalThis.fetch = original; }
}
const times = (stub, name) => stub.calls.filter((c) => c === name).length;

test("a record call that hits a restarting queue is repeated ONCE after 300-500 ms and then succeeds; the repeat is counted by reason", async () => {
  const stub = makeQueue({ larkCall: async (input, n) => { if (n === 1) throw resetError(); return ok({ record: { record_id: "r1", fields: { Status: "Solved" } } }); } });
  initEnv(queueEnv(stub));
  await countersAfter(stub);
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    const started = Date.now();
    const record = await getRecord("customer-table", "r1");
    const elapsed = Date.now() - started;
    assert.equal(record.fields.Status, "Solved");
    assert.equal(times(stub, "larkCall"), 2);
    assert.ok(elapsed >= 290 && elapsed < 1500, `waited ${elapsed} ms before repeating`);
  });
  const counters = await countersAfter(stub);
  assert.equal(counters["doRetry:codeUpdated"], 1);
  assert.equal(counters["doFailed:larkCall"], undefined, "nothing failed in the end");
});

test("a second failure is NOT repeated again: the caller gets the error, and the failed queue call is counted (it used to be invisible)", async () => {
  const stub = makeQueue({ larkCall: async () => { throw resetError("Network connection lost."); } });
  initEnv(queueEnv(stub));
  await countersAfter(stub);
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    await assert.rejects(() => getRecord("customer-table", "r1"), /Network connection lost/);
  });
  assert.equal(times(stub, "larkCall"), 2, "one attempt + one repeat");
  const counters = await countersAfter(stub);
  assert.equal(counters["doRetry:connectionLost"], 1);
  assert.equal(counters["doFailed:larkCall"], 1);
});

test("an error that is not a restart is never repeated (but is counted): a bug or a refusal must not be hammered", async () => {
  const stub = makeQueue({ larkCall: async () => { throw new Error("boom: something else"); } });
  initEnv(queueEnv(stub));
  await countersAfter(stub);
  await withFetch(() => json({ code: 0, data: {} }), async () => { await assert.rejects(() => getRecord("customer-table", "r1"), /boom/); });
  assert.equal(times(stub, "larkCall"), 1);
  const counters = await countersAfter(stub);
  assert.equal(counters["doFailed:larkCall"], 1);
  assert.ok(!Object.keys(counters).some((k) => k.startsWith("doRetry")));
});

test("DELETE and createBatch are not repeated after a restart (a delete can answer 'not found' the second time; a create's client_token and memory died with the reset), but both failures are counted", async () => {
  const stub = makeQueue({ larkCall: async () => { throw resetError(); }, createBatch: async () => { throw resetError(); } });
  initEnv(queueEnv(stub, { LARK_BATCH_CREATE: "1" }));
  await countersAfter(stub);
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    await assert.rejects(() => deleteRecord("customer-table", "r1"), /reset/);
    await assert.rejects(() => createRecord("customer-table", { Username: "x" }), /reset/);
  });
  assert.equal(times(stub, "larkCall"), 1);
  assert.equal(times(stub, "createBatch"), 1);
  const counters = await countersAfter(stub);
  assert.equal(counters["doFailed:larkCall"], 1); assert.equal(counters["doFailed:createBatch"], 1);
  assert.ok(!Object.keys(counters).some((k) => k.startsWith("doRetry")));
});

test("a search batch that hits a restarting queue is repeated once and answered by the queue (no fallback to the direct path)", async () => {
  const stub = makeQueue({ searchBatch: async (input, n) => { if (n === 1) throw resetError(); return ok({ items: [{ record_id: "r9", fields: { Username: "p1" } }], has_more: false }); } });
  initEnv(queueEnv(stub));
  await countersAfter(stub);
  const fallbacksBefore = larkClientStats.batchFallbacks;
  await withFetch(() => json({ code: 0, data: { items: [], has_more: false } }), async () => {
    const rows = await searchRecords("customer-table", [{ field_name: "Username", operator: "is", value: ["p1"] }]);
    assert.equal(rows.length, 1); assert.equal(rows[0].record_id, "r9");
  });
  assert.equal(times(stub, "searchBatch"), 2);
  assert.equal(larkClientStats.batchFallbacks, fallbacksBefore, "the repeat succeeded, so no fallback");
  assert.equal((await countersAfter(stub))["doRetry:codeUpdated"], 1);
});

test("a search batch that fails twice still falls back to the direct path, and the fallback and the failure are now visible in the counters", async () => {
  const stub = makeQueue({ searchBatch: async () => { throw resetError(); } });
  initEnv(queueEnv(stub));
  await countersAfter(stub);
  await withFetch(() => json({ code: 0, data: { items: [{ record_id: "direct", fields: { Username: "p1" } }], has_more: false } }), async () => {
    const rows = await searchRecords("customer-table", [{ field_name: "Username", operator: "is", value: ["p1"] }]);
    assert.equal(rows[0].record_id, "direct");
  });
  const counters = await countersAfter(stub);
  assert.equal(counters.batchFallback, 1); assert.equal(counters["doFailed:searchBatch"], 1); assert.equal(counters["doRetry:codeUpdated"], 1);
});

test("a whole lookup rides out a queue restart: the first queue call fails, is repeated, and the lookup answers with no warnings; if the repeat fails too the source is named in lookupWarnings", async () => {
  const lookupEnv = { ...ENV, LARK_TABLE_REDEEM_CODE: "redeem-table", LARK_TABLE_PNL: "pnl-table", LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table",
    LARK_TABLE_LTV_DAY: "ltv-table", LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table", LARK_TABLE_VIP_BOOSTER: "vip-table",
    LARK_TABLE_TELEGRAM28: "telegram-table", LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table" };
  const run = async (failures) => {
    let attempts = 0;                                                                // attempts of ONE source (Top 10 P&L) that fail
    const stub = makeQueue({ searchBatch: async (input) => { if (String(input.url).includes("top-pnl-table") && attempts++ < failures) throw resetError(); return ok({ items: [], has_more: false }); } });
    initEnv(queueEnv(stub, lookupEnv));
    let body;
    await withFetch(() => new Promise(() => {}), async () => {                       // the direct path never answers: only the queue can
      const result = await searchHandler({ body: JSON.stringify({ username: "player1", brand: "PP", preview: true }), env: { LOOKUP_FIRST_PASS_MS: "800", LOOKUP_BUDGET_MS: "2500", LOOKUP_RETRY_MIN_MS: "200" } });
      assert.equal(result.statusCode, 200);
      body = JSON.parse(result.body);
    });
    return { body, stub };
  };
  const once = await run(1);
  assert.deepEqual(once.body.lookupWarnings, [], "one reset: repeated, nothing lost");
  assert.ok(once.stub.calls.filter((c) => c === "searchBatch").length >= 11);
  const twice = await run(2);
  assert.deepEqual(twice.body.lookupWarnings, ["Top 10 P&L"], "two failures of the same call: that source is named, the rest still answers");
});

test("doResetReason: restarts and lost connections are recognised; our own timeouts, overloaded objects and ordinary errors are not", () => {
  assert.equal(doResetReason(new Error("Durable Object reset because its code was updated.")), "codeUpdated");
  assert.equal(doResetReason(new Error("The Durable Object's code has been updated, this version can no longer access this Durable Object.")), "codeUpdated");
  assert.equal(doResetReason(new Error("Network connection lost.")), "connectionLost");
  assert.equal(doResetReason(new Error("Durable Object's isolate exceeded its memory limit and was reset.")), "reset");
  assert.equal(doResetReason(Object.assign(new Error("whatever"), { retryable: true, remote: true })), "retryable");
  assert.equal(doResetReason(Object.assign(new Error("Network connection lost."), { overloaded: true })), "", "Cloudflare: do not retry an overloaded object");
  assert.equal(doResetReason(Object.assign(new Error("Lark queue did not answer in time."), { retryable: true })), "", "our own timeout is never a restart");
  assert.equal(doResetReason(new Error("Lark queue coordinator timed out.")), "");
  assert.equal(doResetReason(new Error("boom")), "");
});
