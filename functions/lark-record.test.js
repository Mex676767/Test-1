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
