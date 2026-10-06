import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { initEnv } from "./_lib/lark.js";

const ENV = {
  LARK_APP_ID: "case-row-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
  LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table", LARK_TABLE_PNL: "pnl-table",
  LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
  LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table", LARK_TABLE_VIP_BOOSTER: "vip-table",
  LARK_TABLE_TELEGRAM28: "telegram-table", LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
};
const LINK = "https://my.livechatinc.com/chats/CHAT1/THREAD1";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isToken = (url) => String(url).includes("tenant_access_token");
const lookup = (env = {}) => handler({ body: JSON.stringify({ username: "Player1", brand: "PP", picName: "Agent A", link: LINK }), env });

// Fake Lark: bonus tables answer normally (VIP Booster eligible), the case-table behaviour is injected.
async function withLark({ caseSearch, create }, run) {
  initEnv({ ...ENV });
  const calls = { creates: [], caseSearches: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const text = String(url);
    if (isToken(text)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const body = options.body ? JSON.parse(options.body) : {};
    if (text.includes("customer-table") && text.endsWith("/records") && options.method === "POST") {
      calls.creates.push(body.fields);
      return create(body, calls.creates.length, options);
    }
    if (text.includes("customer-table") && (body.filter?.conditions || []).some((c) => c.field_name === "Inquiry")) {
      calls.caseSearches++;
      return caseSearch(options);
    }
    if (text.includes("vip-table")) return json({ code: 0, data: { items: [{ record_id: "vip1", fields: { Status: "Eligible", Brand: "PP", "Username/UID": "player1" } }], has_more: false } });
    return json({ code: 0, data: { items: [], has_more: false } });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const noBlankRow = () => json({ code: 0, data: { items: [], has_more: false } });
const created = () => json({ code: 0, data: { record: { record_id: "rec-created" } } });

test("a create that times out is NOT retried: it may have landed, and a second create would leave a duplicate row", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: () => { throw Object.assign(new Error("Lark upstream request timed out after 15 seconds."), { retryable: true }); },
  }, async (calls) => {
    const result = await lookup();
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(calls.creates.length, 1, "createRecord called exactly once");
    assert.equal(body.caRecordId, null);
    assert.match(body.caseRowError, /Look Up again/);
    assert.equal(body.row.vipBooster, "Eligible", "bonus results survive the case-row failure");
  });
});

test("a 5xx/mismatch create failure is not retried either", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: () => json({ code: -1, msg: "batch_create result could not be matched one-to-one to its callers; retry the lookup" }, 502),
  }, async (calls) => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(calls.creates.length, 1);
    assert.ok(body.caseRowError);
  });
});

test("when Lark rejects the link column itself, the row is created once more WITHOUT the link", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: (body, n) => n === 1 ? json({ code: 1254045, msg: "link field is invalid" }) : created(),
  }, async (calls) => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(calls.creates.length, 2);
    assert.ok("link" in calls.creates[0]);
    assert.ok(!("link" in calls.creates[1]), "second attempt carries no link");
    assert.equal(body.caRecordId, "rec-created");
    assert.equal(body.caseRowError, undefined);
  });
});

test("the blank-row check failing twice returns the bonus results with caseRowError and never creates", async () => {
  await withLark({
    caseSearch: () => json({ code: 1254290, msg: "TooManyRequest" }, 429),
    create: created,
  }, async (calls) => {
    const result = await lookup();
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.row.vipBooster, "Eligible");
    assert.equal(body.caRecordId, null);
    assert.ok(body.caseRowError);
    assert.equal(calls.creates.length, 0, "createRecord NOT called");
  });
});

test("a case-row search that never answers cannot outlive the lookup budget", async () => {
  await withLark({
    caseSearch: (options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
    }),
    create: created,
  }, async (calls) => {
    const startedAt = Date.now();
    const result = await lookup({ LOOKUP_FIRST_PASS_MS: "300", LOOKUP_BUDGET_MS: "700", LOOKUP_RETRY_MIN_MS: "100", LOOKUP_CASE_MIN_MS: "100", LOOKUP_CASE_GRACE_MS: "300" });
    const body = JSON.parse(result.body);
    assert.ok(Date.now() - startedAt < 3_000, `returned in ${Date.now() - startedAt} ms`);
    assert.equal(result.statusCode, 200);
    assert.ok(body.caseRowError);
    assert.equal(calls.creates.length, 0);
  });
});

test("a new row that Lark's search cannot see yet keeps its id (the dedupe must not null it)", async () => {
  await withLark({ caseSearch: noBlankRow, create: created }, async () => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(body.caRecordId, "rec-created");
  });
});

test("a healthy case row still comes back with an id, no warning, and the post-create dedupe runs", async () => {
  await withLark({ caseSearch: noBlankRow, create: created }, async (calls) => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(body.caRecordId, "rec-created");
    assert.equal(body.caseRowError, undefined);
    assert.equal(calls.caseSearches, 2, "pre-create check plus post-create dedupe");
  });
});

// ---- Lark's REAL rejection of a URL field is URLFieldConvFail (code 1254068), which names no "link" ----------
test("URLFieldConvFail (1254068) on the link column falls back to ONE link-less create; the row is saved with no warning", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: (body, n) => (body.fields && "link" in body.fields)
      ? json({ code: 1254068, msg: "URLFieldConvFail" })      // Lark's actual answer: no mention of "link" in the message
      : created(),
  }, async (calls) => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(calls.creates.length, 2, "exactly two creates");
    assert.ok("link" in calls.creates[0]);
    assert.ok(!("link" in calls.creates[1]), "the second create carries no link");
    assert.equal(body.caRecordId, "rec-created");
    assert.equal(body.caseRowError, undefined);
  });
});

test("FieldConvFail by message alone (no code) also triggers the fallback", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: (body) => ("link" in body.fields) ? json({ code: 1254999, msg: "SomethingFieldConvFail" }) : created(),
  }, async (calls) => {
    const body = JSON.parse((await lookup()).body);
    assert.equal(calls.creates.length, 2);
    assert.equal(body.caRecordId, "rec-created");
  });
});

test("the same code on a link-LESS create is not retried again, and timeouts / 5xx / throttling still never fall back", async () => {
  for (const [label, response] of [
    ["URL conversion error even without a link", json({ code: 1254068, msg: "URLFieldConvFail" })],
    ["HTTP 500", json({ code: 1255001, msg: "InternalError" }, 500)],
    ["throttled on HTTP 200", json({ code: 1254290, msg: "TooManyRequest" })],
  ]) {
    await withLark({ caseSearch: noBlankRow, create: () => response.clone() }, async (calls) => {
      const body = JSON.parse((await lookup()).body);
      assert.ok(body.caseRowError, label);
      assert.ok(calls.creates.length <= (label.startsWith("URL") ? 2 : 1), `${label}: ${calls.creates.length} creates`);
    });
  }
});

// ---- repeat lookups: the previous row is only read/cleaned up when it is a DIFFERENT row ------------------------
const blankRow = (id) => ({ record_id: id, fields: { Username: "player1", Brand: "PP", "Agent Name": "Agent A", link: { link: LINK, text: LINK } } });
const lookupAgain = (previousRecordId) => handler({ body: JSON.stringify({ username: "Player1", brand: "PP", picName: "Agent A", link: LINK, previousRecordId }), env: {} });

test("a repeat lookup that matches the same blank row reuses it without reading or deleting it again", async () => {
  await withLark({
    caseSearch: () => json({ code: 0, data: { items: [blankRow("rec-prev")], has_more: false } }),
    create: created,
  }, async (calls) => {
    const urls = [];
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => { urls.push(`${options.method || "GET"} ${String(url)}`); return wrapped(url, options); };
    const body = JSON.parse((await lookupAgain("rec-prev")).body);
    assert.equal(body.caRecordId, "rec-prev");
    assert.equal(calls.creates.length, 0, "no second row");
    assert.equal(urls.filter((u) => u.includes("rec-prev")).length, 0, "the reused row is not fetched or deleted");
  });
});

test("a repeat lookup for a different player still deletes the old blank row (once) and creates the new one", async () => {
  await withLark({
    caseSearch: noBlankRow,
    create: created,
  }, async (calls) => {
    const seen = [];
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const text = String(url), method = options.method || "GET";
      if (text.includes("customer-table/records/rec-old")) {
        seen.push(method);
        return method === "DELETE" ? json({ code: 0, data: { deleted: true } }) : json({ code: 0, data: { record: { record_id: "rec-old", fields: { "Agent Name": "Agent A" } } } });
      }
      return wrapped(url, options);
    };
    const body = JSON.parse((await lookupAgain("rec-old")).body);
    assert.equal(body.caRecordId, "rec-created");
    assert.equal(calls.creates.length, 1);
    assert.deepEqual(seen, ["GET", "DELETE"], "ownership read, then delete");
  });
});
