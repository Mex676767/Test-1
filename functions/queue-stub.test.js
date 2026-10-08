import test from "node:test";
import assert from "node:assert/strict";
import { queueNameOf, queueHintOf, queueStubFrom, DEFAULT_QUEUE_NAME } from "./_lib/queue-stub.js";
import { initEnv, getRecord } from "./_lib/lark.js";
import { handler as statsHandler } from "./queue-stats.js";

const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const ok = (data) => ({ status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ code: 0, data }) });
function binding(stub) {
  const seen = { names: [], getArgs: [] };
  return { seen, idFromName: (name) => { seen.names.push(name); return `id:${name}`; }, get: (...args) => { seen.getArgs.push(args); return stub; } };
}

test("default: no variables = the object named lark-api-global, found with a plain get(id) (exactly today)", () => {
  const b = binding({});
  queueStubFrom(b, {});
  assert.deepEqual(b.seen.names, [DEFAULT_QUEUE_NAME]); assert.equal(DEFAULT_QUEUE_NAME, "lark-api-global");
  assert.deepEqual(b.seen.getArgs, [["id:lark-api-global"]], "no second argument");
});

test("LARK_QUEUE_NAME and LARK_QUEUE_LOCATION_HINT select another object and a region for it; rolling back = removing them", () => {
  const b = binding({});
  queueStubFrom(b, { LARK_QUEUE_NAME: "lark-api-apac", LARK_QUEUE_LOCATION_HINT: "APAC" });
  assert.deepEqual(b.seen.names, ["lark-api-apac"]);
  assert.deepEqual(b.seen.getArgs, [["id:lark-api-apac", { locationHint: "apac" }]]);
  const back = binding({});
  queueStubFrom(back, {});
  assert.deepEqual(back.seen.getArgs, [["id:lark-api-global"]]);
});

test("junk values are ignored, never passed to Cloudflare", () => {
  for (const bad of ["", "  ", "has space", "x".repeat(65), "a/b", "naïve"]) assert.equal(queueNameOf({ LARK_QUEUE_NAME: bad }), DEFAULT_QUEUE_NAME, JSON.stringify(bad));
  for (const bad of ["", "asia", "SIN", "apac2", "wnam eur"]) assert.equal(queueHintOf({ LARK_QUEUE_LOCATION_HINT: bad }), "", JSON.stringify(bad));
  for (const good of ["wnam", "enam", "sam", "weur", "eur", "apac", "oc", "afr", "me"]) assert.equal(queueHintOf({ LARK_QUEUE_LOCATION_HINT: good }), good);
});

test("the Lark client uses the configured name and hint for its queue calls", async () => {
  const calls = [];
  const stub = { larkCall: async (input) => { calls.push(input.url); return ok({ record: { record_id: "r1", fields: {} } }); } };
  const b = binding(stub);
  initEnv({ LARK_APP_ID: "a", LARK_APP_SECRET: "s", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_CUSTOMER_APPROACHING: "ca", LARK_SEARCH_QUEUE: b, LARK_QUEUE_PROTOCOL: "v2",
    LARK_QUEUE_NAME: "lark-api-apac", LARK_QUEUE_LOCATION_HINT: "apac" });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("tenant_access_token") ? json({ code: 0, tenant_access_token: "tok", expire: 7200 }) : json({ code: 0, data: {} }));
  try { await getRecord("ca", "r1"); } finally { globalThis.fetch = original; }
  assert.equal(calls.length, 1);
  assert.ok(b.seen.names.every((n) => n === "lark-api-apac"));
  assert.ok(b.seen.getArgs.every(([id, options]) => id === "id:lark-api-apac" && options?.locationHint === "apac"));
  initEnv({});                                                       // leave the module as other tests expect it
});

test("/queue-stats asks the queue where it runs (when it can), reads the same object as the client, and still works with an older queue", async () => {
  const stats = { gapMs: 250, location: { colo: "SIN", loc: "MY" } };
  let located = 0;
  const b = binding({ getStats: async () => stats, locate: async () => { located++; } });
  const res = await statsHandler({ httpMethod: "GET", headers: { "x-stats-key": "k" }, env: { QUEUE_STATS_KEY: "k", LARK_SEARCH_QUEUE: b, LARK_QUEUE_NAME: "lark-api-apac", LARK_QUEUE_LOCATION_HINT: "apac" } });
  assert.equal(res.statusCode, 200); assert.equal(located, 1);
  assert.deepEqual(JSON.parse(res.body).stats.location, { colo: "SIN", loc: "MY" });
  assert.deepEqual(b.seen.names, ["lark-api-apac"]);
  const older = binding({ getStats: async () => ({ gapMs: 250 }) });
  const res2 = await statsHandler({ httpMethod: "GET", headers: { "x-stats-key": "k" }, env: { QUEUE_STATS_KEY: "k", LARK_SEARCH_QUEUE: older } });
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(older.seen.names, ["lark-api-global"]);
  const failing = binding({ getStats: async () => ({ gapMs: 250 }), locate: async () => { throw new Error("trace unreachable"); } });
  assert.equal((await statsHandler({ httpMethod: "GET", headers: { "x-stats-key": "k" }, env: { QUEUE_STATS_KEY: "k", LARK_SEARCH_QUEUE: failing } })).statusCode, 200);
});
