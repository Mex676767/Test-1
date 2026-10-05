import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, getTenantToken } from "./_lib/lark.js";

test("shared Durable Object grants and releases a permit around a direct Lark request", async () => {
  const calls = [];
  const queue = {
    idFromName(name) {
      assert.equal(name, "lark-api-global");
      return "shared-id";
    },
    get(id) {
      assert.equal(id, "shared-id");
      return {
        async acquire() {
          calls.push("acquire");
          return { ticket: "permit-1", retryAfterMs: 0 };
        },
        async release(ticket, rateLimited) {
          calls.push(["release", ticket, rateLimited]);
        },
      };
    },
  };
  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return Response.json({ code: 0, tenant_access_token: "permit-token", expire: 7_200 });
  };
  try {
    initEnv({ LARK_SEARCH_QUEUE: queue, LARK_APP_ID: "test-app", LARK_APP_SECRET: "test-secret" });
    assert.equal(await getTenantToken(), "permit-token");
    assert.equal(upstreamUrl, "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal");
    assert.deepEqual(calls, ["acquire", ["release", "permit-1", false]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
