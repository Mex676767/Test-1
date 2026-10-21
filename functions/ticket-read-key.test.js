import assert from "node:assert/strict";
import test from "node:test";
import { handler as listHandler } from "./ticket-list.js";
import { handler as commentHandler } from "./ticket-comment.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache, ticketGet, ticketRequest } from "./_lib/tickets.js";

const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const author = { accountKey: "lc1", agentToken: "tok-alice" };
const base = { TICKETS_API_KEY: "key-main", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const withReads = { ...base, TICKETS_API_KEY_READS: "key-reads" };

function network(answer) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return Response.json(TOKENS[String(options.headers.Authorization).replace("Bearer ", "")]);
    const key = String(options.headers?.Authorization || "").replace("Bearer ", "");
    const parsed = new URL(url);
    calls.push({ key, method: options.method || "GET", path: parsed.pathname.replace(/^.*\/api\/v1/, "") });
    return answer ? answer(key, options.method || "GET", parsed) : reply({ ok: true, total: 0, tickets: [], ticket: { ref: "TK2610190001", comments: [] }, comment: { id: 1 } }, options.method === "POST" ? 201 : 200);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const reset = () => { initLiveChatEnv({ LIVECHAT_PAT: "pat" }); resetTicketReadCache(); resetTicketRateLimit(); };

test("with a second key, the polling reads (list, one ticket) use it and everything that writes uses the main key", async () => {
  reset();
  const net = network();
  try {
    await listHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ fresh: true, author }) });
    await commentHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ ref: "TK2610190001", body: "hi", author }) });
    assert.deepEqual(net.calls.map((c) => [c.method, c.path, c.key]), [["GET", "/tickets", "key-reads"], ["POST", "/tickets/TK2610190001/comments", "key-main"]]);
  } finally { net.restore(); }
});

test("without a second key every call uses the one key, as before", async () => {
  reset();
  const net = network();
  try {
    await listHandler({ httpMethod: "POST", env: base, body: JSON.stringify({ fresh: true, author }) });
    await commentHandler({ httpMethod: "POST", env: base, body: JSON.stringify({ ref: "TK2610190001", body: "hi", author }) });
    assert.deepEqual([...new Set(net.calls.map((c) => c.key))], ["key-main"]);
  } finally { net.restore(); }
});

test("each key has its own limit: a 429 on the reads key stops reads for that long but not a comment, and the other way round", async () => {
  reset();
  const net = network((key, method) => (key === "key-reads" && method === "GET" ? reply({ ok: false, error: "Rate limit exceeded" }, 429, { "Retry-After": "20" }) : reply({ ok: true, comment: { id: 1 } }, 201)));
  try {
    const refused = await listHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ fresh: true, author }) });
    assert.equal(refused.statusCode, 429);
    assert.match(JSON.parse(refused.body).error, /busy.*Try again in 20 s/);
    const before = net.calls.length;
    const paused = await listHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ fresh: true, author }) });
    assert.equal(paused.statusCode, 429);
    assert.equal(net.calls.length, before, "no call to the ticket system while the reads key is paused");
    const posted = await commentHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ ref: "TK2610190001", body: "hi", author }) });
    assert.equal(posted.statusCode, 201, "the main key is not paused");
  } finally { net.restore(); }
  reset();
  const other = network((key, method) => (method === "POST" ? reply({ ok: false, error: "Rate limit exceeded" }, 429, { "Retry-After": "20" }) : reply({ ok: true, total: 0, tickets: [] })));
  try {
    await commentHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ ref: "TK2610190001", body: "hi", author }) });
    const list = await listHandler({ httpMethod: "POST", env: withReads, body: JSON.stringify({ fresh: true, author }) });
    assert.equal(list.statusCode, 200, "reads carry on when only the main key is limited");
  } finally { other.restore(); }
});

test("the read cache keeps reads of the two keys apart, and the low-level helpers take the key from the call", async () => {
  reset();
  const net = network();
  try {
    await ticketGet(withReads, "/tickets", { ttlMs: 60_000 });
    await ticketGet(base, "/tickets", { ttlMs: 60_000 });
    assert.deepEqual(net.calls.map((c) => c.key), ["key-reads", "key-main"], "a copy read with one key is not served for the other");
    await ticketRequest(withReads, "/markets");
    assert.equal(net.calls.at(-1).key, "key-main", "an ordinary request is not a polling read");
    await ticketRequest(withReads, "/markets", { reads: true });
    assert.equal(net.calls.at(-1).key, "key-reads");
  } finally { net.restore(); }
});

test("several read keys: an agent always gets the same one, the agents are spread over all of them, and writes still use the main key", async () => {
  reset();
  const env = { ...base, TICKETS_API_KEY_READS: "r1, r2 ,r3" };
  const net = network();
  try {
    const keyOf = async (email) => { const before = net.calls.length; resetTicketReadCache(); await ticketGet(env, `/tickets?onBehalfOf=${encodeURIComponent(email)}`); return net.calls[before].key; };
    const first = await keyOf("agent1@x.com");
    assert.equal(await keyOf("agent1@x.com"), first, "the same agent, the same key");
    const used = new Set();
    for (let i = 0; i < 60; i += 1) used.add(await keyOf(`agent${i}@x.com`));
    assert.deepEqual([...used].sort(), ["r1", "r2", "r3"], "60 agents land on all three keys");
    await ticketRequest(env, "/tickets", { method: "POST", body: "{}" });
    assert.equal(net.calls.at(-1).key, "key-main");
    assert.equal(await keyOf("AGENT1@X.COM"), first, "case does not move an agent to another key");
  } finally { net.restore(); }
});

test("catalog and account-check reads use the read keys too, so they never take a write's calls", async () => {
  const config = (await import("node:fs")).readFileSync(new URL("./ticket-config.js", import.meta.url), "utf8");
  const account = (await import("node:fs")).readFileSync(new URL("./ticket-account.js", import.meta.url), "utf8");
  assert.equal((config.match(/\{ reads: true \}/g) || []).length, 5);
  assert.match(account, /\/markets\?onBehalfOf=\$\{encodeURIComponent\(email\)\}`, \{ reads: true \}/);
});

test("numbered variables are read keys too: TICKETS_API_KEY1..5 and TICKETS_API_KEY_READS_1..5; the un-numbered TICKETS_API_KEY stays the writing key", async () => {
  const { readKeys } = await import("./_lib/tickets.js");
  const env = { TICKETS_API_KEY: "main", TICKETS_API_KEY2: "b", TICKETS_API_KEY1: "a", TICKETS_API_KEY10: "j", TICKETS_API_KEY_READS_3: "c", TICKETS_API_KEY_READS: "x, y", OTHER_KEY1: "no", TICKETS_API_KEYS: "no" };
  assert.deepEqual(readKeys(env), ["x", "y", "a", "b", "c", "j"], "the comma list first, then the numbered ones in numeric order, never the main key");
  assert.deepEqual(readKeys({ TICKETS_API_KEY: "main" }), []);
  assert.deepEqual(readKeys({ TICKETS_API_KEY1: "a", TICKETS_API_KEY_READS: "a" }), ["a"], "a key given twice counts once");
  assert.deepEqual(readKeys({ TICKETS_API_KEY1: "  ", TICKETS_API_KEY2: "" }), [], "empty variables are ignored");
  reset();
  const net = network();
  try {
    const numbered = { ...base, TICKETS_API_KEY1: "n1", TICKETS_API_KEY2: "n2" };
    const used = new Set();
    for (let i = 0; i < 30; i += 1) { resetTicketReadCache(); const before = net.calls.length; await ticketGet(numbered, `/tickets?onBehalfOf=agent${i}%40x.com`); used.add(net.calls[before].key); }
    assert.deepEqual([...used].sort(), ["n1", "n2"], "reads are spread over the numbered keys");
    await ticketRequest(numbered, "/tickets", { method: "POST", body: "{}" });
    assert.equal(net.calls.at(-1).key, "key-main", "writes use TICKETS_API_KEY");
  } finally { net.restore(); }
});
