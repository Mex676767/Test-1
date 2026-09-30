import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-stale-records.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

test("removes only the empty row when the exact link also has inquiry records", async () => {
  initLarkEnv({
    LARK_APP_ID: "app-id",
    LARK_APP_SECRET: "app-secret",
    LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table",
  });
  initLiveChatEnv({ LIVECHAT_PAT: "pat" });

  const createdAt = Date.now() - 5 * 60 * 1000;
  const common = {
    Username: "serap99",
    Brand: "ACE",
    "Agent Name": "96 Mexha - VIP RTN SNRmy",
    link: { link: "https://my.livechatinc.com/chats/chat-1/thread-1", text: "chat" },
  };
  const blank = { record_id: "rec-blank", created_time: createdAt, fields: { ...common, Inquiry: [], Status: null } };
  const complete = {
    record_id: "rec-complete",
    created_time: createdAt + 5_000,
    fields: { ...common, Inquiry: ["Reload - Ang Pao"], Status: "Given" },
  };
  const secondInquiry = {
    record_id: "rec-second-inquiry",
    created_time: createdAt + 120_000,
    fields: { ...common, Inquiry: ["Feedback"], Status: "Solved" },
  };

  const originalFetch = globalThis.fetch;
  let deletedUrl = "";
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    if (String(url).includes("api.livechatinc.com")) {
      return { json: async () => ({ thread: { active: false } }) };
    }
    if (options.method === "DELETE") {
      deletedUrl = String(url);
      return { json: async () => ({ code: 0, data: {} }) };
    }
    const conditions = JSON.parse(options.body || "{}").filter?.conditions || [];
    const isBlankSearch = conditions.some((condition) => condition.field_name === "Inquiry");
    return { json: async () => ({ code: 0, data: { items: isBlankSearch ? [blank] : [blank, complete, secondInquiry] } }) };
  };

  try {
    const response = await handler({
      body: JSON.stringify({ agentName: "96 Mexha - VIP RTN SNRmy" }),
    });
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.records, []);
    assert.match(deletedUrl, /records\/rec-blank$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
