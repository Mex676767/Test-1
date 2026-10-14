import assert from "node:assert/strict";
import test from "node:test";
import { TICKET_CATALOG } from "./_lib/ticket-catalog.js";
import { ticketError, ticketGet, ticketRequest, resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";
import { handler as configHandler, resetTicketConfigCache } from "./ticket-config.js";
import { handler as listHandler } from "./ticket-list.js";
import { handler as statusHandler } from "./ticket-status.js";

const env = { TICKETS_API_KEY: "test_ticket_key" };
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const withFetch = async (impl, run) => { const original = globalThis.fetch; globalThis.fetch = impl; try { return await run(); } finally { globalThis.fetch = original; } };
const reset = () => { resetTicketConfigCache(); resetTicketRateLimit(); resetTicketReadCache(); };

// ---- the catalog --------------------------------------------------------------------------------
test("the catalog holds every list the ticket system's docs page shows, with no repeats", () => {
  const counts = Object.fromEntries(Object.entries(TICKET_CATALOG).map(([key, items]) => [key, items.length]));
  assert.deepEqual(counts, { toDepartment: 20, market: 9, query_type: 29, status: 13, member_platform: 76, payment_gateway: 68, member_level: 20 });
  for (const [key, items] of Object.entries(TICKET_CATALOG)) {
    const values = items.map((item) => item.value.toLowerCase());
    assert.equal(new Set(values).size, values.length, `${key} has no repeated value`);
    assert.ok(items.every((item) => item.label && item.value), `${key} entries all have a label and a value`);
  }
  assert.deepEqual(TICKET_CATALOG.query_type.find((item) => item.value === "vvip_ltv_70_bonus"), { label: "VVIP LTV 70 BONUS", value: "vvip_ltv_70_bonus" });
});

function configWorld(apiFields, tickets) {
  return async () => reply({ ok: true, fields: apiFields, tickets });
}
const call = async () => JSON.parse((await configHandler({ httpMethod: "GET", env, queryStringParameters: { fresh: "1" } })).body);

test("config: a value seen on a ticket but missing from the catalog is still offered; a catalog value is not repeated", async () => {
  reset();
  await withFetch(configWorld(
    [{ key: "payment_gateway", label: "Payment Gateway", type: "SELECT", isActive: true }, { key: "remarks", label: "Remarks", type: "LONGTEXT", isActive: true }],
    [{ ref: "TK1", fields: { payment_gateway: "BRANDNEWPAY" } }, { ref: "TK2", fields: { payment_gateway: "KAAZPAY" } }, { ref: "TK3", fields: { payment_gateway: "kaazpay" } }],
  ), async () => {
    const body = await call();
    const gateway = body.fields.find((field) => field.key === "payment_gateway");
    assert.equal(gateway.options.length, 69, "68 from the catalog plus the new one");
    assert.deepEqual(gateway.options.at(-1), { value: "BRANDNEWPAY", label: "BRANDNEWPAY", isActive: true });
    assert.equal(gateway.options.filter((option) => option.value.toLowerCase() === "kaazpay").length, 1);
    assert.equal("options" in body.fields.find((field) => field.key === "remarks"), false, "text fields get no options");
  });
});

test("config: choices the API itself starts to list win, and a field the catalog does not know falls back to what tickets carry", async () => {
  reset();
  await withFetch(configWorld(
    [{ key: "status", type: "SELECT", isActive: true, options: [{ value: "OPEN", label: "Open now" }, { value: "OLD", label: "Old", isActive: false }] },
      { key: "custom_pick", type: "SELECT", isActive: true }],
    [{ ref: "TK1", fields: { custom_pick: "b" } }, { ref: "TK2", fields: { custom_pick: "a" } }],
  ), async () => {
    const body = await call();
    const status = body.fields.find((field) => field.key === "status");
    assert.deepEqual(status.options[0], { value: "OPEN", label: "Open now", isActive: true });
    assert.deepEqual(status.options[1], { value: "OLD", label: "Old", isActive: false });
    assert.equal(status.options.length, 2 + 12, "the API's two, then the catalog's other twelve (its Open is the API's OPEN)");
    assert.deepEqual(body.fields.find((field) => field.key === "custom_pick").options.map((option) => option.value), ["a", "b"]);
  });
});

test("config: an unseen department or market from tickets is added; ids come from tickets, else the code stands in", async () => {
  reset();
  await withFetch(configWorld([], [{ ref: "TK1", currentDepartment: { id: 99, code: "NEWDEPT", name: "New Department" }, raisedByDepartment: { id: 8, code: "CS", name: "Customer Service" }, market: { id: 77, code: "ZZZ", label: "Zedland", currency: "ZZD", isActive: true }, fields: {} }]), async () => {
    const body = await call();
    assert.deepEqual(body.departments.find((item) => item.code === "NEWDEPT"), { id: 99, code: "NEWDEPT", name: "New Department" });
    assert.equal(body.departments.find((item) => item.code === "CS").id, 8);
    assert.equal(body.departments.find((item) => item.code === "IA").id, "IA");
    assert.deepEqual(body.markets.find((item) => item.code === "ZZZ"), { id: 77, code: "ZZZ", label: "Zedland", currency: "ZZD" });
    assert.equal(body.markets.length, 10);
  });
});

// ---- the rate limit and the read cache ------------------------------------------------------------
test("a 429 stops this isolate calling for Retry-After seconds, and the agent is told when to try again", async () => {
  reset();
  let upstream = 0;
  await withFetch(async () => { upstream += 1; return reply({ ok: false, error: "Rate limit exceeded" }, 429, { "Retry-After": "23" }); }, async () => {
    await assert.rejects(ticketRequest(env, "/tickets"), (error) => { assert.equal(error.statusCode, 429); assert.equal(error.retryAfter, 23); return true; });
    assert.equal(upstream, 1);
    const second = await listHandler({ httpMethod: "GET", env, queryStringParameters: {} });
    assert.equal(upstream, 1, "no second call while the limit is on");
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /busy .* Try again in \d+ s/);
    assert.ok(Number(second.headers["Retry-After"]) >= 1 && Number(second.headers["Retry-After"]) <= 23);
  });
  resetTicketRateLimit();
  await withFetch(async () => reply({ ok: true, tickets: [] }), async () => {
    assert.equal((await listHandler({ httpMethod: "GET", env, queryStringParameters: {} })).statusCode, 200);
  });
});

test("a 429 without Retry-After uses a short default; the error helper carries the header only when there is one", async () => {
  reset();
  await withFetch(async () => reply({ ok: false }, 429), async () => {
    await assert.rejects(ticketRequest(env, "/tickets"), (error) => { assert.equal(error.retryAfter, 20); return true; });
  });
  assert.equal(ticketError(new Error("plain")).headers, undefined);
  reset();
});

test("repeated reads are shared: one upstream call for many agents, fresh=1 skips the stored copy, errors are never stored", async () => {
  reset();
  let upstream = 0;
  const ticket = { ref: "TK2610140001", fields: { status: "OPEN" } };
  await withFetch(async () => { upstream += 1; return reply({ ok: true, ticket }); }, async () => {
    const read = (fresh) => statusHandler({ httpMethod: "GET", env, queryStringParameters: { ref: "TK2610140001", ...(fresh ? { fresh: "1" } : {}) } });
    await Promise.all([read(), read(), read(), read()]);
    assert.equal(upstream, 1, "four agents at once, one call");
    await read();
    assert.equal(upstream, 1, "the next read is served from the copy");
    await read(true);
    assert.equal(upstream, 2, "Refresh skips the copy");
  });
  reset();
  let attempts = 0;
  await withFetch(async () => { attempts += 1; return attempts === 1 ? reply({ ok: false, error: "boom" }, 500) : reply({ ok: true, ticket }); }, async () => {
    await assert.rejects(ticketGet(env, "/tickets/X", { ttlMs: 10_000 }));
    await ticketGet(env, "/tickets/X", { ttlMs: 10_000 });
    assert.equal(attempts, 2, "the failure was not kept");
  });
  reset();
});

test("the inbox list is cached per search, so different searches are different reads", async () => {
  reset();
  const urls = [];
  await withFetch(async (url) => { urls.push(String(url)); return reply({ ok: true, tickets: [] }); }, async () => {
    const list = (q) => listHandler({ httpMethod: "GET", env, queryStringParameters: q ? { q } : {} });
    await list(); await list(); await list("mexha"); await list("mexha");
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes("q=mexha"));
  });
  reset();
});
