import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, getTenantToken, listFields, runWithRequestStart, requestScopeId, resetTokenCache } from "./_lib/lark.js";

// Cloudflare (handle_cross_request_promise_resolution) never settles a promise for any request except the one that
// created it. A shared in-flight promise left over from a finished request therefore hangs, or throws "This promise
// was created by a request that has since ended", for the next request that awaits it (this broke LiveChat sign-in).

function world(t) {
  const original = globalThis.fetch;
  const calls = { token: 0, fields: 0 };
  let hangFirstToken = true;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes("tenant_access_token")) {
      calls.token++;
      if (hangFirstToken) { hangFirstToken = false; return new Promise(() => {}); }
      return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, tenant_access_token: "tok", expire: 3600 }) };
    }
    if (text.includes("/fields")) {
      calls.fields++;
      if (calls.fields === 1) return new Promise(() => {});
      return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { items: [{ field_name: "Status" }] } }) };
    }
    throw new Error(`unexpected ${text}`);
  };
  t.after(() => { globalThis.fetch = original; });
  resetTokenCache();
  initEnv({ LARK_APP_ID: "id", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base" });
  return calls;
}

const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("hung: waited on another request's promise")), ms))]);

test("each request has its own scope id", () => {
  const ids = [];
  runWithRequestStart(() => ids.push(requestScopeId()), 1);
  runWithRequestStart(() => ids.push(requestScopeId()), 2);
  assert.notEqual(ids[0], ids[1]);
});

test("a token fetch left pending by an earlier request is not awaited by the next request", async (t) => {
  const calls = world(t);
  runWithRequestStart(() => { getTenantToken().catch(() => {}); });
  const token = await within(runWithRequestStart(() => getTenantToken()), 1_000);
  assert.equal(token, "tok");
  assert.equal(calls.token, 2, "the second request made its own token call");
});

test("the same request still shares one token fetch", async (t) => {
  const calls = world(t);
  await runWithRequestStart(async () => {
    getTenantToken().catch(() => {});
    getTenantToken().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.token, 1, "one token call for two awaiters inside one request");
  });
});

test("a field-list read left pending by an earlier request is not awaited by the next request", async (t) => {
  const calls = world(t);
  await runWithRequestStart(() => getTenantToken().catch(() => {}) && null);
  runWithRequestStart(() => { listFields("tbl-x", "base", { force: true }).catch(() => {}); });
  const items = await within(runWithRequestStart(() => listFields("tbl-x", "base", { force: true })), 1_000);
  assert.equal(items[0].field_name, "Status");
  assert.equal(calls.fields, 2);
});
