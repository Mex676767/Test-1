import test from "node:test";
import assert from "node:assert/strict";
import { handler, tickKey } from "./unknown-tick.js";
import { handler as claimHandler } from "./claim-log.js";
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

test("a claim is stored per chat, agent and bonus with its facts in the metadata and an expiry; the first claim starts the 'since' clock once", async () => {
  const kv = fakeKv();
  const send = async (body) => JSON.parse((await claimHandler({ body: JSON.stringify(body), env: { UNKNOWN_TICKS: kv } })).body);
  const claim = (extra = {}) => ({ agentName: "96 Alice", threadId: "T1", chatId: "C1", claim: { program: "topPnl", label: "Top 10 P&L", source: "Pass RM18", inquiry: "TOP P&L", amount: "18", ...extra } });
  assert.equal((await send(claim())).ok, true);
  const stored = kv.data.get("claim:T1:96 alice:topPnl");
  assert.deepEqual({ ...stored.metadata, at: 0 }, { threadId: "T1", chatId: "C1", agent: "96 Alice", program: "topPnl", at: 0, label: "Top 10 P&L", source: "Pass RM18", inquiry: "TOP P&L", amount: "18" });
  assert.ok(stored.ttl > 86400);
  const since = kv.data.get("meta:claims-since").value;
  await send(claim({ program: "ltvTest", amount: 20 }));
  assert.equal(kv.data.get("meta:claims-since").value, since, "never moves");
  assert.equal(kv.data.get("claim:T1:96 alice:ltvTest").metadata.amount, "20", "a number is kept as text");
  await send({ ...claim(), agentName: "96 Bob" });
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith("claim:T1:")).length, 3, "each agent keeps their own");
});

test("an unclaim forgets every bonus of that agent on that chat, under either id, and nobody else's", async () => {
  const kv = fakeKv();
  const send = async (body) => JSON.parse((await claimHandler({ body: JSON.stringify(body), env: { UNKNOWN_TICKS: kv } })).body);
  const claim = (agent, program, ids) => ({ agentName: agent, ...ids, claim: { program, label: program, inquiry: "X", amount: "1" } });
  await send(claim("96 Alice", "topPnl", { threadId: "T1", chatId: "C1" }));
  await send(claim("96 Alice", "ltvTest", { threadId: "T1", chatId: "C1" }));
  await send(claim("96 Alice", "gracePeriod", { chatId: "C1" })); // stored before the thread was known
  await send(claim("96 Bob", "topPnl", { threadId: "T1", chatId: "C1" }));
  assert.equal((await send({ agentName: "96 ALICE", threadId: "T1", chatId: "C1", remove: true })).removed, true);
  assert.deepEqual([...kv.data.keys()].filter((k) => k.startsWith("claim:")), ["claim:T1:96 bob:topPnl"]);
});

test("a claim needs a program, an agent, a chat and a valid id; without the KV binding it says so", async () => {
  const kv = fakeKv();
  const send = async (body, env = { UNKNOWN_TICKS: kv }) => { const r = await claimHandler({ body: JSON.stringify(body), env }); return { status: r.statusCode, ...JSON.parse(r.body) }; };
  const ok = { agentName: "A", threadId: "T123", claim: { program: "topPnl" } };
  assert.equal((await send({ ...ok, claim: {} })).status, 400, "no program");
  assert.equal((await send({ ...ok, claim: { program: "bad program!" } })).status, 400);
  assert.equal((await send({ ...ok, agentName: "" })).status, 400);
  assert.equal((await send({ ...ok, threadId: "" })).status, 400);
  assert.equal((await send({ ...ok, threadId: "has space" })).status, 400);
  assert.equal(kv.data.size, 0);
  assert.deepEqual(await send(ok, {}), { status: 200, ok: false, notConfigured: true, error: "UNKNOWN_TICKS (a KV binding) is not set." });
});

test("/crosscheck chatlog also lists the claims of that chat only, and when claims started being recorded", async () => {
  const kv = fakeKv();
  const send = async (body) => claimHandler({ body: JSON.stringify(body), env: { UNKNOWN_TICKS: kv } });
  await send({ agentName: "96 Alice", threadId: "THREADX", chatId: "C", claim: { program: "topPnl", label: "Top 10 P&L", source: "Pass RM18", inquiry: "TOP P&L", amount: "18" } });
  await send({ agentName: "96 Alice", threadId: "THREADXY", chatId: "C", claim: { program: "topPnl" } });
  const env = { SCAN_KEY: "scan-secret", UNKNOWN_TICKS: kv, LARK_APP_ID: "a", LARK_APP_SECRET: "s", LARK_BASE_APP_TOKEN: "b", LARK_TABLE_CUSTOMER_APPROACHING: "ca-table" };
  initLarkEnv(env);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("tenant_access_token") ? { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) } : { json: async () => ({ code: 0, data: { items: [], has_more: false } }) });
  let data;
  try {
    const res = await crosscheck({ body: JSON.stringify({ step: "chatlog", threadId: "THREADX" }), env, headers: { "x-scan-key": "scan-secret" } });
    data = JSON.parse(res.body);
  } finally { globalThis.fetch = original; }
  assert.deepEqual(data.claims.map((c) => [c.agent, c.program, c.label, c.source, c.inquiry, c.amount]), [["96 Alice", "topPnl", "Top 10 P&L", "Pass RM18", "TOP P&L", "18"]]);
  assert.ok(data.tracking.claimsSince > 0);
});
