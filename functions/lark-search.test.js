import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { findOldestClaimableRow, initEnv, searchRecords, malaysiaMidnight, inspectedToday } from "./_lib/lark.js";

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
    assert.equal(result.statusCode, 200, result.body);
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

test("batched search responses are filtered by the original username and brand conditions", async () => {
  initEnv({ LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    data: { items: [
      { fields: { Username: "alice", Brand: "PP" } },
      { fields: { Username: "alice", Brand: "MY" } },
      { fields: { Username: "bob", Brand: "PP" } },
    ] },
  }), { status: 200, headers: { "content-type": "application/json", "x-lark-batched": "1" } });

  try {
    const rows = await searchRecords("batched-table", [
      { field_name: "Username", operator: "is", value: ["alice"] },
      { field_name: "Brand", operator: "is", value: ["PP"] },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fields.Username, "alice");
    assert.equal(rows[0].fields.Brand, "PP");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("100 concurrent callers for one table are coalesced without cross-player or cross-brand results", async () => {
  const pending = [];
  let upstreamBatchCalls = 0;
  const queueStub = {
    searchBatch: (request) => new Promise((resolve) => {
      pending.push({ request, resolve });
      if (pending.length === 1) setTimeout(() => {
        const batch = pending.splice(0);
        upstreamBatchCalls++;
        const merged = batch.flatMap(({ request: item }) => JSON.parse(item.body).filter.conditions);
        const usernames = [...new Set(merged.map((condition) => condition.value[0]))];
        const records = usernames.flatMap((username) => ["PP", "MY"].map((brand) => ({ fields: { Username: username, Brand: brand } })));
        for (const { request: item, resolve: finish } of batch) {
          finish({
            status: 200,
            statusText: "OK",
            headers: [["content-type", "application/json"], ["x-lark-batched", "1"]],
            body: JSON.stringify({ code: 0, data: { items: records.filter((record) => usernames.includes(record.fields.Username)) } }),
          });
        }
      }, 15);
    }),
    acquire: async () => { throw new Error("batch test should not acquire individual permits"); },
    release: async () => {},
    penalize: async () => {},
  };
  initEnv({
    LARK_APP_ID: "batch-load-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_SEARCH_QUEUE: { idFromName: () => "global", get: () => queueStub },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ code: 0, tenant_access_token: "batch-token", expire: 3600 });

  try {
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => {
      const username = `agent-player-${index}`;
      const brand = index % 2 ? "MY" : "PP";
      return searchRecords("shared-bonus-table", [
        { field_name: "Username", operator: "is", value: [username] },
        { field_name: "Brand", operator: "is", value: [brand] },
      ], undefined, { fieldNames: ["Bonus"] }).then((rows) => ({ username, brand, rows }));
    }));
    assert.ok(upstreamBatchCalls < 100, `batching should reduce 100 per-player upstream calls, observed ${upstreamBatchCalls}`);
    assert.ok(upstreamBatchCalls <= 40, `local concurrency cap should still allow useful coalescing, observed ${upstreamBatchCalls}`);
    assert.ok(results.every(({ username, brand, rows }) => rows.length === 1
      && rows[0].fields.Username === username && rows[0].fields.Brand === brand));
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
    return response({ code: 0, data: { items: [{ record_id: "grace-row", created_time: 10, fields: { "SW Check": "Activated : 2026-10-17 14:35 - Pass - 58" } }] } });
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
  const now = Date.now();
  const fixtures = {
    "pnl-table": { Tier: "Tier V", "Title name": "Test Player" },
    "top-pnl-table": { "SW Check": "Pass RM58", "Claimed Copy": false, "Time of Inspection": now },
    "ltv-table": { "SW Checker": "Pass RM18", "Time of Inspection": now },
    "grace-table": { "SW Check": "Activated : 2026-10-17 14:35 - Pass - 58", Expired: 1_800_000_000_000, "Time of Inspection": now },
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
    assert.match(row.gracePeriod, /^Activated : .* - Pass - 58$/);
    assert.equal(row.graceExpiryMs, 1_800_000_000_000, "the Expired column is read");
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

test("lookup shows the player's name whether the P&L column is spelled Title name or Tittle name", async () => {
  for (const column of ["Title name", "Tittle name"]) {
    initEnv({
      LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
      LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_PNL: "pnl-table",
    });
    const originalFetch = globalThis.fetch;
    const response = (data) => ({ status: 200, headers: { get: () => null }, json: async () => data });
    let pnlSearchBody = null;
    globalThis.fetch = async (url, options = {}) => {
      const urlText = String(url);
      if (urlText.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "token", expire: 3600 });
      if (urlText.includes("/fields?")) return response({ code: 0, data: { items: [{ field_name: "Tier", property: { options: [] } }] } });
      const tableId = urlText.match(/\/tables\/([^/]+)\/records\/search/)?.[1];
      if (tableId !== "pnl-table") return response({ code: 0, data: { items: [] } });
      pnlSearchBody = JSON.parse(options.body);
      return response({ code: 0, data: { items: [{ record_id: "pnl-row", created_time: 10, fields: { Tier: "Tier 3", [column]: "Abang Amran" } }] } });
    };
    try {
      const result = await handler({ body: JSON.stringify({ username: "48527", brand: "FUN", preview: true }) });
      assert.equal(result.statusCode, 200, result.body);
      const row = JSON.parse(result.body).row;
      assert.equal(row.tier, "Tier 3");
      assert.equal(row.customerName, "Abang Amran", `name read from the "${column}" column`);
      assert.equal(pnlSearchBody.field_names, undefined, "a renamed name column cannot be dropped by a column list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("bonus lookup retries Lark throttling once instead of asking the agent to retry", async () => {
  initEnv({ LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("tenant_access_token")) {
      return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    searchCalls++;
    if (searchCalls > 1) {
      return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { items: [] } }) };
    }
    return {
      status: 429,
      headers: { get: (name) => name === "Retry-After" ? "60" : null },
      json: async () => ({ code: 99991400, msg: "TooManyRequest" }),
    };
  };

  try {
    const rows = await searchRecords(
      "grace-table", [{ field_name: "Username/UID", operator: "is", value: ["67845"] }], undefined,
      { fieldNames: ["Status"], maxAttempts: 2 }
    );
    assert.deepEqual(rows, [], "the retry completed successfully with an empty result");
    assert.equal(searchCalls, 2, "a throttle gets one automatic retry, never an unbounded Retry-After wait");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookup completes the first pass for every bonus table, then retries only failed sources once", async () => {
  const tableEnv = {
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
  };
  initEnv(tableEnv);
  const originalFetch = globalThis.fetch;
  const calls = [];
  const attempts = new Map();
  const throttledTables = new Set(["grace-table", "risk-table", "top-pnl-table"]);
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    }
    const tableId = String(url).match(/\/tables\/([^/]+)\/records\/search/)?.[1];
    if (!tableId) return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { items: [] } }) };
    calls.push(tableId);
    const tableAttempt = (attempts.get(tableId) || 0) + 1;
    attempts.set(tableId, tableAttempt);
    if (throttledTables.has(tableId) && tableAttempt === 1) {
      return { status: 429, headers: { get: (name) => name === "Retry-After" ? "0" : null }, json: async () => ({ code: 99991400, msg: "TooManyRequest" }) };
    }
    return { status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { items: [] } }) };
  };

  try {
    const result = await handler({ body: JSON.stringify({ username: "test-user", brand: "PP", preview: true }) });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(body.lookupWarnings, []);
    const tableIds = ["customer-table", "redeem-table", "pnl-table", "grace-table", "top-pnl-table", "ltv-table", "risk-table", "reload-table", "vip-table", "telegram-table", "mooncake-table", "vs96-table"];
    assert.ok(tableIds.every((tableId) => calls.includes(tableId)), `first pass missed a table: ${calls.join(", ")}`);
    assert.ok([...throttledTables].every((tableId) => calls.filter((id) => id === tableId).length === 2), "each throttled source is retried once");
    assert.ok(tableIds.filter((tableId) => !throttledTables.has(tableId)).every((tableId) => calls.filter((id) => id === tableId).length === 1));
    const firstRetryIndex = calls.findIndex((tableId, index) => calls.indexOf(tableId) < index);
    assert.ok(tableIds.every((tableId) => calls.indexOf(tableId) < firstRetryIndex), "retry starts only after the complete first pass");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("promotions inspected before today or in the future are hidden; today's rows show", async () => {
  initEnv({
    LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table",
    LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
    LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_RISK_PLAYER: "risk-table",
    LARK_TABLE_VIP_BOOSTER: "vip-table", LARK_TABLE_TELEGRAM28: "telegram-table",
    LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
  });
  const midnight = malaysiaMidnight(Date.now());
  const yesterday = midnight - 60_000;
  const tomorrow = midnight + 86_400_000;
  const fixtures = {
    "top-pnl-table": [{ "SW Check": "Pass RM58", "Time of Inspection": yesterday }],
    "ltv-table": [{ "SW Checker": "Pass RM18", "Time of Inspection": yesterday }, { "SW Checker": "Pass RM28", "Time of Inspection": midnight }],
    "grace-table": [{ "SW Check": "Pass - 58", "Time of Inspection": yesterday, Expired: midnight - 1 }, { "SW Check": "Pass - 88", "Time of Inspection": yesterday, Expired: tomorrow }],
    "risk-table": [{ Status: "7D 20% Reload", Date: yesterday }],
    "vip-table": [{ Status: "Eligible", "Time of Inspection": tomorrow }],
    "telegram-table": [{ Status: "Eligible", "Time of Inspection": yesterday }],
    "redeem-table": [{ Status: "Pass", "Time of Inspection": yesterday }],
    "mooncake-table": [{ Status: "Pass RM20", "Time of Inspection": [yesterday] }],
    "vs96-table": [{ Status: "Feedback required" }],
  };
  const originalFetch = globalThis.fetch;
  const response = (data) => ({ status: 200, headers: { get: () => null }, json: async () => data });
  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    const tableId = urlText.match(/\/tables\/([^/]+)\/records\/search/)?.[1];
    const rows = fixtures[tableId] || [];
    return response({ code: 0, data: { items: rows.map((fields, i) => ({ record_id: `${tableId}-${i}`, created_time: 10 + i, fields })) } });
  };
  try {
    const result = await handler({ body: JSON.stringify({ username: "inspect-user", brand: "PP", preview: true }) });
    const row = JSON.parse(result.body).row;
    assert.equal(row.topPnl, "", "yesterday's Pass is hidden");
    assert.equal(row.ltvTest, "Pass RM28", "a row inspected at today's 12AM shows");
    assert.equal(row.gracePeriod, "Pass - 88", "an old inspection whose Expired date has not passed still shows");
    assert.equal(row.riskPlayer, "7D 20% Reload", "Risk Player has no Time of Inspection; its own expiry applies");
    assert.equal(row.vipBooster, "", "a future inspection date is hidden");
    assert.equal(row.telegram28, null);
    assert.equal(row.redeemCode, null);
    assert.equal(row.mooncake, "");
    assert.equal(row.vs96Feedback, "Feedback required", "a row with no inspection time is not hidden");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Malaysia midnight and inspection-day checks use GMT+8", () => {
  const at = Date.parse("2026-11-19T00:30:00+08:00");
  assert.equal(malaysiaMidnight(at), Date.parse("2026-11-19T00:00:00+08:00"));
  assert.equal(malaysiaMidnight(Date.parse("2026-11-18T16:00:00Z")), Date.parse("2026-11-19T00:00:00+08:00"));
  const notBefore = malaysiaMidnight(at);
  assert.equal(inspectedToday({ "Time of Inspection": Date.parse("2026-11-19T00:00:00+08:00") }, notBefore), true);
  assert.equal(inspectedToday({ "Time of Inspection": Date.parse("2026-11-18T23:59:00+08:00") }, notBefore), false);
  assert.equal(inspectedToday({ "Time of Inspection": "2026-11-18 23:59" }, notBefore), false);
  const future = Date.parse("2026-11-20T08:00:00+08:00");
  assert.equal(inspectedToday({ "Time of Inspection": { value: [future] } }, notBefore, undefined, at), false);
  assert.equal(inspectedToday({ Date: future }, 0, "Date", at), false, "future dates are hidden even when an older date is otherwise allowed");
  assert.equal(inspectedToday({}, notBefore), true);
  const old = { "Time of Inspection": Date.parse("2026-11-10T00:00:00+08:00") };
  assert.equal(inspectedToday({ ...old, Expired: Date.parse("2026-11-25T00:00:00+08:00") }, notBefore, undefined, at), true, "expiry not passed: still shown");
  assert.equal(inspectedToday({ ...old, "Date Expired": Date.parse("2026-11-18T00:00:00+08:00") }, notBefore, undefined, at), false, "expiry passed: hidden");
  assert.equal(inspectedToday({ ...old, Expried: [Date.parse("2026-11-19T12:00:00+08:00")] }, notBefore, undefined, at), true);
  assert.equal(inspectedToday({ "Time of Inspection": 1 }, 0), true);
});
