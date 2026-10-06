import assert from "node:assert/strict";
import test from "node:test";
import { ticketRequest, ticketError } from "./_lib/tickets.js";
import { handler as configHandler, resetTicketConfigCache } from "./ticket-config.js";

const env = { TICKETS_API_KEY: "test_ticket_key" };
const okBody = () => new Response(JSON.stringify({
  ok: true, fields: [{ key: "status", label: "Status", type: "TEXT", isActive: true }],
  tickets: [{ ref: "TK1", currentDepartment: { id: 2, code: "D", name: "Dept" }, market: { id: 4, code: "MYR", label: "Malaysia", isActive: true }, fields: {} }],
}), { status: 200, headers: { "Content-Type": "application/json" } });
const withFetch = async (impl, run) => { const o = globalThis.fetch; globalThis.fetch = impl; try { return await run(); } finally { globalThis.fetch = o; } };
const hang = (url, options = {}) => new Promise((resolve, reject) => {
  options.signal?.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
});

// ---- item 9: deadline ----------------------------------------------------------------------
test("a hung ticket service times out with a 504 instead of hanging the function", async () => {
  await withFetch(hang, async () => {
    const startedAt = Date.now();
    await assert.rejects(ticketRequest(env, "/tickets", { timeoutMs: 80 }), (error) => {
      assert.equal(error.statusCode, 504);
      assert.match(error.message, /did not answer/);
      assert.equal(JSON.parse(ticketError(error).body).ok, false);
      assert.equal(ticketError(error).statusCode, 504);
      return true;
    });
    assert.ok(Date.now() - startedAt < 2_000);
  });
});

test("a caller-provided signal still cancels the request and is not reported as a timeout", async () => {
  await withFetch(hang, async () => {
    const controller = new AbortController();
    const pending = ticketRequest(env, "/tickets", { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(new Error("caller gave up")), 30);
    await assert.rejects(pending, (error) => { assert.match(error.message, /caller gave up/); assert.notEqual(error.statusCode, 504); return true; });
  });
});

test("normal ticket requests still pass headers and body through (deadline is added, nothing else changes)", async () => {
  let seen;
  await withFetch(async (url, options) => { seen = options; return okBody(); }, async () => {
    const data = await ticketRequest(env, "/tickets", { method: "POST", body: JSON.stringify({ a: 1 }) });
    assert.equal(data.ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers.Authorization, "Bearer test_ticket_key");
    assert.equal(seen.headers["Content-Type"], "application/json");
    assert.ok(seen.signal instanceof AbortSignal);
    assert.equal("timeoutMs" in seen, false, "the timeout option is not forwarded to fetch");
  });
});

// ---- item 10: config cache ---------------------------------------------------------------------
test("ticket-config is served from a 5-minute per-isolate cache; ?fresh=1 bypasses it", async () => {
  resetTicketConfigCache();
  let upstream = 0;
  await withFetch(async () => { upstream++; return okBody(); }, async () => {
    const first = await configHandler({ httpMethod: "GET", env });
    const second = await configHandler({ httpMethod: "GET", env });
    assert.equal(upstream, 1, "second call came from the cache");
    assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
    await configHandler({ httpMethod: "GET", env, queryStringParameters: { fresh: "1" } });
    assert.equal(upstream, 2, "manual Refresh always re-reads");
    await configHandler({ httpMethod: "GET", env });
    assert.equal(upstream, 2, "and refreshes the cache for everyone");
  });
});

test("an error is never cached, and a different API key never sees another key's cached catalog", async () => {
  resetTicketConfigCache();
  let fail = true, upstream = 0;
  await withFetch(async () => { upstream++; return fail ? new Response("{}", { status: 500 }) : okBody(); }, async () => {
    const bad = await configHandler({ httpMethod: "GET", env });
    assert.equal(JSON.parse(bad.body).ok, false);
    fail = false;
    const good = await configHandler({ httpMethod: "GET", env });
    assert.equal(JSON.parse(good.body).ok, true, "the failure was not remembered");
    const other = await configHandler({ httpMethod: "GET", env: { TICKETS_API_KEY: "different_key" } });
    assert.equal(JSON.parse(other.body).ok, true);
    assert.equal(upstream, 3, "different key = its own request");
  });
});
