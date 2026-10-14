import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./qa-role.js";
import { resetQaCache } from "./crosscheck.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table", LIVECHAT_CLIENT_ID: "client-1",
};
const tracker = [
  { record_id: "t1", fields: { "Livechat Email": "qa@x.com", Role: "QA" } },
  { record_id: "t2", fields: { "Livechat Email": "agent@x.com", "LiveChat Login": "u2", "Agent Name": "96 Alice" } },
];
const accounts = {
  "tok-qa": { login: "u1", email: "QA@x.com" }, "tok-agent": { login: "u2", email: "agent@x.com" },
};

function world() {
  const original = globalThis.fetch;
  const counts = { identity: 0, tracker: 0 };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.includes("/tables/logins-table/records/search")) { counts.tracker += 1; return { json: async () => ({ code: 0, data: { items: tracker, has_more: false } }) }; }
    if (url === "https://accounts.livechat.com/v2/info") {
      counts.identity += 1;
      const who = accounts[String(options.headers?.Authorization || "").replace("Bearer ", "")];
      return who ? { ok: true, json: async () => ({ account_id: who.login, email: who.email, client_id: "client-1" }) } : { ok: false, json: async () => ({ error: "invalid" }) };
    }
    throw new Error("unexpected " + url);
  };
  return { counts, restore: () => { globalThis.fetch = original; } };
}
const ask = async (body, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  const res = await handler({ body: JSON.stringify(body), env });
  return { status: res.statusCode, ...JSON.parse(res.body) };
};

test("a login marked QA in the tracker is told so; an ordinary agent is not; a bad token is an expired login, never a guess", async (t) => {
  const w = world();
  t.after(w.restore);
  resetQaCache();
  assert.deepEqual(await ask({ accountKey: "lc1", agentToken: "tok-qa" }), { status: 200, ok: true, qa: true });
  assert.deepEqual(await ask({ accountKey: "lc1", agentToken: "tok-agent" }), { status: 200, ok: true, qa: false });
  const bad = await ask({ accountKey: "lc1", agentToken: "tok-nobody" });
  assert.equal(bad.ok, false);
  assert.equal(bad.loginExpired, true);
});

test("the answer is remembered for a few minutes per login, so every agent starting the widget does not read the tracker each time", async (t) => {
  const w = world();
  t.after(w.restore);
  resetQaCache();
  await ask({ accountKey: "lc1", agentToken: "tok-agent" });
  const identity = w.counts.identity;
  const tracked = w.counts.tracker;
  await ask({ accountKey: "lc1", agentToken: "tok-agent" });
  await ask({ accountKey: "lc1", agentToken: "tok-agent" });
  assert.deepEqual([w.counts.identity, w.counts.tracker], [identity, tracked]);
});

test("missing or wrong input is refused; no Agent Logins table means nobody is QA, not an error", async (t) => {
  const w = world();
  t.after(w.restore);
  resetQaCache();
  assert.equal((await ask({ accountKey: "lc9", agentToken: "tok-qa" })).status, 400);
  assert.equal((await ask({ accountKey: "lc1", agentToken: "  " })).status, 400);
  assert.equal((await ask({ accountKey: "lc1" })).status, 400);
  resetQaCache();
  const none = await ask({ accountKey: "lc1", agentToken: "tok-qa" }, { ...ENV, LARK_TABLE_AGENT_LOGINS: "" });
  assert.equal(none.ok === true ? none.qa : false, false);
});
