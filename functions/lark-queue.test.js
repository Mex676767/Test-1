import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, getTenantToken } from "./_lib/lark.js";

test("Lark requests use the shared Durable Object binding when configured", async () => {
  let requestSeen;
  const queue = {
    idFromName(name) {
      assert.equal(name, "lark-api-global");
      return "shared-id";
    },
    get(id) {
      assert.equal(id, "shared-id");
      return {
        async fetch(url, init) {
          assert.equal(url, "https://lark-queue.internal/request");
          requestSeen = JSON.parse(init.body);
          return Response.json({ code: 0, tenant_access_token: "queued-token", expire: 7_200 });
        },
      };
    },
  };

  initEnv({ LARK_SEARCH_QUEUE: queue, LARK_APP_ID: "test-app", LARK_APP_SECRET: "test-secret" });
  assert.equal(await getTenantToken(), "queued-token");
  assert.equal(requestSeen.url, "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal");
  assert.equal(requestSeen.method, "POST");
  assert.deepEqual(JSON.parse(requestSeen.body), { app_id: "test-app", app_secret: "test-secret" });
});
