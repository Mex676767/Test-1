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

// answer(key, method, path): the fake ticket system, which sees which key each call carries.
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
