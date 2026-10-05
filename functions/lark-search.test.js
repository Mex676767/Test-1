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
  const searchBodiesByTable = new Map();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    if (options.method === "POST" && /\/records$/.test(String(url))) createCalls++;
    const tableMatch = String(url).match(/\/tables\/([^/]+)\/records\/search/);
    if (tableMatch) searchBodiesByTable.set(tableMatch[1], JSON.parse(options.body));
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
    assert.equal(searchBodiesByTable.get("grace-table").field_names, undefined);
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

test("bonus lookup falls back to a table's Username column when Username/UID is absent", async () => {
  initEnv({ LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  const requestedUsernameFields = [];
  const response = (data) => ({
    status: 200,
    headers: { get: () => null },
    json: async () => data,
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    }
    const body = JSON.parse(options.body);
    const usernameCondition = body.filter.conditions.find((condition) => condition.field_name === "Username/UID" || condition.field_name === "Username");
    requestedUsernameFields.push(usernameCondition.field_name);
    if (usernameCondition.field_name === "Username/UID") {
      return response({ code: 1254043, msg: "FieldNameNotFound: field name is invalid" });
    }
    return response({ code: 0, data: { items: [{ record_id: "grace-row", created_time: 10, fields: { "SW Check": "Activated: Pass - Deposit 1000 Bonus 108" } }] } });
  };

  try {
    const row = await findOldestClaimableRow(
      "grace-table", "67845", "RM", (fields) => fields["SW Check"].includes("Pass"), undefined,
      { newest: true, fieldNames: ["SW Check"] }
    );
    assert.equal(row.record_id, "grace-row");
    assert.deepEqual(requestedUsernameFields, ["Username/UID", "Username/UID", "Username"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookup returns eligible results for every configured bonus source", async () => {
  initEnv({
    LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table",
    LARK_TABLE_PNL: "pnl-table", LARK_TABLE_GRACE_PERIOD: "grace-table",
    LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
    LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table",
    LARK_TABLE_VIP_BOOSTER: "vip-table", LARK_TABLE_TELEGRAM28: "telegram-table",
    LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
  });
  const fixtures = {
    "pnl-table": { Tier: "Tier V", "Tittle name": "Test Player" },
    "top-pnl-table": { "SW Check": "Pass RM58", "Claimed Copy": false, "Time of Inspection": 100 },
    "ltv-table": { "SW Checker": "Pass RM18", "Time of Inspection": 110 },
    "grace-table": { "SW Check": "Activated: Pass - Deposit 1000 Bonus 108", Expried: 1_800_000_000_000, "Time of Inspection": 120 },
    "risk-table": { Status: "7D 20% Reload", "Date Expired": 1_800_000_000_000, Date: 130 },
    "vip-table": { Status: "Eligible" }, "reload-table": { Status: "Eligible Angpao" },
    "telegram-table": { Status: "Eligible", "Bonus Amount": 18 }, "redeem-table": { Status: "Eligible" },
    "mooncake-table": { Status: "Pass RM20" }, "vs96-table": { Status: "Feedback required" },
  };
  const originalFetch = globalThis.fetch;
  const response = (data) => ({ status: 200, headers: { get: () => null }, json: async () => data });
  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    if (urlText.includes("/fields?")) return response({ code: 0, data: { items: [{ field_name: "Tier", property: { options: [] } }] } });
    const tableId = urlText.match(/\/tables\/([^/]+)\/records\/search/)?.[1];
    if (!tableId) return response({ code: 0, data: { items: [] } });
    if (tableId === "customer-table") return response({ code: 0, data: { items: [] } });
    const fields = fixtures[tableId];
    if (!fields) return response({ code: 0, data: { items: [] } });
    return response({ code: 0, data: { items: [{ record_id: `${tableId}-row`, created_time: 10, fields }] } });
  };

  try {
    const result = await handler({ body: JSON.stringify({ username: "Test-User", brand: "PP", preview: true }) });
    assert.equal(result.statusCode, 200);
    const row = JSON.parse(result.body).row;
    assert.equal(row.tier, "Tier V");
    assert.equal(row.topPnl, "Pass RM58");
    assert.equal(row.ltvTest, "Pass RM18");
    assert.match(row.gracePeriod, /^Activated: Pass/);
    assert.equal(row.riskPlayer, "7D 20% Reload");
    assert.equal(row.vipBooster, "Eligible");
    assert.equal(row.specialReload.status, "Eligible Angpao");
    assert.equal(row.telegram28.status, "Eligible — RM18");
    assert.equal(row.redeemCode.status, "Eligible");
    assert.equal(row.mooncake, "Pass RM20");
    assert.equal(row.vs96Feedback, "Feedback required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
