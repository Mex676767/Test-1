import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "./ticket-list.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const author = { accountKey: "lc1", agentToken: "tok-alice" };
const ticket = (ref, updatedAt) => ({ ref, updatedAt, fields: {} });

// answer(url): what the fake ticket system returns for each list read.
function network(answer) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return Response.json(TOKENS[String(options.headers.Authorization).replace("Bearer ", "")]);
    const parsed = new URL(url);
    urls.push(parsed);
    return answer ? answer(parsed, urls.length) : reply({ ok: true, total: 1, tickets: [ticket("TK1", "2026-10-19T01:00:00.000Z")] });
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}
const list = (input) => { initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); resetTicketReadCache(); resetTicketRateLimit(); return handler({ httpMethod: "POST", env: onEnv, body: JSON.stringify({ fresh: true, author, ...input }) }); };
const conditions = (url) => url.searchParams.getAll("c");

test("status, department and market are asked of the ticket system, all together", async () => {
  const net = network();
  try {
    const result = await list({ status: "PYM_SOLVED", department: "60", market: "1" });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(conditions(net.urls[0]), ["f:status|is|PYM_SOLVED", "dept|is|60", "market|is|1"]);
    assert.equal(net.urls[0].searchParams.get("match"), "all");
  } finally { net.restore(); }
});

test("one condition needs no match; none sends none", async () => {
  const net = network();
  try {
    await list({ status: "SOLVED" });
    assert.deepEqual(conditions(net.urls[0]), ["f:status|is|SOLVED"]);
    assert.equal(net.urls[0].searchParams.get("match"), null);
    await list({});
    assert.deepEqual(conditions(net.urls[1]), []);
  } finally { net.restore(); }
});

test("my tickets of one status: raised by me and assigned to me are each read with the status and merged, newest first, each ticket once", async () => {
  const net = network((url) => {
    const first = conditions(url)[0];
    return reply({ ok: true, total: first.startsWith("createdBy") ? 92 : 5, tickets: first.startsWith("createdBy")
      ? [ticket("TK-A", "2026-10-19T03:00:00.000Z"), ticket("TK-B", "2026-10-19T01:00:00.000Z")]
      : [ticket("TK-C", "2026-10-19T02:00:00.000Z"), ticket("TK-A", "2026-10-19T03:00:00.000Z")] });
  });
  try {
    const result = await list({ mine: true, status: "PYM_SOLVED" });
    assert.deepEqual(net.urls.map(conditions), [["createdBy|is|me", "f:status|is|PYM_SOLVED"], ["assignee|is|me", "f:status|is|PYM_SOLVED"]]);
    assert.ok(net.urls.every((url) => url.searchParams.get("match") === "all"), "both conditions must hold on each side");
    const body = JSON.parse(result.body);
    assert.deepEqual(body.tickets.map((item) => item.ref), ["TK-A", "TK-C", "TK-B"]);
    assert.equal(body.total, 92);
  } finally { net.restore(); }
});

test("an agent by id with a department works the same way; without narrowing it is still the one OR request", async () => {
  const net = network();
  try {
    await list({ agent: "44", department: "60" });
    assert.deepEqual(net.urls.map(conditions), [["createdBy|is|44", "dept|is|60"], ["assignee|is|44", "dept|is|60"]]);
    net.urls.length = 0;
    await list({ agent: "44" });
    assert.equal(net.urls.length, 1);
    assert.deepEqual(conditions(net.urls[0]), ["createdBy|is|44", "assignee|is|44"]);
    assert.equal(net.urls[0].searchParams.get("match"), "any");
  } finally { net.restore(); }
});

test("if the assignee side is refused, the raised-by side alone is the answer; any other refusal is shown", async () => {
  const net = network((url, n) => (n === 2 ? reply({ ok: false, error: "Unknown filter condition" }, 400) : reply({ ok: true, total: 1, tickets: [ticket("TK-A", "2026-10-19T03:00:00.000Z")] })));
  try {
    const result = await list({ mine: true, status: "SOLVED" });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body).tickets.map((item) => item.ref), ["TK-A"]);
  } finally { net.restore(); }
  const refused = network(() => reply({ ok: false, error: "This API key is not allowed to read tickets" }, 403));
  try {
    assert.equal((await list({ mine: true, status: "SOLVED" })).statusCode, 403);
  } finally { refused.restore(); }
});

test("the narrowing is checked before anything is sent", async () => {
  const net = network();
  try {
    assert.equal((await list({ status: "SOLVED|or|x" })).statusCode, 400);
    assert.equal((await list({ department: "60; drop" })).statusCode, 400);
    assert.equal((await list({ market: "abc" })).statusCode, 400);
    assert.equal(net.urls.length, 0);
  } finally { net.restore(); }
});

test("a plain GET (admin preview without a login) takes the same narrowing", async () => {
  const net = network();
  try {
    initLiveChatEnv({});
    resetTicketReadCache(); resetTicketRateLimit();
    const result = await handler({ httpMethod: "GET", env: { TICKETS_API_KEY: "k" }, queryStringParameters: { fresh: "1", status: "SOLVED", market: "2" } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(conditions(net.urls[0]), ["f:status|is|SOLVED", "market|is|2"]);
  } finally { net.restore(); }
});
