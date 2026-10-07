import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, getRecord, updateRecord, deleteRecord, listRecords, listFields, searchRecords, createRecord, flushCounters, larkClientStats, scrubSecrets, TOKEN_INVALID_CODES, AUTH_BUG_CODES } from "./_lib/lark.js";

const ENV = { LARK_APP_ID: "tr-app", LARK_APP_SECRET: "tr-secret", LARK_BASE_APP_TOKEN: "base-token", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// A fake Lark that really expires tokens: it hands out t-<n>-… tokens (n counts up across ALL fakes, because the module keeps its cached token
// between tests) and only accepts those with n >= validFrom.
let globalIssued = 0;
function fakeLark() {
  const state = { issued: 0, validFrom: 0, rejectAll: false, calls: [], tokenCalls: 0, seenAuth: [], missingCode: 0, msgOverride: "" };
  const handler = async (url, init = {}) => {
    const text = String(url);
    if (text.includes("tenant_access_token")) {
      state.tokenCalls++;
      state.issued = ++globalIssued;
      return json({ code: 0, tenant_access_token: `t-${globalIssued}-abcdefghijklmnopqrstuvwxyz`, expire: 7200 });
    }
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
    state.seenAuth.push(auth);
    state.calls.push(`${init.method || "GET"} ${text.split("/open-apis/")[1]}`);
    if (state.missingCode) return json({ code: state.missingCode, msg: "Need a token" });
    const n = Number((auth.match(/^Bearer t-(\d+)-/) || [])[1] || 0);
    if (state.rejectAll || n < state.validFrom) return json({ code: 99991663, msg: state.msgOverride || "Invalid access token for authorization. Please make a request with token attached." });
    if (text.includes("/records/search")) return json({ code: 0, data: { items: [{ record_id: "r1", fields: { Username: "x" } }], has_more: false } });
    if (text.endsWith("/fields?page_size=100")) return json({ code: 0, data: { items: [{ field_name: "Brand" }] } });
    if (/\/records\?page_size/.test(text)) return json({ code: 0, data: { items: [{ record_id: "r1", fields: {} }] } });
    if (init.method === "POST" && text.endsWith("/records")) return json({ code: 0, data: { record: { record_id: "new1", fields: {} } } });
    return json({ code: 0, data: { record: { record_id: "r1", fields: { ok: true } } } });
  };
  return { state, handler };
}
async function withLark(lark, run) {
  const original = globalThis.fetch;
  globalThis.fetch = lark.handler;
  try { await run(); } finally { globalThis.fetch = original; }
}
// Make the token this isolate already holds stale: the next call with it is answered "invalid".
async function primeToken(lark) { await getRecord("customer-table", "warm"); lark.state.validFrom = globalIssued + 1; lark.state.calls.length = 0; lark.state.seenAuth.length = 0; lark.state.tokenCalls = 0; }

test("the documented codes: only 99991663 is retried; missing-header / malformed-token codes are bugs", () => {
  assert.deepEqual([...TOKEN_INVALID_CODES], [99991663]);
  assert.deepEqual([...AUTH_BUG_CODES].sort(), [99991661, 99991664, 99991665, 99991671]);
});

test("an invalid-token reply: the token is dropped, ONE new token is fetched, the call is retried ONCE and succeeds (get, update, delete, create, list, fields, search)", async () => {
  const lark = fakeLark();
  initEnv({ ...ENV });
  await withLark(lark, async () => {
    const calls = [
      ["get", () => getRecord("customer-table", "r1")],
      ["update", () => updateRecord("customer-table", "r1", { Status: "Solved" })],
      ["delete", () => deleteRecord("customer-table", "r1")],
      ["create", () => createRecord("customer-table", { Username: "x" })],
      ["list", () => listRecords("customer-table", 10)],
      ["fields", () => listFields("t-fields", undefined, { force: true })],
      ["search", () => searchRecords("customer-table", [{ field_name: "Username", operator: "is", value: ["x"] }])],
    ];
    for (const [name, run] of calls) {
      await primeToken(lark);
      const before = larkClientStats.tokenRefreshRetries;
      await run();
      assert.equal(lark.state.tokenCalls, 1, `${name}: exactly one refetch`);
      assert.equal(lark.state.calls.length, 2, `${name}: the failed call + ONE retry (${lark.state.calls.join(" | ")})`);
      assert.notEqual(lark.state.seenAuth[0], lark.state.seenAuth[1], `${name}: the retry used the new token`);
      assert.equal(larkClientStats.tokenRefreshRetries, before + 1, name);
    }
  });
});

test("after a refresh, later calls use the new token without fetching again", async () => {
  const lark = fakeLark();
  initEnv({ ...ENV });
  await withLark(lark, async () => {
    await primeToken(lark);
    await getRecord("customer-table", "r1");
    assert.equal(lark.state.tokenCalls, 1);
    await getRecord("customer-table", "r2");
    await getRecord("customer-table", "r3");
    assert.equal(lark.state.tokenCalls, 1, "the refreshed token is cached");
  });
});

test("a SECOND invalid reply is returned as the error: one retry, no loop", async () => {
  const lark = fakeLark();
  initEnv({ ...ENV });
  await withLark(lark, async () => {
    await primeToken(lark);
    lark.state.rejectAll = true;
    await assert.rejects(getRecord("customer-table", "r1"), (error) => error.tokenInvalid === true && error.code === 99991663);
    assert.equal(lark.state.calls.length, 2, "exactly the original call and one retry");
    assert.equal(lark.state.tokenCalls, 1, "one refetch only");
    lark.state.calls.length = 0;
    await assert.rejects(searchRecords("customer-table", [{ field_name: "Username", operator: "is", value: ["x"] }]), /Lark search failed/);
    assert.ok(lark.state.calls.length <= 2, `search: ${lark.state.calls.length} calls`);
  });
});

test("a missing-header code (99991661 'Need a token') is a bug: no refetch, no retry, and it is counted", async () => {
  const lark = fakeLark();
  initEnv({ ...ENV });
  const reports = [];
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => ({ reportCounters: async (report) => { reports.push(report); } }) } });
  await flushCounters(); reports.length = 0;
  await withLark(lark, async () => {
    await getRecord("customer-table", "warm");
    lark.state.calls.length = 0; lark.state.tokenCalls = 0;
    lark.state.missingCode = 99991661;
    await assert.rejects(getRecord("customer-table", "r1"), (error) => error.code === 99991661 && !error.tokenInvalid);
    assert.equal(lark.state.calls.length, 1, "no retry");
    assert.equal(lark.state.tokenCalls, 0, "no refetch");
  });
  await flushCounters();
  assert.equal(reports[0]["authBug:99991661"], 1);
  assert.equal(reports[0].tokenRefreshRetry, undefined);
});

test("tokenRefreshRetry is counted and reported to the queue's stats", async () => {
  const lark = fakeLark();
  const reports = [];
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => ({ reportCounters: async (report) => { reports.push(report); } }) } });
  await flushCounters(); reports.length = 0;
  await withLark(lark, async () => { await primeToken(lark); await getRecord("customer-table", "r1"); });
  await flushCounters();
  assert.equal(reports.at(-1).tokenRefreshRetry, 1);
});

test("calls the queue runs for us: the queue returns the invalid-token error and Pages retries the WHOLE call with a new token", async () => {
  const lark = fakeLark();
  const seen = [];
  const stub = {
    acquire: async () => ({ ticket: "t", retryAfterMs: 0 }), release: async () => {}, penalize: async () => {},
    larkCall: async (input) => {
      seen.push(input.headers.authorization || input.headers.Authorization);
      const res = await lark.handler(input.url, { method: input.method, headers: input.headers, body: input.body });
      return { status: res.status, statusText: "OK", headers: [], body: await res.text() };
    },
  };
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2" });
  await withLark(lark, async () => {
    await primeToken(lark);
    seen.length = 0;                                               // (the warm-up call also went through the queue)
    const record = await updateRecord("customer-table", "r1", { Status: "Solved" });
    assert.equal(record.record_id, "r1");
    assert.equal(seen.length, 2, "the queue was asked twice");
    assert.notEqual(seen[0], seen[1], "with a different token the second time");
    assert.equal(lark.state.tokenCalls, 1);
  });
});

test("secrets never reach error text, logs, counters or stats", async () => {
  const lark = fakeLark();
  const secret = "t-999-SECRETSECRETSECRETSECRET";
  lark.state.msgOverride = `Invalid access token ${secret} Bearer ${secret}`;
  initEnv({ ...ENV });
  const logged = [];
  const originals = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  for (const k of Object.keys(originals)) console[k] = (...a) => logged.push(a.map((x) => String(x)).join(" "));
  const reports = [];
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => ({ reportCounters: async (report) => { reports.push(report); } }) } });
  let error;
  try {
    await withLark(lark, async () => {
      await primeToken(lark);
      lark.state.rejectAll = true;
      try { await getRecord("customer-table", "r1"); } catch (e) { error = e; }
      await flushCounters();
    });
  } finally { Object.assign(console, originals); }
  assert.ok(error);
  for (const text of [error.message, error.larkMsg, JSON.stringify(reports), logged.join("\n")]) {
    assert.doesNotMatch(text, /SECRETSECRET/);
    assert.doesNotMatch(text, /Bearer\s+t-/);
  }
  assert.equal(scrubSecrets("Authorization: Bearer abc.def-123 and t-12345678901234567890xx ok"), "Authorization: Bearer [token] and [token] ok");
  assert.equal(scrubSecrets(undefined), "");
});
