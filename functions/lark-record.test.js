import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-record.js";
import { initEnv } from "./_lib/lark.js";

test("VS96 claim requires and saves both feedback answers", async () => {
  initEnv({
    LARK_APP_ID: "app-id",
    LARK_APP_SECRET: "app-secret",
    LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table",
  });

  const originalFetch = globalThis.fetch;
  let updatedFields;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    if (options.method === "PUT") {
      updatedFields = JSON.parse(options.body).fields;
      return { json: async () => ({ code: 0, data: { record: { record_id: "rec-1", fields: updatedFields } } }) };
    }
    return {
      json: async () => ({
        code: 0,
        data: { record: { record_id: "rec-1", fields: { "Agent Name": "Alice", Inquiry: [], Status: null } } },
      }),
    };
  };

  const baseBody = {
    recordId: "rec-1",
    agentName: "Alice",
    brand: "VS",
    inquiry: ["VS96 Feedback bonus"],
    status: "Given",
  };

  try {
    const rejected = await handler({ body: JSON.stringify({ ...baseBody, vs96FeedbackQuery1: "Answer one" }) });
    assert.equal(rejected.statusCode, 400);
    assert.match(JSON.parse(rejected.body).error, /both VS96 feedback answers/i);

    const accepted = await handler({
      body: JSON.stringify({ ...baseBody, vs96FeedbackQuery1: " Answer one ", vs96FeedbackQuery2: " Answer two " }),
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(updatedFields["Query 1 Feedback (VS96 Feedback)"], "Answer one");
    assert.equal(updatedFields["Query 2 Feedback (VS96 Feedback)"], "Answer two");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- ownership: link-only and unclaim updates must never touch another agent's row ----------------
async function recordCall(body, ownerOnRow) {
  initEnv({ LARK_APP_ID: "own-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table" });
  const original = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    if (options.method === "PUT") { writes.push(JSON.parse(options.body).fields); return { json: async () => ({ code: 0, data: { record: { record_id: "rec-1", fields: {} } } }) }; }
    return { json: async () => ({ code: 0, data: { record: { record_id: "rec-1", fields: { "Agent Name": ownerOnRow, Inquiry: [], Status: null } } } }) };
  };
  try {
    const result = await handler({ body: JSON.stringify(body) });
    return { statusCode: result.statusCode, body: JSON.parse(result.body), writes };
  } finally { globalThis.fetch = original; }
}

test("link-only update of ANOTHER agent's row is refused and nothing is written", async () => {
  const r = await recordCall({ recordId: "rec-1", linkOnly: true, chatLink: "https://my.livechatinc.com/chats/A/B", agentName: "Bob" }, "Alice");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.notOwner, true);
  assert.equal(r.writes.length, 0);
});

test("link-only update of your own row writes just the link", async () => {
  const r = await recordCall({ recordId: "rec-1", linkOnly: true, chatLink: "https://my.livechatinc.com/chats/A/B", agentName: "Alice" }, "Alice");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.writes, [{ link: { link: "https://my.livechatinc.com/chats/A/B", text: "https://my.livechatinc.com/chats/A/B" } }]);
});

test("link-only without an agent name is rejected before any lookup or write", async () => {
  const r = await recordCall({ recordId: "rec-1", linkOnly: true, chatLink: "https://my.livechatinc.com/chats/A/B" }, "Alice");
  assert.equal(r.statusCode, 400);
  assert.equal(r.writes.length, 0);
});

test("unclaim of ANOTHER agent's row is refused and nothing is written", async () => {
  const r = await recordCall({ recordId: "rec-1", unclaim: true, agentName: "Bob" }, "Alice");
  assert.equal(r.statusCode, 409);
  assert.equal(r.writes.length, 0);
});
