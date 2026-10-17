import assert from "node:assert/strict";
import test from "node:test";
import { handler as list } from "./ticket-list.js";
import { handler as status } from "./ticket-status.js";
import { handler as config, resetTicketConfigCache } from "./ticket-config.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

// Keys that act for others refuse any request that does not say whose behalf it is on: every read carries the signed-in agent's email.
const TOKENS = {
  "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" },
  "tok-bob": { account_id: "uuid-bob", email: "bob@x.com", client_id: "c1" },
};
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const alice = { accountKey: "lc1", agentToken: "tok-alice" };
const bob = { accountKey: "lc1", agentToken: "tok-bob" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function network({ refuse = false } = {}) {
  const original = globalThis.fetch;
  const ticketCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!url.includes("/api/v1/")) throw new Error(`unexpected ${url}`);
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api/v1", "");
    ticketCalls.push({ path, onBehalfOf: parsed.searchParams.get("onBehalfOf") });
    if (!parsed.searchParams.get("onBehalfOf")) return reply({ ok: false, error: 'This API key acts for the person named in each request: send "onBehalfOf" with their email address.' }, 400);
    if (refuse) return reply({ ok: false, error: `No active account has the email "${parsed.searchParams.get("onBehalfOf")}", so nothing can be done on their behalf.` }, 400);
    if (path === "/markets") return reply({ ok: true, markets: [{ id: 1, code: "MYR", label: "Malaysia" }] });
    if (path === "/departments") return reply({ ok: true, departments: [{ id: 1, code: "CS", name: "Customer Service" }] });
    if (path === "/fields/choices") return reply({ ok: true, fields: [] });
    if (path === "/tickets") return reply({ ok: true, total: 1, tickets: [{ ref: "TK2610170001", fields: {} }], fields: [{ key: "remarks", type: "TEXT" }] });
    return reply({ ok: true, ticket: { ref: "TK2610170001", fields: {}, comments: [] } });
  };
  return { ticketCalls, restore: () => { globalThis.fetch = original; } };
}
const fresh = () => { resetTicketReadCache(); resetTicketConfigCache(); resetTicketRateLimit(); initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); };
const post = (handler, body, env = onEnv) => handler({ httpMethod: "POST", env, body: JSON.stringify(body) }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test("the inbox and a ticket are read as the signed-in agent, and each person's read is kept on its own", async () => {
  fresh();
  const net = network();
  try {
    assert.equal((await post(list, { q: "", author: alice })).body.tickets.length, 1);
    assert.equal((await post(status, { ref: "TK2610170001", author: alice })).body.ticket.ref, "TK2610170001");
    await post(list, { q: "", author: bob });
    assert.deepEqual(net.ticketCalls.map((c) => [c.path, c.onBehalfOf]), [["/tickets", "alice@x.com"], ["/tickets/TK2610170001", "alice@x.com"], ["/tickets", "bob@x.com"]]);
    await post(list, { q: "", author: alice });
    assert.equal(net.ticketCalls.length, 3, "the same person's repeat read comes from their own copy");
  } finally { net.restore(); }
});

test("the field lists and departments are read as the agent too, so New ticket has what it needs", async () => {
  fresh();
  const net = network();
  try {
    const result = await post(config, { author: alice });
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.catalogSource, { departments: "live", markets: "live", choices: "snapshot" });
    assert.deepEqual([...new Set(net.ticketCalls.map((c) => c.onBehalfOf))], ["alice@x.com"]);
    assert.deepEqual(net.ticketCalls.map((c) => c.path).sort(), ["/departments", "/fields", "/fields/choices", "/markets", "/tickets"], "this fake has no real form, so the ticket list is read as before");
  } finally { net.restore(); }
});

test("signed out, or with no account for the email: no read is made as nobody, and the popup asks for the email", async () => {
  fresh();
  const net = network();
  try {
    assert.equal((await post(list, { q: "" })).status, 401);
    assert.equal((await post(status, { ref: "TK2610170001", author: { accountKey: "lc1", agentToken: "tok-gone" } })).status, 401);
    assert.equal(net.ticketCalls.length, 0);
  } finally { net.restore(); }
  fresh();
  const refusing = network({ refuse: true });
  try {
    const result = await post(list, { q: "", author: alice });
    assert.equal(result.status, 400);
    assert.equal(result.body.needTicketEmail, true);
    assert.equal(result.body.triedEmail, "alice@x.com");
  } finally { refusing.restore(); }
});

test("with acting on behalf switched off the reads are the plain calls, as before", async () => {
  fresh();
  const net = network();
  try {
    const off = { TICKETS_API_KEY: "k" };
    const result = await list({ httpMethod: "GET", env: off, queryStringParameters: {} });
    assert.equal(result.statusCode, 400, "this fake key insists on onBehalfOf; the point is that none was added");
    assert.equal(net.ticketCalls[0].onBehalfOf, null);
  } finally { net.restore(); }
});

test("the ticket form itself (GET /fields) is read instead of 100 tickets when the ticket system serves it", async () => {
  fresh();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return Response.json(TOKENS[String(options.headers.Authorization).replace("Bearer ", "")]);
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api/v1", "");
    calls.push(path);
    if (path === "/fields") return reply({ ok: true, fields: [
      { key: "status", label: "Status", type: "SELECT", isActive: true, required: false, default: "OPEN", postable: true, choices: [{ value: "OPEN", label: "Open" }] },
      { key: "member_id", label: "Member / User ID", type: "TEXT", isActive: true, required: true, default: null, postable: true, limits: { maxLength: 100 } },
    ] });
    if (path === "/markets") return reply({ ok: true, markets: [] });
    if (path === "/departments") return reply({ ok: true, departments: [] });
    if (path === "/fields/choices") return reply({ ok: true, fields: [] });
    throw new Error(`unexpected ${path}`);
  };
  try {
    const result = await post(config, { author: alice });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.formSource, "live");
    assert.deepEqual(result.body.fields.map((field) => field.key), ["status", "member_id"]);
    assert.equal(result.body.fields[1].required, true);
    assert.deepEqual(result.body.fields[0].options.map((option) => option.value).slice(0, 1), ["OPEN"]);
    assert.equal(calls.includes("/tickets"), false, "no ticket list is read");
  } finally { globalThis.fetch = original; }
});
