import test from "node:test";
import assert from "node:assert/strict";
import { handler as searchHandler } from "./lark-search.js";
import { handler as brandListHandler } from "./lark-brand-list.js";
import { handler as picListHandler } from "./lark-pic-list.js";
import { handler as bootstrapHandler } from "./app-bootstrap.js";
import { initEnv, listFields } from "./_lib/lark.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const baseEnv = (extra = {}) => ({
  LARK_APP_ID: "resilience-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token", ...extra,
});
const withFetch = async (impl, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
};
const isToken = (url) => String(url).includes("tenant_access_token");
const catalog = (brands = ["PP", "MY"], agents = ["Agent A", "Agent B"]) => json({ code: 0, data: { items: [
  { field_name: "Brand", property: { options: brands.map((name, i) => ({ id: `b${i}`, name })) } },
  { field_name: "Agent Name", property: { options: agents.map((name, i) => ({ id: `a${i}`, name })) } },
  { field_name: "Inquiry", property: { options: [{ id: "i1", name: "Deposit" }] } },
  { field_name: "Status", property: { options: [{ id: "s1", name: "Solved" }] } },
] } });

test("one table that never answers is reported as unavailable inside the time budget; every other source still returns", async () => {
  initEnv(baseEnv({
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table", LARK_TABLE_PNL: "pnl-table",
    LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
    LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table", LARK_TABLE_VIP_BOOSTER: "vip-table",
    LARK_TABLE_TELEGRAM28: "telegram-table", LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
  }));
  await withFetch(async (url, options = {}) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    if (String(url).includes("top-pnl-table")) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
      });
    }
    return json({ code: 0, data: { items: [], has_more: false } });
  }, async () => {
    const startedAt = Date.now();
    const result = await searchHandler({
      body: JSON.stringify({ username: "player1", brand: "PP", preview: true }),
      env: { LOOKUP_FIRST_PASS_MS: "300", LOOKUP_BUDGET_MS: "1500", LOOKUP_RETRY_MIN_MS: "200" },
    });
    const elapsed = Date.now() - startedAt;
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.ok(body.ok);
    assert.deepEqual(body.lookupWarnings, ["Top 10 P&L"], "the stuck source is named, nothing else is lost");
    assert.equal(body.row.topPnl, "", "no guessed value for the unavailable source");
    assert.ok(elapsed < 3_000, `lookup returned in ${elapsed} ms instead of hanging`);
  });
});

test("field catalog falls back to the last good copy when Lark errors, so option lists never go empty", async () => {
  initEnv(baseEnv({ LARK_TABLE_CUSTOMER_APPROACHING: "stale-fields-table" }));
  let failing = false;
  await withFetch(async (url) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    return failing ? json({ code: 1254290, msg: "TooManyRequest" }, 429) : catalog();
  }, async () => {
    const first = await listFields("stale-fields-table");
    assert.equal(first.length, 4);
    failing = true;
    const stale = await listFields("stale-fields-table", undefined, { force: true });
    assert.equal(stale.length, 4, "served from the last good copy");
  });
});

test("brand and agent list endpoints report failure instead of an empty success", async () => {
  initEnv(baseEnv({ LARK_TABLE_CUSTOMER_APPROACHING: "never-cached-table" }));
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : json({ code: 1254290, msg: "TooManyRequest" }, 429), async () => {
    for (const [name, endpoint] of [["brands", brandListHandler], ["pics", picListHandler]]) {
      const result = await endpoint();
      const body = JSON.parse(result.body);
      assert.equal(body.ok, false, `${name}: not reported as success`);
      assert.ok(result.statusCode >= 500);
    }
  });
});

test("an empty Brand/Agent catalog is a failure, so the widget keeps the lists it already has", async () => {
  initEnv(baseEnv({ LARK_TABLE_CUSTOMER_APPROACHING: "empty-catalog-table" }));
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : catalog([], []), async () => {
    const result = await bootstrapHandler({ queryStringParameters: { fresh: "1" } });
    assert.equal(result.statusCode, 502);
    assert.equal(JSON.parse(result.body).ok, false);
  });
});

test("a healthy catalog still returns the brand and agent lists", async () => {
  initEnv(baseEnv({ LARK_TABLE_CUSTOMER_APPROACHING: "healthy-catalog-table" }));
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : catalog(["PP", "MY", "VS"], ["Agent A"]), async () => {
    const result = await bootstrapHandler({ queryStringParameters: { fresh: "1" } });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(body.brands, ["MY", "PP", "VS"]);
    assert.deepEqual(body.agents, ["Agent A"]);
  });
});
