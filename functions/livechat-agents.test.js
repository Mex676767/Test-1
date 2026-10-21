import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "./livechat-agents.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = {
  LIVECHAT_AGENTS_KEY: "agents-secret",
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table",
};
const AGENTS = {
  "pat-1": [{ id: "Alice@X.com", name: "Alice", role: "administrator" }, { id: "bob@x.com", name: "Bob", role: "normal" }],
  "pat-2": [{ id: "carol@x.com", name: "Carol", role: "normal" }],
};
const bound = { record_id: "r1", fields: { "LiveChat Account": "lc1", "LiveChat Login": "uuid-alice", "Livechat Email": "alice@x.com", "Agent Name": "96 Edwin", "Locked At": 1 } };

function world({ larkFails = false, failPat = "" } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.includes("/tables/logins-table/records")) {
      if (larkFails) throw new Error("lark down");
      return { json: async () => ({ code: 0, data: { items: [bound] } }) };
    }
    if (url.endsWith("/configuration/action/list_agents")) {
      const pat = String(options.headers.Authorization).replace("Basic ", "");
      return pat === failPat
        ? { ok: false, status: 403, json: async () => ({ error: { message: "Missing scope agents--all:ro" } }) }
        : { ok: true, status: 200, json: async () => AGENTS[pat] };
    }
    throw new Error("unexpected " + url);
  };
  return () => { globalThis.fetch = original; };
}
const call = async (event, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  const result = await handler({ httpMethod: "GET", env, headers: { "x-agents-key": "agents-secret" }, ...event });
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

test("disabled without a key, and closed to a wrong or missing key", async () => {
  assert.equal((await call({}, { ...ENV, LIVECHAT_AGENTS_KEY: "" })).status, 404);
  assert.equal((await call({ headers: {} })).status, 401);
  assert.equal((await call({ headers: { "x-agents-key": "nope" } })).status, 401);
  assert.equal((await call({ httpMethod: "POST" })).status, 405);
});

test("lists every agent of both LiveChat accounts, with the widget login for those who signed in", async () => {
  const restore = world();
  try {
    const { status, body } = await call({});
    assert.equal(status, 200);
    assert.equal(body.count, 3);
    assert.deepEqual(body.agents.map((a) => [a.account, a.email, a.signedIn, a.login, a.agentName]), [
      ["lc1", "alice@x.com", true, "uuid-alice", "96 Edwin"],
      ["lc1", "bob@x.com", false, "", ""],
      ["lc2", "carol@x.com", false, "", ""],
    ]);
  } finally { restore(); }
});

test("one account failing is reported beside the other's agents; the widget table being down does not hide the list", async () => {
  const restore = world({ failPat: "pat-2", larkFails: true });
  try {
    const { status, body } = await call({});
    assert.equal(status, 200);
    assert.equal(body.count, 2);
    assert.match(body.errors.lc2, /agents--all:ro/);
    assert.match(body.signInTableError, /lark down/);
    assert.equal(body.agents.every((a) => a.signedIn === false), true);
  } finally { restore(); }
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
      if (String(url).includes("/tables/")) return { json: async () => ({ code: 0, data: { items: [] } }) };
      return { ok: false, status: 403, json: async () => ({ error: { message: "no" } }) };
    };
    assert.equal((await call({})).status, 502);
  } finally { globalThis.fetch = original; }
});
