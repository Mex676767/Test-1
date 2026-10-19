import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./agent-market.js";
import { parseMarketRows, pickDefaultMarket, looksLikeMarketCode } from "./_lib/default-market.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base",
  LARK_TABLE_AGENT_LOGINS: "logins-table", LIVECHAT_CLIENT_ID: "client-1", LIVECHAT_CLIENT_ID_2: "client-2",
};
const row = (id, account, login, name, market) => ({ record_id: id, fields: { "LiveChat Account": account, "LiveChat Login": login, "Agent Name": name, ...(market ? { "Default Market": market } : {}) } });

// A tiny fake of LiveChat's token info and the Lark Agent Logins table. Updates are applied to `table` and logged.
function world({ table = [], tokens = {}, failUpdate = false } = {}) {
  const log = { updates: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) {
      const info = tokens[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? { ok: true, json: async () => info } : { ok: false, json: async () => ({ error: "invalid_token" }) };
    }
    if (url.includes("/tables/logins-table/records/") && options.method === "PUT") {
      if (failUpdate) return { json: async () => ({ code: 1254045, msg: "FieldNameNotFound" }) };
      const id = url.split("/").pop();
      const fields = JSON.parse(options.body).fields;
      log.updates.push({ id, fields });
      Object.assign(table.find((r) => r.record_id === id).fields, fields);
      return { json: async () => ({ code: 0, data: { record: { record_id: id, fields } } }) };
    }
    if (url.includes("/tables/logins-table/records")) return { json: async () => ({ code: 0, data: { items: table } }) };
    throw new Error("unexpected " + url);
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({});
  const res = await handler({ httpMethod: "POST", body: JSON.stringify(body), env });
  return JSON.parse(res.body);
};
const tokens = { "tok-alice": { account_id: "alice-uuid", client_id: "client-1" }, "tok-alice2": { account_id: "alice-uuid-2", client_id: "client-2" } };
const author = { accountKey: "lc1", agentToken: "tok-alice" };

test("helpers: the market code is upper-cased; a second login of the same agent shares it; blank rows are ignored", () => {
  const rows = parseMarketRows([row("r1", "lc1", "alice-uuid", "96 Alice", "myr"), row("r2", "lc2", "alice-uuid-2", "96 Alice"), row("r3", "lc1", "bob-uuid", "96 Bob"), { record_id: "r4", fields: {} }]);
  assert.equal(rows.length, 3);
  assert.equal(pickDefaultMarket(rows, "lc1", "alice-uuid"), "MYR");
  assert.equal(pickDefaultMarket(rows, "lc2", "alice-uuid-2"), "MYR", "the agent's other login has it too");
  assert.equal(pickDefaultMarket(rows, "lc1", "bob-uuid"), "");
  assert.equal(pickDefaultMarket(rows, "lc1", "nobody"), "");
  assert.equal(looksLikeMarketCode("MYR"), true);
  assert.equal(looksLikeMarketCode("M"), false);
  assert.equal(looksLikeMarketCode("<script>"), false);
});

test("reading: no market yet comes back empty; a saved one comes back", async (t) => {
  const w = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice")] });
  t.after(w.restore);
  assert.deepEqual(await call({ author }), { ok: true, market: "" });
  w.log.updates.length = 0;
  const w2 = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice", "IDR")] });
  t.after(w2.restore);
  assert.deepEqual(await call({ author }), { ok: true, market: "IDR" });
});

test("choosing once: saved on the agent's own row, upper-cased", async (t) => {
  const w = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice")] });
  t.after(w.restore);
  assert.deepEqual(await call({ author, market: "myr" }), { ok: true, market: "MYR", saved: true });
  assert.deepEqual(w.log.updates, [{ id: "r1", fields: { "Default Market": "MYR" } }]);
});

test("an agent cannot change it: a later choice is ignored and the existing market is returned", async (t) => {
  const w = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice", "MYR")] });
  t.after(w.restore);
  assert.deepEqual(await call({ author, market: "THB" }), { ok: true, market: "MYR", saved: false });
  assert.equal(w.log.updates.length, 0);
});

test("the market set on the agent's other login also counts, so it is not asked again or overwritten", async (t) => {
  const w = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice", "PHP"), row("r2", "lc2", "alice-uuid-2", "96 Alice")] });
  t.after(w.restore);
  assert.deepEqual(await call({ author: { accountKey: "lc2", agentToken: "tok-alice2" } }), { ok: true, market: "PHP" });
  assert.deepEqual(await call({ author: { accountKey: "lc2", agentToken: "tok-alice2" }, market: "MYR" }), { ok: true, market: "PHP", saved: false });
  assert.equal(w.log.updates.length, 0);
});

test("a login with no row yet, a missing column, a bad code and a bad token are all refused clearly and nothing is written", async (t) => {
  const none = world({ tokens, table: [] });
  t.after(none.restore);
  const noRow = await call({ author, market: "MYR" });
  assert.equal(noRow.ok, false);
  assert.match(noRow.error, /no row/i);

  const broken = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice")], failUpdate: true });
  t.after(broken.restore);
  const noColumn = await call({ author, market: "MYR" });
  assert.equal(noColumn.ok, false);
  assert.match(noColumn.error, /Default Market/);

  const ok = world({ tokens, table: [row("r1", "lc1", "alice-uuid", "96 Alice")] });
  t.after(ok.restore);
  assert.equal((await call({ author, market: "<b>" })).ok, false);
  assert.equal(ok.log.updates.length, 0);
  assert.equal((await call({ author: { accountKey: "lc1", agentToken: "wrong" } })).loginExpired, true);
  assert.equal((await call({ author: { accountKey: "lc9", agentToken: "tok-alice" } })).ok, false);
  assert.equal((await call({})).ok, false);
});
