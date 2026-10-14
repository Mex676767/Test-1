import test from "node:test";
import assert from "node:assert/strict";
import { handler, tickKey } from "./unknown-tick.js";
import { handler as crosscheck } from "./crosscheck.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";

// A tiny fake of a Workers KV namespace: put with metadata and expiry, get, delete, and a prefix list that pages.
function fakeKv() {
  const data = new Map();
  return {
    data,
    async put(key, value, options = {}) { data.set(key, { value, metadata: options.metadata, ttl: options.expirationTtl }); },
    async get(key) { return data.get(key)?.value ?? null; },
    async delete(key) { data.delete(key); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...data.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const end = start + limit;
      return { keys: page.map((name) => ({ name, metadata: data.get(name).metadata })), list_complete: end >= names.length, cursor: String(end) };
    },
  };
}
const send = async (kv, body) => {
  const res = await handler({ body: JSON.stringify(body), env: kv ? { UNKNOWN_TICKS: kv } : {} });
  return { status: res.statusCode, ...JSON.parse(res.body) };
};

test("a tick is stored once per chat and agent, with the facts in the key's metadata and an expiry; tracking start is written once", async () => {
  const kv = fakeKv();
  assert.equal((await send(kv, { threadId: "T1", chatId: "C1", agentName: "96 Alice", ticked: true })).ok, true);
  assert.equal((await send(kv, { threadId: "T1", chatId: "C1", agentName: " 96  ALICE ", ticked: true, source: "auto" })).ok, true, "the same chat and agent again: one key");
  const key = tickKey("T1", "C1", "96 Alice");
  assert.equal(key, "t:T1:96 alice");
  const stored = kv.data.get(key);
  assert.equal(stored.metadata.threadId, "T1");
  assert.equal(stored.metadata.agent, "96 ALICE", "the latest tick wins");
  assert.equal(stored.metadata.source, "auto");
  assert.ok(stored.ttl > 86400);
  const since = kv.data.get("meta:since").value;
  await send(kv, { threadId: "T2", agentName: "96 Bob", ticked: true });
  assert.equal(kv.data.get("meta:since").value, since, "the start of tracking is the first tick and never moves");
  assert.equal(kv.data.get("t:T2:96 bob").metadata.source, "manual");
});

test("a tick before the thread is known is kept under the chat id; un-ticking removes it whichever id the widget knows by then", async () => {
  const kv = fakeKv();
  await send(kv, { chatId: "C9", agentName: "96 Alice", ticked: true });
  assert.ok(kv.data.has("t:c-C9:96 alice"));
  await send(kv, { threadId: "T9", chatId: "C9", agentName: "96 Alice", ticked: false });
  assert.equal(kv.data.has("t:c-C9:96 alice"), false);
  await send(kv, { threadId: "T9", agentName: "96 Alice", ticked: true });
  assert.ok(kv.data.has("t:T9:96 alice"));
  assert.equal((await send(kv, { threadId: "T9", agentName: "96 Alice", ticked: false })).ticked, false);
  assert.equal(kv.data.has("t:T9:96 alice"), false);
});

test("without the KV binding the endpoint says so and does nothing; bad input is refused", async () => {
  assert.deepEqual(await send(null, { threadId: "T1", agentName: "A", ticked: true }), { status: 200, ok: false, notConfigured: true, error: "UNKNOWN_TICKS (a KV binding) is not set." });
  const kv = fakeKv();
  assert.equal((await send(kv, { threadId: "T1", ticked: true })).status, 400, "no agent");
  assert.equal((await send(kv, { agentName: "A", ticked: true })).status, 400, "no chat");
  assert.equal((await send(kv, { threadId: "bad id/with space", agentName: "A", ticked: true })).status, 400);
  assert.equal((await send(kv, { threadId: "T".repeat(81), agentName: "A", ticked: true })).status, 400);
  assert.equal((await send(kv, { threadId: "T1", agentName: "x".repeat(121), ticked: true })).status, 400);
  assert.equal(kv.data.size, 0);
});

test("/crosscheck step ticks lists the ticks with when tracking began; with no binding it says not configured", async () => {
  const kv = fakeKv();
  for (let i = 0; i < 3; i += 1) await send(kv, { threadId: "T" + i, agentName: "96 Alice", ticked: true });
  const env = { SCAN_KEY: "scan-secret", UNKNOWN_TICKS: kv };
  initLarkEnv(env);
  const ask = async (body, e = env) => JSON.parse((await crosscheck({ body: JSON.stringify(body), env: e, headers: { "x-scan-key": "scan-secret" } })).body);
  const all = await ask({ step: "ticks" });
  assert.equal(all.configured, true);
  assert.deepEqual(all.ticks.map((t) => t.threadId).sort(), ["T0", "T1", "T2"]);
  assert.equal(all.next, "");
  assert.ok(all.since > 0);
  assert.ok(!JSON.stringify(all.ticks).includes("meta:since"), "the start-of-tracking key is not a tick");
  const unbound = await ask({ step: "ticks" }, { SCAN_KEY: "scan-secret" });
  assert.deepEqual(unbound, { ok: true, configured: false, ticks: [], next: "", since: 0 });
});
