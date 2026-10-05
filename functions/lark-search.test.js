import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { findOldestClaimableRow, initEnv } from "./_lib/lark.js";

test("preview lookup reads bonus tables without creating a Customer Approaching record", async () => {
  initEnv({
    LARK_APP_ID: "app-id",
    LARK_APP_SECRET: "app-secret",
    LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table",
    LARK_TABLE_REDEEM_CODE: "redeem-table",
    LARK_TABLE_PNL: "pnl-table",
    LARK_TABLE_GRACE_PERIOD: "grace-table",
    LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table",
    LARK_TABLE_LTV_DAY: "ltv-table",
    LARK_TABLE_RISK_PLAYER: "risk-table",
    LARK_TABLE_SPECIAL_RELOAD: "reload-table",
    LARK_TABLE_VIP_BOOSTER: "vip-table",
    LARK_TABLE_TELEGRAM28: "telegram-table",
    LARK_TABLE_MOONCAKE: "mooncake-table",
    LARK_TABLE_VS96_FEEDBACK: "vs96-table",
  });

  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    if (options.method === "POST" && /\/records$/.test(String(url))) createCalls++;
    return { json: async () => ({ code: 0, data: { items: [] } }) };
  };

  try {
    const result = await handler({
      body: JSON.stringify({ username: "test-user", brand: "VS", picName: "Tester", preview: true }),
    });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.caRecordId, null);
    assert.equal(body.justCreated, false);
    assert.equal(createCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bonus-table searches request only the fields needed for eligibility and display", async () => {
  initEnv({
    LARK_APP_ID: "app-id",
    LARK_APP_SECRET: "app-secret",
    LARK_BASE_APP_TOKEN: "base-token",
  });

  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options = {}) => {
    if (String(_url).includes("tenant_access_token")) {
      return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    requestBody = JSON.parse(options.body);
    return { json: async () => ({ code: 0, data: { items: [] } }) };
  };

  try {
    await findOldestClaimableRow(
      "top-pnl-table", "test-user", "PP", () => true, undefined,
      { fieldNames: ["SW Check", "Claimed Copy", "Time of Inspection"] }
    );
    assert.deepEqual(requestBody.field_names, ["SW Check", "Claimed Copy", "Time of Inspection"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
