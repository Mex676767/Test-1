import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "./ticket-list.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const author = { accountKey: "lc1", agentToken: "tok-alice" };

function network({ replies = [] } = {}) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.includes("/tickets")) { urls.push(new URL(url)); return replies.shift() || reply({ ok: true, total: 1, tickets: [{ ref: "TK2610190001", fields: { status: "OPEN" } }] }); }
    throw new Error(`unexpected ${url}`);
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}
const list = (input, env = onEnv) => { initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); resetTicketReadCache(); resetTicketRateLimit(); return handler({ httpMethod: "POST", env, body: JSON.stringify({ fresh: true, ...input }) }); };

test("mine: the ticket system is asked for tickets raised by me or assigned to me, as the signed-in agent", async () => {
  const net = network();
  try {
    const result = await list({ author, mine: true });
    assert.equal(result.statusCode, 200);
    const url = net.urls[0];
    assert.deepEqual(url.searchParams.getAll("c"), ["createdBy|is|me", "assignee|is|me"]);
    assert.equal(url.searchParams.get("match"), "any");
    assert.equal(url.searchParams.get("onBehalfOf"), "alice@x.com");
    assert.equal(url.searchParams.get("pageSize"), "100");
    assert.equal(JSON.parse(result.body).tickets[0].ref, "TK2610190001");
  } finally { net.restore(); }
});

test("mine keeps the search text, and without mine nothing about 'me' is asked", async () => {
  const net = network();
  try {
    await list({ author, mine: true, q: "hong126" });
    assert.ok(net.urls.length === 2 && net.urls.every((url) => url.searchParams.get("q") === "hong126"), "each side is read with the search text");
    await list({ author });
    assert.deepEqual(net.urls.at(-1).searchParams.getAll("c"), []);
    assert.equal(net.urls.at(-1).searchParams.get("match"), null);
  } finally { net.restore(); }
});

test("mine falls back to 'raised by me' when the ticket system refuses the assignee condition", async () => {
  const net = network({ replies: [reply({ ok: false, error: "Unknown filter condition: assignee" }, 400)] });
  try {
    const result = await list({ author, mine: true });
    assert.equal(result.statusCode, 200);
    assert.equal(net.urls.length, 2);
    assert.deepEqual(net.urls[1].searchParams.getAll("c"), ["createdBy|is|me"]);
    assert.equal(net.urls[1].searchParams.get("match"), null);
  } finally { net.restore(); }
});

test("mine: any other refusal (rate limit, key, account) is shown as it is, and is not retried", async () => {
  const net = network({ replies: [reply({ ok: false, error: "This API key is not allowed to read tickets" }, 403)] });
  try {
    const result = await list({ author, mine: true });
    assert.equal(result.statusCode, 403);
    assert.equal(net.urls.length, 1);
  } finally { net.restore(); }
});

test("mine through a plain GET (the admin preview without a LiveChat login) asks the same way", async () => {
  const net = network();
  try {
    initLiveChatEnv({});
    resetTicketReadCache(); resetTicketRateLimit();
    const result = await handler({ httpMethod: "GET", env: { TICKETS_API_KEY: "k" }, queryStringParameters: { mine: "1", fresh: "1" } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(net.urls[0].searchParams.getAll("c"), ["createdBy|is|me", "assignee|is|me"]);
    assert.equal(net.urls[0].searchParams.get("onBehalfOf"), null);
  } finally { net.restore(); }
});
