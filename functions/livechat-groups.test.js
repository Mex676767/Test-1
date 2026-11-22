import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./livechat-groups.js";
import { initEnv } from "./_lib/livechat.js";

const GROUPS = {
  "pat-1": [{ id: 9, name: "Priority 96" }, { id: 4, name: "AC69 Priority Support" }, { id: 12, name: "CS 96A" }],
  "pat-2": [{ id: 7, name: "XY1 Priority Support" }],
};

function world() {
  const original = globalThis.fetch;
  const calls = { listGroups: [] };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const auth = String(options.headers.Authorization);
      if (auth === "Bearer token-1") return { ok: true, status: 200, json: async () => ({ account_id: "a@example.com", client_id: "client-1" }) };
      if (auth === "Bearer token-2") return { ok: true, status: 200, json: async () => ({ account_id: "b@example.com", client_id: "client-2" }) };
      return { ok: false, status: 401, json: async () => ({ error: "invalid_token" }) };
    }
    if (url.endsWith("/list_groups")) {
      const pat = String(options.headers.Authorization).replace("Basic ", "");
      calls.listGroups.push(pat);
      return { ok: true, status: 200, json: async () => GROUPS[pat] };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const call = (agentTokens) => {
  initEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2", LIVECHAT_CLIENT_ID: "client-1", LIVECHAT_CLIENT_ID_2: "client-2" });
  return handler({ body: JSON.stringify({ agentTokens }), env: { LIVECHAT_CLIENT_ID: "client-1", LIVECHAT_CLIENT_ID_2: "client-2" } });
};

test("returns every group, not only Priority Support, sorted by name", async () => {
  const w = world();
  try {
    const result = await call({ lc1: "token-1" });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(body.licenses.map((l) => l.accountKey), ["lc1"]);
    assert.deepEqual(body.licenses[0].groups.map((g) => g.name), ["AC69 Priority Support", "CS 96A", "Priority 96"]);
    assert.deepEqual(w.calls.listGroups, ["pat-1"]);
  } finally { w.restore(); }
});

test("lists both licenses when signed in to both", async () => {
  const w = world();
  try {
    const body = JSON.parse((await call({ lc1: "token-1", lc2: "token-2" })).body);
    assert.deepEqual(body.licenses.map((l) => [l.accountKey, l.groups.length]), [["lc1", 3], ["lc2", 1]]);
  } finally { w.restore(); }
});

test("without a login nothing is listed and the PAT is never used", async () => {
  const w = world();
  try {
    const result = await call({});
    assert.equal(result.statusCode, 401);
    assert.deepEqual(w.calls.listGroups, []);
  } finally { w.restore(); }
});

test("an invalid or other-license token does not unlock that license", async () => {
  const w = world();
  try {
    const bad = JSON.parse((await call({ lc1: "nope" })).body);
    assert.equal(bad.licenses[0].ok, false);
    const crossed = JSON.parse((await call({ lc1: "token-2" })).body);
    assert.equal(crossed.licenses[0].ok, false);
    assert.deepEqual(w.calls.listGroups, []);
  } finally { w.restore(); }
});
