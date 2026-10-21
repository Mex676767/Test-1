import assert from "node:assert/strict";
import test from "node:test";
import { handler, collectAgents } from "./ticket-agents.js";
import { handler as listHandler } from "./ticket-list.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const author = { accountKey: "lc1", agentToken: "tok-alice" };
const person = (id, name, email = `${name.toLowerCase()}@x.com`) => ({ id, name, email });
const ticket = (n, raisedBy, assignees = []) => ({ ref: `TK${n}`, raisedBy, assignees, fields: {} });

function network({ pages, total }) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return Response.json(TOKENS[String(options.headers.Authorization).replace("Bearer ", "")]);
    const parsed = new URL(url);
    urls.push(parsed);
    const page = Number(parsed.searchParams.get("page") || 1);
    return Response.json({ ok: true, total: total ?? pages.flat().length, tickets: pages[page - 1] || [] });
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}
const call = (input = {}, env = onEnv) => { initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); resetTicketReadCache(); resetTicketRateLimit(); return handler({ httpMethod: "POST", env, body: JSON.stringify({ fresh: true, author, ...input }) }); };

test("collectAgents: everyone who raised or is assigned, once each, by name, without emails", () => {
  const out = collectAgents([ticket(1, person(2, "Bob"), [person(1, "Ann")]), ticket(2, person(1, "Ann"), [person(3, "Cara"), person(2, "Bob")]), ticket(3, null, [{ id: 0, name: "Nobody" }, { id: 9, name: "" }])]);
  assert.deepEqual(out, [{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }, { id: 3, name: "Cara" }]);
});

test("the roster is read from the newest tickets as the signed-in agent, 250 at a time, and says how many were looked at", async () => {
  const page1 = Array.from({ length: 250 }, (_, i) => ticket(i, person(1 + (i % 3), ["Ann", "Bob", "Cara"][i % 3])));
  const page2 = [ticket(900, person(7, "Dan"), [person(8, "Eve")])];
  const net = network({ pages: [page1, page2] });
  try {
    const result = await call();
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.agents.map((a) => a.name), ["Ann", "Bob", "Cara", "Dan", "Eve"], 'the second page is read because the first was full');
    assert.deepEqual([body.scanned, body.total], [251, 251]);
    assert.equal(net.urls.length, 2);
    assert.deepEqual([net.urls[0].searchParams.get("pageSize"), net.urls[0].searchParams.get("page"), net.urls[0].searchParams.get("onBehalfOf")], ["250", "1", "alice@x.com"]);
    assert.equal(JSON.stringify(body).includes("@x.com"), false, "no email leaves the server");
  } finally { net.restore(); }
});

test("it stops after a short page, and never reads more than four pages", async () => {
  const short = network({ pages: [[ticket(1, person(1, "Ann"))]] });
  try {
    await call();
    assert.equal(short.urls.length, 1);
  } finally { short.restore(); }
  const full = Array.from({ length: 250 }, (_, i) => ticket(i, person(1, "Ann")));
  const many = network({ pages: [full, full, full, full, full, full], total: 5000 });
  try {
    await call();
    assert.equal(many.urls.length, 4);
  } finally { many.restore(); }
});

test("a refusal is shown as it is; a plain GET (admin preview) works without a login", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, error: "This API key is not allowed to read tickets" }, { status: 403 });
  try {
    initLiveChatEnv({});
    resetTicketReadCache(); resetTicketRateLimit();
    const refused = await handler({ httpMethod: "GET", env: { TICKETS_API_KEY: "k" }, queryStringParameters: { fresh: "1" } });
    assert.equal(refused.statusCode, 403);
  } finally { globalThis.fetch = original; }
  const net = network({ pages: [[ticket(1, person(5, "Zed"))]] });
  try {
    resetTicketReadCache(); resetTicketRateLimit();
    const ok = await handler({ httpMethod: "GET", env: { TICKETS_API_KEY: "k" }, queryStringParameters: { fresh: "1" } });
    assert.deepEqual(JSON.parse(ok.body).agents, [{ id: 5, name: "Zed" }]);
    assert.equal(net.urls[0].searchParams.get("onBehalfOf"), null);
    assert.equal((await handler({ httpMethod: "PUT", env: { TICKETS_API_KEY: "k" } })).statusCode, 405);
  } finally { net.restore(); }
});

test("the list can be asked for one agent by id: raised by or assigned to them, with the fallback to raised by", async () => {
  const original = globalThis.fetch;
  const urls = [];
  const replies = [Response.json({ ok: false, error: "Unknown filter condition" }, { status: 400 })];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return Response.json(TOKENS[String(options.headers.Authorization).replace("Bearer ", "")]);
    urls.push(new URL(url));
    return replies.shift() || Response.json({ ok: true, total: 1, tickets: [ticket(1, person(44, "Ann"))] });
  };
  try {
    initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
    resetTicketReadCache(); resetTicketRateLimit();
    const result = await listHandler({ httpMethod: "POST", env: onEnv, body: JSON.stringify({ fresh: true, author, agent: "44" }) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(urls[0].searchParams.getAll("c"), ["createdBy|is|44", "assignee|is|44"]);
    assert.equal(urls[0].searchParams.get("match"), "any");
    assert.deepEqual(urls[1].searchParams.getAll("c"), ["createdBy|is|44"], "the assignee condition was refused, so only raised by is asked");
    const bad = await listHandler({ httpMethod: "POST", env: onEnv, body: JSON.stringify({ fresh: true, author, agent: "44; drop" }) });
    assert.equal(bad.statusCode, 400);
  } finally { globalThis.fetch = original; }
});
