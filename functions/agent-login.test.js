import test from "node:test";
import assert from "node:assert/strict";
import { handler, parseBindings, bindingFor, availableNames, claimWinner } from "./agent-login.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base",
  LARK_TABLE_CUSTOMER_APPROACHING: "ca-table", LARK_TABLE_AGENT_LOGINS: "logins-table",
  LIVECHAT_CLIENT_ID: "client-1", LIVECHAT_CLIENT_ID_2: "client-2",
};
const NAMES = ["96 Edwin", "96 Mexha", "96 Teh"];
const row = (id, account, login, name, lockedAt = 1000) => ({ record_id: id, fields: { "LiveChat Account": account, "LiveChat Login": login, "Agent Name": name, "Locked At": lockedAt } });

// A tiny fake of LiveChat's token info and the Lark table. `table` is the live list of rows; `onCreate` lets a test slip another
// agent's row in at the moment of creation to simulate a race.
function world({ table = [], tokens = {}, onCreate } = {}) {
  const log = { created: [], deleted: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) {
      const info = tokens[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? { ok: true, json: async () => info } : { ok: false, json: async () => ({ error: "invalid_token" }) };
    }
    if (url.includes("/tables/ca-table/fields")) {
      return { json: async () => ({ code: 0, data: { items: [{ field_name: "Agent Name", property: { options: NAMES.map((name) => ({ name })) } }] } }) };
    }
    if (url.includes("/tables/logins-table/records/") && options.method === "DELETE") {
      const id = url.split("/").pop();
      log.deleted.push(id);
      const i = table.findIndex((r) => r.record_id === id);
      if (i >= 0) table.splice(i, 1);
      return { json: async () => ({ code: 0, data: {} }) };
    }
    if (url.includes("/tables/logins-table/records") && options.method === "POST") {
      const fields = JSON.parse(options.body).fields;
      const created = { record_id: "rec-new-" + (log.created.length + 1), fields };
      log.created.push(fields);
      if (onCreate) onCreate(table);
      table.push(created);
      return { json: async () => ({ code: 0, data: { record: created } }) };
    }
    if (url.includes("/tables/logins-table/records")) return { json: async () => ({ code: 0, data: { items: table } }) };
    throw new Error("unexpected " + url);
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({});
  const res = await handler({ body: JSON.stringify(body), env });
  return JSON.parse(res.body);
};
const alice = { tokens: { "tok-alice": { account_id: "alice@x.com", client_id: "client-1" } } };

test("helpers: blank and half-filled rows are ignored; a name is unique per account, not overall", () => {
  const rows = parseBindings([row("r1", "lc1", "a@x", "96 Edwin"), { record_id: "r2", fields: {} }, row("r3", "lc1", "", "96 Teh"), row("r4", "lc2", "b@x", "96 Edwin")]);
  assert.deepEqual(rows.map((r) => r.recordId), ["r1", "r4"]);
  assert.deepEqual(availableNames(NAMES, rows, "lc1"), ["96 Mexha", "96 Teh"]);
  assert.deepEqual(availableNames(NAMES, rows, "lc2"), ["96 Mexha", "96 Teh"]);
  assert.deepEqual(availableNames(NAMES, [], "lc1"), NAMES);
  assert.equal(bindingFor(rows, "lc2", "b@x").name, "96 Edwin");
  assert.equal(bindingFor(rows, "lc1", "b@x"), null);
  assert.equal(claimWinner(rows, "lc1", "96 EDWIN").recordId, "r1", "case-insensitive");
});

test("first login: nothing is stored, and only names free on this account are offered", async (t) => {
  const w = world({ ...alice, table: [row("r1", "lc1", "bob@x.com", "96 Edwin")] });
  t.after(w.restore);
  const out = await call({ accountKey: "lc1", agentToken: "tok-alice" });
  assert.equal(out.ok, true);
  assert.equal(out.bound, false);
  assert.deepEqual(out.available, ["96 Mexha", "96 Teh"]);
  assert.equal(w.log.created.length, 0);
});

test("the same name can be taken once on each LiveChat account", async (t) => {
  const w = world({ tokens: { "tok-alice2": { account_id: "alice@x.com", client_id: "client-2" } }, table: [row("r1", "lc1", "bob@x.com", "96 Edwin")] });
  t.after(w.restore);
  const out = await call({ accountKey: "lc2", agentToken: "tok-alice2", name: "96 Edwin" });
  assert.equal(out.ok, true);
  assert.equal(out.name, "96 Edwin");
  assert.deepEqual(w.log.created[0], { "LiveChat Account": "lc2", "LiveChat Login": "alice@x.com", "Agent Name": "96 Edwin", "Locked At": w.log.created[0]["Locked At"] });
  assert.ok(w.log.created[0]["Locked At"] > 0);
});

test("choosing a name locks it: the next login gets it back without a choice, and cannot pick another", async (t) => {
  const w = world(alice);
  t.after(w.restore);
  assert.equal((await call({ accountKey: "lc1", agentToken: "tok-alice", name: "96 Teh" })).name, "96 Teh");
  const again = await call({ accountKey: "lc1", agentToken: "tok-alice" });
  assert.equal(again.bound, true);
  assert.equal(again.name, "96 Teh");
  const tryOther = await call({ accountKey: "lc1", agentToken: "tok-alice", name: "96 Mexha" });
  assert.equal(tryOther.name, "96 Teh", "a bound login always gets its own name back");
  assert.equal(w.log.created.length, 1, "only one row was ever written");
});

test("a name another login already holds on this account is refused", async (t) => {
  const w = world({ ...alice, table: [row("r1", "lc1", "bob@x.com", "96 Teh")] });
  t.after(w.restore);
  const out = await call({ accountKey: "lc1", agentToken: "tok-alice", name: "96 Teh" });
  assert.equal(out.ok, false);
  assert.equal(out.taken, true);
  assert.deepEqual(out.available, ["96 Edwin", "96 Mexha"]);
  assert.equal(w.log.created.length, 0);
});

test("a simultaneous claim: the earlier row wins and the later one removes its own row", async (t) => {
  // Bob's row lands (earlier) between Alice's check and her create.
  const w = world({ ...alice, onCreate: (table) => table.push(row("r-bob", "lc1", "bob@x.com", "96 Teh", 5)) });
  t.after(w.restore);
  const out = await call({ accountKey: "lc1", agentToken: "tok-alice", name: "96 Teh" });
  assert.equal(out.ok, false);
  assert.equal(out.taken, true);
  assert.deepEqual(w.log.deleted, ["rec-new-1"], "only her own row is deleted, never Bob's");
});

test("a double click by the same login keeps one row and still succeeds", async (t) => {
  const w = world({ ...alice, onCreate: (table) => table.push(row("r-earlier", "lc1", "alice@x.com", "96 Teh", 5)) });
  t.after(w.restore);
  const out = await call({ accountKey: "lc1", agentToken: "tok-alice", name: "96 Teh" });
  assert.equal(out.ok, true);
  assert.equal(out.name, "96 Teh");
  assert.deepEqual(w.log.deleted, ["rec-new-1"]);
});

test("rejects a bad token, another account's token, an unknown name and a missing table setting", async (t) => {
  const w = world({ tokens: { ...alice.tokens, "tok-wrong-client": { account_id: "eve@x.com", client_id: "client-2" } } });
  t.after(w.restore);
  assert.equal((await call({ accountKey: "lc1", agentToken: "nope" })).loginExpired, true);
  assert.equal((await call({ accountKey: "lc1", agentToken: "tok-wrong-client" })).loginExpired, true, "an lc2 token presented as lc1");
  assert.match((await call({ accountKey: "lc1", agentToken: "tok-alice", name: "Somebody Else" })).error, /not an agent name/);
  assert.equal((await call({ accountKey: "lc3", agentToken: "tok-alice" })).ok, false);
  assert.equal((await call({ accountKey: "lc1", agentToken: "" })).ok, false);
  const noTable = await call({ accountKey: "lc1", agentToken: "tok-alice" }, { ...ENV, LARK_TABLE_AGENT_LOGINS: "" });
  assert.equal(noTable.notConfigured, true);
  assert.equal(w.log.created.length, 0);
});

// ---- the Livechat Email column: filled in once per login, never blocking a login ----------------------
// (a login id of its own per test: the server remembers the email it found for a login for an hour)
function emailWorld(t, { table = [], email = "Alice@X.com", fail = false, uuid = "uuid-email-0" } = {}) {
  const log = { updated: [], created: [], accountCalls: 0 };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) return { ok: true, json: async () => ({ account_id: uuid, client_id: "client-1" }) };
    if (url.includes("accounts.livechat.com/v2/accounts/")) {
      log.accountCalls += 1;
      return fail ? { ok: false, json: async () => ({ error: { message: "missing scope" } }) } : { ok: true, json: async () => ({ email }) };
    }
    if (url.includes("/tables/ca-table/fields")) return { json: async () => ({ code: 0, data: { items: [{ field_name: "Agent Name", property: { options: NAMES.map((name) => ({ name })) } }] } }) };
    if (url.includes("/tables/logins-table/records/") && options.method === "PUT") {
      log.updated.push({ id: url.split("/").pop(), fields: JSON.parse(options.body).fields });
      return { json: async () => ({ code: 0, data: { record: {} } }) };
    }
    if (url.includes("/tables/logins-table/records") && options.method === "POST") {
      const fields = JSON.parse(options.body).fields;
      log.created.push(fields);
      const created = { record_id: "rec-new", fields };
      table.push(created);
      return { json: async () => ({ code: 0, data: { record: created } }) };
    }
    if (url.includes("/tables/logins-table/records")) return { json: async () => ({ code: 0, data: { items: table } }) };
    throw new Error("unexpected " + url);
  };
  return log;
}
const emailRow = (id, login, email) => ({ record_id: id, fields: { "LiveChat Account": "lc1", "LiveChat Login": login, "Agent Name": "96 Teh", "Locked At": 1000, ...(email ? { "Livechat Email": email } : {}) } });
const call2 = async (body) => { initLarkEnv(ENV); initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); return JSON.parse((await handler({ body: JSON.stringify(body), env: ENV })).body); };

test("a login seen before the email column existed gets its email filled in, in lower case, once", async (t) => {
  const log = emailWorld(t, { table: [emailRow("r1", "uuid-email-0")], email: "Alice@X.com" });
  const first = await call2({ accountKey: "lc1", agentToken: "tok" });
  assert.equal(first.name, "96 Teh");
  assert.deepEqual(log.updated, [{ id: "r1", fields: { "Livechat Email": "alice@x.com" } }]);
});

test("a login that already has its email is not looked up again", async (t) => {
  const log = emailWorld(t, { table: [emailRow("r1", "uuid-email-0", "alice@x.com")] });
  assert.equal((await call2({ accountKey: "lc1", agentToken: "tok" })).name, "96 Teh");
  assert.equal(log.accountCalls, 0);
  assert.deepEqual(log.updated, []);
});

test("a first-time claim stores the email in the new row", async (t) => {
  const log = emailWorld(t, { email: "Zed@X.com", uuid: "uuid-email-claim" });
  const out = await call2({ accountKey: "lc1", agentToken: "tok", name: "96 Mexha" });
  assert.equal(out.name, "96 Mexha");
  assert.equal(log.created[0]["Livechat Email"], "zed@x.com");
});

test("if LiveChat will not give the email, the login still works and the row is simply left without one", async (t) => {
  const log = emailWorld(t, { table: [emailRow("r1", "uuid-email-fail")], fail: true, uuid: "uuid-email-fail" });
  assert.equal((await call2({ accountKey: "lc1", agentToken: "tok" })).name, "96 Teh");
  assert.deepEqual(log.updated, []);
});

// ---- a known login is recognised from a shared copy of the table; anything else reads the table as it is now ----
test("a login already in the table is found from the shared copy (one read); a new login re-reads the table fresh", async (t) => {
  const reads = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const table = [{ record_id: "r1", fields: { "LiveChat Account": "lc1", "LiveChat Login": "uuid-known", "Agent Name": "96 Teh", "Locked At": 1000, "Livechat Email": "teh@x.com" } }];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) return { ok: true, json: async () => ({ account_id: options.headers.Authorization.includes("known") ? "uuid-known" : "uuid-new", client_id: "client-1" }) };
    if (url.includes("/tables/ca-table/fields")) return { json: async () => ({ code: 0, data: { items: [{ field_name: "Agent Name", property: { options: NAMES.map((name) => ({ name })) } }] } }) };
    if (url.includes("/tables/logins-table/records") && !options.method) { reads.push(url); return { json: async () => ({ code: 0, data: { items: table, has_more: false } }) }; }
    throw new Error("unexpected " + url);
  };
  const call3 = async (token) => { initLarkEnv(ENV); initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); return JSON.parse((await handler({ body: JSON.stringify({ accountKey: "lc1", agentToken: token }), env: ENV })).body); };
  const known = await call3("known-token");
  assert.equal(known.name, "96 Teh");
  assert.equal(reads.length, 1, "one read for a login that is already bound");
  const fresh = await call3("new-token");
  assert.equal(fresh.bound, false);
  assert.equal(reads.length, 3, "a login not in the shared copy: that read plus one fresh read of the table");
});
