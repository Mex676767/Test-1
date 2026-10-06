import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { initEnv, updateRecord, deleteRecord } from "./_lib/lark.js";

const ENV = {
  LARK_APP_ID: "burst-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
  LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table", LARK_TABLE_PNL: "pnl-table",
  LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
  LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table", LARK_TABLE_VIP_BOOSTER: "vip-table",
  LARK_TABLE_TELEGRAM28: "telegram-table", LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
};
const LINK = "https://my.livechatinc.com/chats/CHAT1/THREAD1";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// A hang that gives up when the caller aborts (as a real fetch does) -- otherwise stuck calls would hold the per-isolate
// search permits for the rest of the test process.
const never = (options) => new Promise((_, reject) => { options?.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true }); });
const blankRow = (id, createdAt) => ({ record_id: id, created_time: createdAt, fields: { Username: "player1", Brand: "PP", "Agent Name": "Agent A", link: { link: LINK, text: LINK } } });
const body = (env, extra = {}) => ({ body: JSON.stringify({ username: "Player1", brand: "PP", picName: "Agent A", link: LINK }), env, ...extra });

// Fake Lark. `route(kind, url, options)` may return a Response / a promise, or undefined for the default answer.
async function withLark(route, run) {
  initEnv({ ...ENV });
  const log = { deletes: [], gets: [], caseSearches: 0, creates: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const text = String(url);
    if (text.includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const method = options.method || "GET";
    const parsed = options.body ? JSON.parse(options.body) : {};
    let kind = "other";
    if (text.includes("customer-table/records/") && method === "DELETE") { kind = "delete"; log.deletes.push(text.split("/").pop()); }
    else if (text.includes("customer-table/records/") && method === "GET") { kind = "get"; log.gets.push(text.split("/").pop()); }
    else if (text.includes("customer-table") && text.endsWith("/records") && method === "POST") { kind = "create"; log.creates++; }
    else if (text.includes("customer-table") && (parsed.filter?.conditions || []).some((c) => c.field_name === "Inquiry")) { kind = "caseSearch"; log.caseSearches++; }
    const answered = await route(kind, text, options, log, () => never(options));
    if (answered) return answered;
    if (kind === "create") return json({ code: 0, data: { record: { record_id: "rec-created" } } });
    if (kind === "caseSearch") return json({ code: 0, data: { items: [], has_more: false } });
    if (kind === "get") return json({ code: 0, data: { record: { record_id: text.split("/").pop(), fields: { "Agent Name": "Agent A" } } } });
    if (kind === "delete") return json({ code: 0, data: { deleted: true } });
    if (text.includes("vip-table")) return json({ code: 0, data: { items: [{ record_id: "vip1", fields: { Status: "Eligible", Brand: "PP", "Username/UID": "player1" } }], has_more: false } });
    return json({ code: 0, data: { items: [], has_more: false } });
  };
  try { await run(log); } finally { globalThis.fetch = original; }
}
const twins = () => json({ code: 0, data: { items: [blankRow("rec-old", 1), blankRow("rec-twin", 2)], has_more: false } });
const pending = (promise) => Promise.race([promise.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 60))]);

// ---- step 1: twin deletes never delay the response --------------------------------------------------------
test("a twin delete that hangs does not delay the answer: it is handed to waitUntil and the lookup still returns the kept row", async () => {
  await withLark((kind, url, options) => {
    if (kind === "caseSearch") return twins();
    if (kind === "get" || kind === "delete") return never(options);          // the cleanup hangs forever
  }, async (log) => {
    const deferred = [];
    const started = Date.now();
    const result = await handler(body({}, { waitUntil: (promise) => deferred.push(promise) }));
    const answer = JSON.parse(result.body);
    assert.ok(Date.now() - started < 3_000, `answered in ${Date.now() - started} ms`);
    assert.equal(result.statusCode, 200);
    assert.equal(answer.caRecordId, "rec-old", "the oldest blank row is kept");
    assert.equal(answer.caseRowError, undefined);
    assert.equal(deferred.length, 1, "the cleanup was handed to waitUntil");
    assert.equal(await pending(deferred[0]), true, "and is still running (hung) after the response");
    assert.deepEqual(log.gets, ["rec-twin"]);
  });
});

test("when nothing hangs the twin is still deleted exactly once, after the response", async () => {
  await withLark((kind) => (kind === "caseSearch" ? twins() : undefined), async (log) => {
    const deferred = [];
    const result = await handler(body({}, { waitUntil: (promise) => deferred.push(promise) }));
    assert.equal(JSON.parse(result.body).caRecordId, "rec-old");
    await Promise.all(deferred);
    assert.deepEqual(log.deletes, ["rec-twin"]);
  });
});

test("without waitUntil (e.g. a caller that does not pass one) the cleanup still starts and still deletes the twin", async () => {
  await withLark((kind) => (kind === "caseSearch" ? twins() : undefined), async (log) => {
    const result = await handler(body({}));
    assert.equal(JSON.parse(result.body).caRecordId, "rec-old");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(log.deletes, ["rec-twin"]);
  });
});

test("a twin that was completed in the meantime is NOT deleted (the ownership re-check still runs, just deferred)", async () => {
  await withLark((kind, url) => {
    if (kind === "caseSearch") return twins();
    if (kind === "get") return json({ code: 0, data: { record: { record_id: "rec-twin", fields: { "Agent Name": "Agent A", Status: "Solved", Inquiry: ["Others"] } } } });
  }, async (log) => {
    const deferred = [];
    await handler(body({}, { waitUntil: (promise) => deferred.push(promise) }));
    await Promise.all(deferred);
    assert.deepEqual(log.deletes, []);
  });
});

// ---- step 1: the post-create check is bounded by the remaining budget ---------------------------------------
test("a post-create dedupe search that never answers is cut off at the remaining budget; the new row's id is kept", async () => {
  await withLark((kind, url, options, log) => {
    if (kind === "caseSearch" && log.caseSearches >= 2) return never(options);      // 1st = pre-create check, 2nd = post-create dedupe
  }, async (log) => {
    const started = Date.now();
    const result = await handler(body({ LOOKUP_BUDGET_MS: 3_500, LOOKUP_HARD_DEADLINE_MS: 5_000 }));
    const elapsed = Date.now() - started;
    const answer = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(answer.caRecordId, "rec-created");
    assert.equal(answer.caseRowError, undefined);
    assert.equal(log.caseSearches, 2);
    assert.ok(elapsed >= 3_000 && elapsed < 4_800, `cut off near the budget, not hung: ${elapsed} ms`);
  });
});

// ---- step 1: the hard deadline -------------------------------------------------------------------------------
test("hard deadline: a case-row create that hangs still returns the bonus results with a warning before the deadline", async () => {
  await withLark((kind, url, options) => (kind === "create" ? never(options) : undefined), async () => {
    const started = Date.now();
    const result = await handler(body({ LOOKUP_HARD_DEADLINE_MS: 2_600 }));
    const answer = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(answer.row.vipBooster, "Eligible", "results survive");
    assert.match(answer.caseRowError, /Look Up again/);
    assert.ok(Date.now() - started < 2_600, `${Date.now() - started} ms`);
  });
});

test("the hard deadline defaults to 40 s (below the widget's 45 s abort) and a normal lookup is untouched by it", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("./lark-search.js", import.meta.url), "utf8");
  assert.match(source, /const HARD_DEADLINE_MS = 40_000;/);
  await withLark(() => undefined, async () => {
    const result = await handler(body({}));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).caRecordId, "rec-created");
  });
});

// ---- the queue is told when a row it created is changed or deleted ----------------------------------------
function queueEnv(stub, extra = {}) {
  return { ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2", LARK_BATCH_CREATE: "1", ...extra };
}
async function withWrites(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    if (options.method === "PUT") return json({ code: 0, data: { record: { record_id: "r1", fields: {} } } });
    if (options.method === "DELETE") return json({ code: 0, data: { deleted: true } });
    return json({ code: 0, data: {} });
  };
  try { await run(); } finally { globalThis.fetch = original; }
}

test("updating or deleting a Customer Approaching row tells the queue to forget it", async () => {
  const forgotten = [];
  const stub = { forgetCreated: async (id) => { forgotten.push(id); }, acquire: async () => ({ ticket: "t" }), release: async () => {}, penalize: async () => {} };
  initEnv(queueEnv(stub));
  await withWrites(async () => {
    await updateRecord("customer-table", "recAAA", { Status: "Solved" });
    await deleteRecord("customer-table", "recBBB");
    await updateRecord("some-other-table", "recCCC", { Status: "x" });
  });
  assert.deepEqual(forgotten, ["recAAA", "recBBB"], "only Customer Approaching rows");
});

test("without batched creates, or with a queue that has no such method, or one that hangs, updates are unaffected", async () => {
  const forgotten = [];
  initEnv(queueEnv({ forgetCreated: async (id) => { forgotten.push(id); } }, { LARK_BATCH_CREATE: "" }));
  await withWrites(async () => { await updateRecord("customer-table", "recAAA", { Status: "Solved" }); });
  assert.deepEqual(forgotten, [], "flag off = no calls");

  initEnv(queueEnv({ forgetCreated: () => { throw new Error("queue has no such method"); } }));
  await withWrites(async () => { assert.ok(await updateRecord("customer-table", "recAAA", { Status: "Solved" })); });

  initEnv(queueEnv({ forgetCreated: never }));
  await withWrites(async () => {
    const started = Date.now();
    assert.ok(await updateRecord("customer-table", "recAAA", { Status: "Solved" }));
    assert.ok(Date.now() - started < 1_500, "a hung queue delays the update by at most ~0.5 s");
  });
});

// Last on purpose: everything in this one hangs, and calls stuck in shared module state (field cache, token) would
// otherwise leak into the tests that follow it.
test("hard deadline: whatever hangs, the response is on its way by the deadline (here 500 ms) as an honest 'look up again'", async () => {
  await withLark((kind, url, options) => never(options), async () => {
    const started = Date.now();
    const result = await handler(body({ LOOKUP_HARD_DEADLINE_MS: 500, LOOKUP_FIRST_PASS_MS: 300 }));
    assert.equal(result.statusCode, 504);
    const answer = JSON.parse(result.body);
    assert.equal(answer.ok, false);
    assert.equal(answer.hardDeadline, true);
    assert.match(answer.error, /Look Up again/);
    assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
  });
});
