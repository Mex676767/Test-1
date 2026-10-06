import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "./queue-stats.js";

const STATS = { starts: 12, throttled: 0, createBatches: 2, createMismatches: 0, queued: 0 };
const queue = (stats = STATS) => ({ idFromName: (n) => n, get: () => ({ getStats: async () => stats }) });
const call = async (event) => { const r = await handler(event); return { ...r, body: JSON.parse(r.body) }; };

test("disabled (404) until QUEUE_STATS_KEY is set, whatever the caller sends", async () => {
  const r = await call({ httpMethod: "GET", headers: { "x-stats-key": "x" }, env: { LARK_SEARCH_QUEUE: queue() } });
  assert.equal(r.statusCode, 404);
});

test("wrong or missing key is 401 and never reaches the queue", async () => {
  let asked = 0;
  const env = { QUEUE_STATS_KEY: "s3cret-key", LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => { asked += 1; return { getStats: async () => STATS }; } } };
  for (const headers of [{}, { "x-stats-key": "" }, { "x-stats-key": "s3cret-kez" }, { "x-stats-key": "s3cret-key-extra" }]) {
    assert.equal((await call({ httpMethod: "GET", headers, env })).statusCode, 401);
  }
  assert.equal(asked, 0);
});

test("the right key in the header returns the stats, uncached; the key in the URL does not work", async () => {
  const env = { QUEUE_STATS_KEY: "s3cret-key", LARK_SEARCH_QUEUE: queue() };
  const r = await call({ httpMethod: "GET", headers: { "x-stats-key": "s3cret-key" }, env });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.stats, STATS);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal((await call({ httpMethod: "GET", headers: {}, queryStringParameters: { key: "s3cret-key" }, env })).statusCode, 401);
});

test("only GET; a missing binding or an old queue without getStats is a clean 503", async () => {
  const headers = { "x-stats-key": "k" };
  assert.equal((await call({ httpMethod: "POST", headers, env: { QUEUE_STATS_KEY: "k", LARK_SEARCH_QUEUE: queue() } })).statusCode, 405);
  assert.equal((await call({ httpMethod: "GET", headers, env: { QUEUE_STATS_KEY: "k" } })).statusCode, 503);
  const old = { idFromName: () => "g", get: () => ({}) };
  assert.equal((await call({ httpMethod: "GET", headers, env: { QUEUE_STATS_KEY: "k", LARK_SEARCH_QUEUE: old } })).statusCode, 503);
});
