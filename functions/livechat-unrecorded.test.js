import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./livechat-unrecorded.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_UNRECORDED: "unrec-table", LIVECHAT_CLIENT_ID: "client-1" };
const row = (id, email, thread, status, date = 1) => ({ record_id: id, fields: { "Thread ID": thread, "Chat ID": "C-" + thread, "Writer Email": email, Status: status, "Chat Date": date, Customer: "Zimito " + thread } });

// The fake Lark honours the "is" conditions of a search, so a test shows that only the signed-in agent's rows are touched.
function world({ rows, accounts, uuid = "uuid-1" }) {
  const log = { searches: [], updates: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) return String(options.headers.Authorization) === "Bearer tok" ? { ok: true, json: async () => ({ account_id: uuid, client_id: "client-1" }) } : { ok: false, json: async () => ({ error: "invalid" }) };
    if (url.includes("accounts.livechat.com/v2/accounts/")) return accounts ? accounts() : { ok: false, json: async () => ({ error: { message: "missing scope" } }) };
    if (url.includes("/tables/unrec-table/records/search")) {
      const conditions = JSON.parse(options.body).filter.conditions;
      log.searches.push(conditions);
      const items = rows.filter((r) => conditions.every((c) => c.value.includes(String(r.fields[c.field_name]).toLowerCase() === c.value[0] ? c.value[0] : r.fields[c.field_name])));
      return { json: async () => ({ code: 0, data: { items, has_more: false } }) };
    }
    if (url.includes("/tables/unrec-table/records/") && options.method === "PUT") {
      log.updates.push({ id: url.split("/").pop(), fields: JSON.parse(options.body).fields });
      return { json: async () => ({ code: 0, data: { record: {} } }) };
    }
    throw new Error("unexpected " + url);
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  return JSON.parse((await handler({ body: JSON.stringify(body), env })).body);
};
const emailOk = () => ({ ok: true, json: async () => ({ email: "Alice@X.com" }) });
const base = { accountKey: "lc1", agentToken: "tok" };
const rows = () => [
  row("r1", "alice@x.com", "T-LATE", "Open", 20), row("r2", "alice@x.com", "T-EARLY", "Open", 10),
  row("r3", "alice@x.com", "T-DONE", "Done", 5), row("r4", "bob@x.com", "T-BOB", "Open", 7),
];

test("list: only the signed-in agent's Open chats, oldest first, found by the email LiveChat gives for their login", async (t) => {
  const w = world({ rows: rows(), accounts: emailOk });
  t.after(w.restore);
  const out = await call({ ...base, action: "list" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chats.map((c) => c.threadId), ["T-EARLY", "T-LATE"]);
  assert.deepEqual(out.chats[0], { threadId: "T-EARLY", chatId: "C-T-EARLY", date: 10, customer: "Zimito T-EARLY" });
  assert.deepEqual(w.log.searches[0].map((c) => [c.field_name, c.value[0]]), [["Writer Email", "alice@x.com"], ["Status", "Open"]]);
});

test("resolve: marks only this agent's rows for that chat, as Done or Ignored", async (t) => {
  const w = world({ rows: rows(), accounts: emailOk });
  t.after(w.restore);
  assert.equal((await call({ ...base, action: "resolve", threadId: "T-LATE", status: "Ignored" })).updated, 1);
  assert.deepEqual(w.log.updates, [{ id: "r1", fields: { Status: "Ignored" } }]);
  await call({ ...base, action: "resolve", threadId: "T-EARLY", status: "anything else" });
  assert.deepEqual(w.log.updates[1], { id: "r2", fields: { Status: "Done" } });
});

test("another agent's chat cannot be resolved by this agent", async (t) => {
  const w = world({ rows: rows(), accounts: emailOk });
  t.after(w.restore);
  assert.equal((await call({ ...base, action: "resolve", threadId: "T-BOB", status: "Ignored" })).updated, 0);
  assert.deepEqual(w.log.updates, []);
});

test("refuses a bad login, bad details and a thread id that is not a plain id; reports a missing email and a missing table", async (t) => {
  // (a login id of its own: the server remembers the email it found for a login for an hour)
  const w = world({ rows: rows(), uuid: "uuid-without-email" });
  t.after(w.restore);
  assert.equal((await call({ accountKey: "lc1", agentToken: "nope", action: "list" })).loginExpired, true);
  assert.equal((await call({ accountKey: "lc9", agentToken: "tok", action: "list" })).ok, false);
  assert.equal((await call({ accountKey: "lc1", agentToken: "", action: "list" })).ok, false);
  const noEmail = await call({ ...base, action: "list" });
  assert.equal(noEmail.ok, false);
  assert.match(noEmail.error, /Could not read your LiveChat email/);
  assert.equal((await call({ ...base, action: "list" }, { ...ENV, LARK_TABLE_UNRECORDED: "" })).notConfigured, true);
  assert.equal(w.log.updates.length, 0);
});

test("resolve rejects a thread id with odd characters before touching Lark", async (t) => {
  const w = world({ rows: rows(), accounts: emailOk });
  t.after(w.restore);
  const out = await call({ ...base, action: "resolve", threadId: "x'] OR 1=1" });
  assert.equal(out.ok, false);
  assert.equal(w.log.searches.length, 0);
});
