import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { chatAccessFor } from "./_lib/chat-access.js";
import { initEnv } from "./_lib/lark.js";
import { initEnv as initLiveChat } from "./_lib/livechat.js";

test("supervisors and viewers are read-only; the assigned agent can look up before sending a message", () => {
  const chat = (user, active = true) => ({ users: [{ id: "customer", type: "customer" }, ...(user ? [{ id: "agent@example.com", type: "agent", ...user }] : [])], thread: { active, events: [{ type: "message", author_id: "customer", visibility: "all" }] } });
  for (const user of [{ visibility: "agents", present: true }, { visibility: "all", present: false }, {}, null]) {
    assert.equal(chatAccessFor(chat(user), ["AGENT@EXAMPLE.COM"]).readOnly, true);
  }
  assert.equal(chatAccessFor(chat({ visibility: "all", present: true }), ["agent@example.com"]).readOnly, false);
  assert.equal(chatAccessFor(chat({ visibility: "all", present: false }, false), ["agent@example.com"]).readOnly, false, "an archived chat handled by this agent remains recordable");
});

function world(t, { visibility = "agents", missing = false, unavailable = false, wrongThread = false, events = [{ type: "message", author_id: "customer", visibility: "all" }] } = {}) {
  initEnv({ LARK_APP_ID: "app", LARK_APP_SECRET: "test-secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_CUSTOMER_APPROACHING: "cases", LARK_TABLE_PNL: "pnl", LARK_TABLE_REDEEM_CODE: "redeem" });
  initLiveChat({ LIVECHAT_PAT: "test-pat" });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const writes = [], roleCalls = [];
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) return response({ account_id: "guide@example.com", client_id: "client" });
    if (url.endsWith("/get_chat")) {
      roleCalls.push(JSON.parse(options.body));
      if (unavailable) return response({ error: { message: "Unavailable" } }, 503);
      return response({ users: [{ id: "customer", type: "customer" }, ...(missing ? [] : [{ id: "guide@example.com", type: "agent", visibility, present: true }])], thread: { id: wrongThread ? "OTHER" : "THREAD", active: true, events } });
    }
    if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "test-token", expire: 3600 });
    if (url.includes("/fields?")) return response({ code: 0, data: { items: [] } });
    if (url.includes("/records/search")) {
      const items = url.includes("/tables/pnl/") ? [{ record_id: "recPlayer123", fields: { Username: "player", Brand: "JOM", Tier: "Tier 3", "Title name": "Test Player" } }] : [];
      return response({ code: 0, data: { items } });
    }
    writes.push({ url, method: options.method, body: options.body });
    return response({ code: 0, data: { record: { record_id: "recCreated123" } } });
  };
  return { writes, roleCalls };
}
async function lookup(extra = {}) {
  const result = await handler({ env: { LIVECHAT_CLIENT_ID: "client" }, body: JSON.stringify({ username: "player", brand: "JOM", picName: "Guide", link: "https://my.livechatinc.com/chats/CHAT/THREAD", chatAccess: { accountKey: "lc1", agentToken: "token" }, ...extra }) });
  assert.equal(result.statusCode, 200, result.body);
  return JSON.parse(result.body);
}
for (const [label, options] of [["supervisor", {}], ["viewer", { missing: true }], ["LiveChat unavailable", { unavailable: true }], ["wrong thread", { wrongThread: true }]]) {
  test(`${label}: returns player details with no create, update or delete, even with a previous record`, async (t) => {
    const w = world(t, options);
    const result = await lookup({ previousRecordId: "recPrevious123" });
    assert.equal(result.readOnly, true);
    assert.equal(result.justCreated, false);
    assert.equal(result.caRecordId, null);
    assert.equal(result.row.customerName, "Test Player");
    assert.equal(result.caseRowError, undefined);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.roleCalls, [{ chat_id: "CHAT", thread_id: "THREAD" }]);
  });
}
test("the handling agent gets a normal case row; chat role is checked again after takeover", async (t) => {
  const w = world(t, { visibility: "all" });
  const result = await lookup();
  assert.equal(result.readOnly, false);
  assert.equal(result.caRecordId, "recCreated123");
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].method, "POST");
  await lookup();
  assert.equal(w.roleCalls.length, 2, "role checks are not cached across lookups");
});
test("missing login or chat link safely returns read-only results", async (t) => {
  const w = world(t);
  for (const extra of [{ chatAccess: {} }, { link: "" }]) assert.equal((await lookup(extra)).readOnly, true);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.roleCalls, []);
});

test("an unanswered blast is read-only with no row writes, then a fresh lookup after the customer's reply creates the case", async (t) => {
  const events = [{ type: "message", author_id: "guide@example.com", visibility: "all", text: "Blast" }];
  const w = world(t, { visibility: "all", events });
  const first = await lookup({ previousRecordId: "recPrevious123" });
  assert.equal(first.readOnly, true);
  assert.match(first.readOnlyReason, /customer has not replied/);
  assert.equal(first.justCreated, false);
  assert.equal(first.caRecordId, null);
  assert.equal(first.row.customerName, "Test Player");
  assert.deepEqual(w.writes, [], "no create, update or previous-record deletion");
  events.push({ type: "message", author_id: "customer", visibility: "all", text: "Hi" });
  const second = await lookup();
  assert.equal(second.readOnly, false);
  assert.equal(second.caRecordId, "recCreated123");
  assert.equal(w.writes.length, 1);
});

test("only a customer reply in the requested thread unlocks a handling agent's lookup", () => {
  const users = [{ id: "agent", type: "agent", visibility: "all", present: true }, { id: "customer", type: "customer" }];
  const access = (events) => chatAccessFor({ users, thread: { active: true, events }, threads: [{ events: [{ type: "message", author_id: "customer" }] }] }, ["agent"]);
  for (const events of [[], undefined, [{ type: "message", author_id: "agent" }], [{ type: "system_message", author_id: "customer" }], [{ type: "filled_form", author_id: "customer" }], [{ type: "message", author_id: "customer", visibility: "agents" }]]) {
    assert.equal(access(events).readOnly, true);
  }
  for (const type of ["message", "file", "rich_message"]) assert.equal(access([{ type, author_id: "customer", visibility: "all" }]).readOnly, false);
});
