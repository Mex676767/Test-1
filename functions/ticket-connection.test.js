import assert from "node:assert/strict";
import test from "node:test";
import { deps, openToken, sealToken } from "./_lib/ticket-connection.js";
import { handler as connectHandler } from "./ticket-connect.js";
import { handler as commentHandler } from "./ticket-comment.js";
import { handler as createHandler } from "./ticket-create.js";
import { handler as statusHandler } from "./ticket-status.js";
import { handler as listHandler } from "./ticket-list.js";

// Fakes only: no LiveChat, no Lark, no ticket service.
const SHARED = "tmk_shared0000000000000000";
const PERSONAL = "tmk_personal00000000000000";
const SECRET = "test-secret-value";

function fakeKv() {
  const map = new Map();
  return { map, get: async (key) => map.get(key) ?? null, put: async (key, value) => { map.set(key, value); }, delete: async (key) => { map.delete(key); } };
}
const makeEnv = (kv = fakeKv()) => ({ TICKETS_API_KEY: SHARED, TICKET_TOKEN_SECRET: SECRET, TICKET_CONNECTIONS: kv });

// A LiveChat token "a1" is the login "login-a1"; anything starting with "bad" is expired.
const realIdentify = deps.identify;
deps.identify = async (_env, _account, token) => (token.startsWith("bad") ? { ok: false, loginExpired: true, error: "LiveChat login expired or invalid — connect LiveChat again." } : { ok: true, login: `login-${token}` });

const headersFor = (token) => ({ "x-livechat-account": "lc1", "x-livechat-agent-token": token });

// Records the Authorization header of every upstream call; `accepted` lists the ticket tokens the fake service honours.
function fakeTicketService(accepted = [SHARED, PERSONAL]) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const auth = options?.headers?.Authorization || "";
    calls.push({ url: String(url), auth, body: options?.body });
    if (!accepted.some((token) => auth === `Bearer ${token}`)) {
      return new Response(JSON.stringify({ ok: false, error: "Not signed in." }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const u = String(url);
    if (/\/comments$/.test(u)) return new Response(JSON.stringify({ ok: true, parentId: null, comment: { id: 9, author: { id: 1, name: "X" }, body: "b" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    if (u.includes("/tickets/TK")) return new Response(JSON.stringify({ ok: true, ticket: { ref: "TK2610010295", fields: {}, comments: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (/\/tickets(\?|$)/.test(u) && options?.method === "POST") return new Response(JSON.stringify({ ok: true, id: 5, ref: "TK2610010296" }), { status: 201, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, total: 0, tickets: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const connect = (env, token, input) => connectHandler({ httpMethod: "POST", env, headers: headersFor(token), body: JSON.stringify(input) });
const comment = (env, token, input = { body: "hello" }) => commentHandler({ httpMethod: "POST", env, headers: token ? headersFor(token) : {}, queryStringParameters: { ref: "TK2610010295" }, body: JSON.stringify(input) });

test("a sealed token opens only with the same secret and is not readable", async () => {
  const sealed = await sealToken(SECRET, PERSONAL);
  assert.ok(!sealed.includes(PERSONAL));
  assert.equal(await openToken(SECRET, sealed), PERSONAL);
  assert.equal(await openToken("another-secret", sealed), "");
  assert.equal(await openToken(SECRET, sealed.slice(0, -4) + "AAAA"), "");
  assert.equal(await openToken(SECRET, "plain text"), "");
});

test("connect: a token the ticket service refuses is never stored", async () => {
  const kv = fakeKv();
  const service = fakeTicketService([SHARED]);
  try {
    const result = await connect(makeEnv(kv), "a1", { action: "save", ticketToken: PERSONAL });
    assert.equal(JSON.parse(result.body).ok, false);
    assert.equal(kv.map.size, 0);
  } finally { service.restore(); }
});

test("connect: a malformed token is refused before the ticket service is called", async () => {
  const kv = fakeKv();
  const service = fakeTicketService();
  try {
    const result = await connect(makeEnv(kv), "a2", { action: "save", ticketToken: "not a token" });
    assert.equal(result.statusCode, 400);
    assert.equal(service.calls.length, 0);
    assert.equal(kv.map.size, 0);
  } finally { service.restore(); }
});

test("connect: save keeps the token encrypted per LiveChat login, status reflects it, disconnect removes it, and the token is never returned", async () => {
  const kv = fakeKv();
  const env = makeEnv(kv);
  const service = fakeTicketService();
  try {
    assert.equal(JSON.parse((await connect(env, "a3", { action: "status" })).body).connected, false);
    const saved = await connect(env, "a3", { action: "save", ticketToken: PERSONAL });
    assert.equal(JSON.parse(saved.body).connected, true);
    assert.ok(!saved.body.includes(PERSONAL));
    assert.equal(kv.map.size, 1);
    const [[key, sealed]] = [...kv.map];
    assert.equal(key, "ticket-token:lc1:login-a3");
    assert.ok(!sealed.includes(PERSONAL));
    assert.equal(await openToken(SECRET, sealed), PERSONAL);

    assert.equal(JSON.parse((await connect(env, "a3", { action: "status" })).body).connected, true);
    assert.equal(JSON.parse((await connect(env, "other", { action: "status" })).body).connected, false, "another login is not connected");

    assert.equal(JSON.parse((await connect(env, "a3", { action: "disconnect" })).body).connected, false);
    assert.equal(kv.map.size, 0);
  } finally { service.restore(); }
});

test("connect: an expired LiveChat login is refused and nothing is written", async () => {
  const kv = fakeKv();
  const service = fakeTicketService();
  try {
    const body = JSON.parse((await connect(makeEnv(kv), "bad1", { action: "save", ticketToken: PERSONAL })).body);
    assert.equal(body.ok, false);
    assert.equal(body.loginExpired, true);
    assert.equal(kv.map.size, 0);
  } finally { service.restore(); }
});

test("connect reports the feature as unavailable when the secret or the store is missing", async () => {
  const result = await connect({ TICKETS_API_KEY: SHARED }, "a4", { action: "status" });
  const body = JSON.parse(result.body);
  assert.equal(body.available, false);
  assert.equal(body.connected, false);
});

test("a connected agent's comment is made with their own token, with no name label", async () => {
  const kv = fakeKv();
  const env = makeEnv(kv);
  const service = fakeTicketService();
  try {
    await connect(env, "a5", { action: "save", ticketToken: PERSONAL });
    service.calls.length = 0;
    const result = await comment(env, "a5", { body: "Refund done", agent: "Aisyah" });
    assert.equal(result.statusCode, 201);
    assert.equal(JSON.parse(result.body).postedAs, "own");
    assert.equal(service.calls[0].auth, `Bearer ${PERSONAL}`);
    assert.deepEqual(JSON.parse(service.calls[0].body), { body: "Refund done" });
  } finally { service.restore(); }
});

test("an agent who has not connected falls back to the shared key with the name label", async () => {
  const env = makeEnv();
  const service = fakeTicketService();
  try {
    const result = await comment(env, "a6", { body: "Refund done", agent: "Aisyah" });
    assert.equal(JSON.parse(result.body).postedAs, "shared");
    assert.equal(service.calls[0].auth, `Bearer ${SHARED}`);
    assert.equal(JSON.parse(service.calls[0].body).body, "[Aisyah via widget] Refund done");
  } finally { service.restore(); }
});

test("one agent's token is never used for another login", async () => {
  const kv = fakeKv();
  const env = makeEnv(kv);
  const service = fakeTicketService();
  try {
    await connect(env, "a7", { action: "save", ticketToken: PERSONAL });
    service.calls.length = 0;
    await comment(env, "a8", { body: "hi", agent: "B" });
    assert.equal(service.calls[0].auth, `Bearer ${SHARED}`);
  } finally { service.restore(); }
});

test("a personal token the ticket service no longer accepts asks the agent to reconnect (no silent fallback)", async () => {
  const kv = fakeKv();
  const env = makeEnv(kv);
  let service = fakeTicketService();
  try {
    await connect(env, "a9", { action: "save", ticketToken: PERSONAL });
    service.restore();
    service = fakeTicketService([SHARED]); // the personal token was revoked
    const result = await comment(env, "a9", { body: "hi" });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 401);
    assert.equal(body.ticketReconnect, true);
    assert.equal(service.calls.length, 1, "the shared key is not tried instead");
  } finally { service.restore(); }
});

test("a stored token that cannot be opened (secret changed) asks the agent to reconnect", async () => {
  const kv = fakeKv();
  kv.map.set("ticket-token:lc1:login-b1", await sealToken("an-older-secret", PERSONAL));
  const service = fakeTicketService();
  try {
    const result = await comment(makeEnv(kv), "b1", { body: "hi" });
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).ticketReconnect, true);
    assert.equal(service.calls.length, 0);
  } finally { service.restore(); }
});

test("an expired LiveChat login on a ticket call is reported, not answered with the shared key", async () => {
  const service = fakeTicketService();
  try {
    const result = await comment(makeEnv(), "bad2", { body: "hi" });
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).loginExpired, true);
    assert.equal(service.calls.length, 0);
  } finally { service.restore(); }
});

test("with the feature off, a LiveChat login header changes nothing: the shared key is used", async () => {
  const service = fakeTicketService();
  try {
    const result = await comment({ TICKETS_API_KEY: SHARED }, "b2", { body: "hi", agent: "A" });
    assert.equal(result.statusCode, 201);
    assert.equal(service.calls[0].auth, `Bearer ${SHARED}`);
  } finally { service.restore(); }
});

test("status, list and create also run as the connected agent", async () => {
  const kv = fakeKv();
  const env = makeEnv(kv);
  const service = fakeTicketService();
  try {
    await connect(env, "b3", { action: "save", ticketToken: PERSONAL });
    service.calls.length = 0;
    await statusHandler({ httpMethod: "GET", env, headers: headersFor("b3"), queryStringParameters: { ref: "TK2610010295" } });
    await listHandler({ httpMethod: "GET", env, headers: headersFor("b3"), queryStringParameters: { q: "x" } });
    const created = await createHandler({ httpMethod: "POST", env, headers: headersFor("b3"), body: JSON.stringify({ fields: { toDepartment: "CS", member_id: "m" } }) });
    assert.equal(JSON.parse(created.body).createdAs, "own");
    assert.deepEqual(service.calls.map((call) => call.auth), [`Bearer ${PERSONAL}`, `Bearer ${PERSONAL}`, `Bearer ${PERSONAL}`]);
  } finally { service.restore(); }
});

test.after(() => { deps.identify = realIdentify; });
