import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, runWithRequestStart, searchRecords } from "./_lib/lark.js";

// A cancelled lookup (the agent clicked Cancel, or switched chat) leaves its pending searches unsettled for good. The next lookup
// of the same player must not wait on them. Fakes only: a stub queue, no Lark.
const ENV = { LARK_APP_ID: "cl-app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base-token", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_BONUS_CONFIG: "config-table" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const ok = (data) => ({ status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ code: 0, data }) });
const never = () => new Promise(() => {});
const where = [{ field_name: "Username", operator: "is", value: ["zzplayer"] }];

function makeStub(searchBatch) {
  const calls = [];
  const stub = { calls };
  const impls = {
    acquire: async () => ({ ticket: "t", retryAfterMs: 0 }), release: async () => {}, penalize: async () => {},
    searchBatch, createBatch: async () => ok({ record: { record_id: "rec-new" } }),
    larkCall: async () => ok({ items: [] }), cachedCall: async () => ok({ items: [] }),
  };
  for (const [name, impl] of Object.entries(impls)) stub[name] = async (...args) => { calls.push(name); return impl(...args); };
  return stub;
}
async function withFetch(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("tenant_access_token") ? json({ code: 0, tenant_access_token: "tok", expire: 7200 }) : json({ code: 0, data: {} }));
  try { await run(); } finally { globalThis.fetch = original; }
}
const env = (stub) => ({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2" });
const settles = (promise, ms) => Promise.race([promise.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("hung"), ms))]);

test("a search left hanging by a cancelled request is not joined by the next request for the same player", async () => {
  let n = 0;
  const stub = makeStub(async () => (++n === 1 ? never() : ok({ items: [{ record_id: "r1", fields: {} }], has_more: false })));
  initEnv(env(stub));
  await withFetch(async () => {
    void runWithRequestStart(() => searchRecords("customer-table", where, undefined, { timeoutMs: 60_000 })).catch(() => {});   // the cancelled lookup
    await new Promise((resolve) => setTimeout(resolve, 20));
    const retry = runWithRequestStart(() => searchRecords("customer-table", where, undefined, { timeoutMs: 60_000 }));
    assert.equal(await settles(retry, 1_500), "settled", "the retry makes its own search instead of waiting on the dead one");
    assert.equal((await retry).length, 1);
  });
  assert.equal(stub.calls.filter((c) => c === "searchBatch").length, 2);
});

test("inside ONE request an identical search is still shared (the retry pass re-asks for a search that is still running)", async () => {
  const stub = makeStub(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return ok({ items: [], has_more: false }); });
  initEnv(env(stub));
  await withFetch(async () => {
    await runWithRequestStart(async () => {
      await Promise.all([
        searchRecords("customer-table", where, undefined, { timeoutMs: 60_000 }),
        searchRecords("customer-table", where, undefined, { timeoutMs: 60_000 }),
      ]);
    });
  });
  assert.equal(stub.calls.filter((c) => c === "searchBatch").length, 1);
});
