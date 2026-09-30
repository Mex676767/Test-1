import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./livechat-oauth-config.js";

test("returns separate OAuth clients for two LiveChat licenses", async () => {
  const result = await handler({ env: { LIVECHAT_CLIENT_ID: "first", LIVECHAT_CLIENT_ID_2: "second" } });
  const body = JSON.parse(result.body);
  assert.equal(body.configured, true);
  assert.deepEqual(body.clients, [
    { key: "lc1", label: "LiveChat Account 1", clientId: "first" },
    { key: "lc2", label: "LiveChat Account 2", clientId: "second" },
  ]);
});

test("supports the user's LIVECHAT_CLIENT_ID2 spelling", async () => {
  const result = await handler({ env: { LIVECHAT_CLIENT_ID2: "second" } });
  const body = JSON.parse(result.body);
  assert.equal(body.clients[0].key, "lc2");
  assert.equal(body.clients[0].clientId, "second");
});
