import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, runWithRequestStart, getRecord, updateRecord, deleteRecord, listFields, listRecords, searchRecords, larkClientStats, noteCounter, flushCounters } from "./_lib/lark.js";
import { readOwnershipMerged } from "./_lib/ca-row.js";
import { handler as recordHandler } from "./lark-record.js";

const ENV = { LARK_APP_ID: "qc-app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base-token", LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_BONUS_CONFIG: "config-table" };
const never = () => new Promise(() => {});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const ok = (data) => ({ status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ code: 0, data }) });

// A stub queue that records every call it receives.
function makeStub(overrides = {}) {
  const calls = [];
  const impls = {
    acquire: async () => ({ ticket: 't', retryAfterMs: 0 }),
    release: async () => {}, penalize: async () => {},
    searchBatch: async () => ok({ items: [], has_more: false }),
    createBatch: async () => ok({ record: { record_id: 'rec-new' } }),
    larkCall: async () => ok({ record: { record_id: 'r1', fields: {} } }),
    cachedCall: async () => ok({ items: [] }),
    ...overrides,
  };
  const stub = { calls };
  for (const [name, impl] of Object.entries(impls)) if (impl) stub[name] = async (...args) => { calls.push({ name, args }); return impl(...args); };
  return stub;
}
const queueEnv = (stub, extra = {}) => ({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2", ...extra });
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || "GET", body: init.body });
    if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "tok", expire: 7200 });
    return fn(String(url), init, seen);
  };
  try { await run(seen); } finally { globalThis.fetch = original; }
}

// ---- A: every queue call carries the request's start time -------------------------------------------------------------
test("A: calls made inside a request carry that request's start time (searches, creates, permits, queue calls); outside one they carry none", async () => {
  const stub = makeStub();
  initEnv(queueEnv(stub, { LARK_BATCH_CREATE: "1" }));
  const startedAt = Date.now() - 5_000;
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    await runWithRequestStart(async () => {
      await searchRecords("customer-table", [{ field_name: "Username", operator: "is", value: ["x"] }]).catch(() => {});
      await updateRecord("customer-table", "r1", { Status: "Solved" });
      await getRecord("customer-table", "r1");
    }, startedAt);
  });
  const stamped = (name) => stub.calls.filter((c) => c.name === name);
  assert.ok(stamped("searchBatch").every((c) => c.args[0].requestStartedAt === startedAt), "search");
  assert.ok(stamped("larkCall").length === 2 && stamped("larkCall").every((c) => c.args[0].requestStartedAt === startedAt), "update + get");
  assert.ok(stamped("acquire").every((c) => c.args[2] === startedAt), "token permit: acquire(kind, waiterId, requestStartedAt, label)");
  stub.calls.length = 0;
  await withFetch(() => json({ code: 0, data: {} }), async () => { await updateRecord("customer-table", "r2", { Status: "x" }); });
  assert.equal(stamped("larkCall")[0].args[0].requestStartedAt, undefined, "no request context -> no start time (old ordering)");
});

test("A: runWithRequestStart keeps the EARLIER start when nested (adapt() starts it, the handler repeats it)", async () => {
  const stub = makeStub();
  initEnv(queueEnv(stub));
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    await runWithRequestStart(() => runWithRequestStart(() => getRecord("customer-table", "r1"), Date.now()), 12345);
  });
  assert.equal(stub.calls.find((c) => c.name === "larkCall").args[0].requestStartedAt, 12345);
});

test("A: createBatch carries the request start", async () => {
  const stub = makeStub();
  initEnv(queueEnv(stub, { LARK_BATCH_CREATE: "1" }));
  const { createRecord } = await import("./_lib/lark.js");
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    await runWithRequestStart(() => createRecord("customer-table", { Username: "x" }), 777);
  });
  const call = stub.calls.find((c) => c.name === "createBatch");
  assert.equal(call.args[0].requestStartedAt, 777);
  assert.equal(call.args[0].label, "create");
});

// ---- B: get / update / delete run inside the queue ---------------------------------------------------------------------
test("B: update, get and delete go to the queue's larkCall (no permit acquired for them), with a label and a deadline", async () => {
  const stub = makeStub();
  initEnv(queueEnv(stub));
  await withFetch(() => { throw new Error("must not call Lark directly"); }, async (seen) => {
    const record = await updateRecord("customer-table", "r1", { Status: "Solved" });
    assert.equal(record.record_id, "r1");
    await getRecord("customer-table", "r1");
    await deleteRecord("customer-table", "r1");
    assert.equal(seen.filter((s) => !s.url.includes("tenant_access_token")).length, 0, "no direct Lark call");
  });
  const calls = stub.calls.filter((c) => c.name === "larkCall").map((c) => c.args[0]);
  assert.deepEqual(calls.map((c) => [c.method, c.label]), [["PUT", "update"], ["GET", "record-get"], ["DELETE", "delete"]]);
  assert.ok(calls.every((c) => c.expiresAt > Date.now()), "each call has a deadline");
  assert.equal(JSON.parse(calls[0].body).fields.Status, "Solved");
  assert.ok(stub.calls.filter((c) => c.name === "acquire").every((c) => c.args[3] === "token"), "the only permit this needed is the (cached) token");
  assert.equal(stub.calls.filter((c) => c.name === "forgetCreated").length, 0, "the queue drops its own memory when it runs the call");
});

test("B: a Lark error answer through the queue becomes the same error as before (code, rate-limit flag)", async () => {
  const stub = makeStub({ larkCall: async () => ({ status: 200, statusText: "OK", headers: [], body: JSON.stringify({ code: 1254290, msg: "TooManyRequest" }) }) });
  initEnv(queueEnv(stub));
  await withFetch(() => json({}), async () => {
    await assert.rejects(updateRecord("customer-table", "r1", {}), (error) => error.code === 1254290 && error.rateLimited === true && error.retryable === true);
  });
  const gateway = makeStub({ larkCall: async () => ({ status: 504, statusText: "", headers: [], body: JSON.stringify({ code: -1, msg: "Lark upstream request timed out" }) }) });
  initEnv(queueEnv(gateway));
  await withFetch(() => json({}), async () => {
    await assert.rejects(getRecord("customer-table", "r1"), (error) => error.retryable === true && /getRecord failed/.test(error.message));
  });
});

test("B: fallback — a queue without larkCall (older deploy) or without v2 mode uses the permit path exactly as before", async () => {
  const forgotten = [];
  const old = makeStub({ larkCall: undefined, forgetCreated: async (id) => { forgotten.push(id); } });
  delete old.larkCall;
  initEnv(queueEnv(old, { LARK_BATCH_CREATE: "1" }));
  const before = larkClientStats.queueCallFallbacks;
  await withFetch((url, init) => (init.method === "PUT" ? json({ code: 0, data: { record: { record_id: "r1", fields: {} } } }) : json({ code: 0, data: {} })), async (seen) => {
    const record = await updateRecord("customer-table", "r1", { Status: "Solved" });
    assert.equal(record.record_id, "r1");
    assert.ok(seen.some((s) => s.method === "PUT"), "went to Lark directly through a permit");
  });
  assert.equal(larkClientStats.queueCallFallbacks, before + 1);
  assert.deepEqual(forgotten, ["r1"], "and told the queue to forget the row (the old behaviour)");
  assert.ok(old.calls.some((c) => c.name === "acquire" && c.args[3] === "update"), "permit labelled 'update'");

  const legacyMode = makeStub();
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => legacyMode } });         // no LARK_QUEUE_PROTOCOL
  await withFetch(() => json({ code: 0, data: { record: { record_id: "r1", fields: {} } } }), async () => { await updateRecord("customer-table", "r1", {}); });
  assert.equal(legacyMode.calls.filter((c) => c.name === "larkCall").length, 0);
});

// ---- D: shared cached reads + labels -----------------------------------------------------------------------------------
test("D: listFields asks the queue's shared cache (30 s TTL, 6 h stale) and parses its answer; fresh forces a refresh", async () => {
  const stub = makeStub({ cachedCall: async () => ok({ items: [{ field_name: "Tier", property: { options: [{ id: "o1", name: "VIP1" }] } }] }) });
  initEnv(queueEnv(stub));
  await withFetch(() => { throw new Error("must not call Lark directly"); }, async () => {
    const fields = await listFields("pnl-table-x", undefined, { force: true });
    assert.equal(fields[0].field_name, "Tier");
  });
  const input = stub.calls.find((c) => c.name === "cachedCall").args[0];
  assert.match(input.cacheKey, /^fields::base-token::pnl-table-x$/);
  assert.equal(input.ttlMs, 30_000);
  assert.equal(input.staleMs, 6 * 60 * 60_000);
  assert.equal(input.force, true);
  assert.equal(input.label, "fields");
});

test("D: listFields falls back to a direct read when the queue has no cachedCall", async () => {
  const old = makeStub(); delete old.cachedCall;
  initEnv(queueEnv(old));
  await withFetch((url) => (url.includes("/fields") ? json({ code: 0, data: { items: [{ field_name: "Brand" }] } }) : json({ code: 0, data: {} })), async () => {
    const fields = await listFields("pnl-table-y", undefined, { force: true });
    assert.equal(fields[0].field_name, "Brand");
  });
});

test("D: the bonus-config list uses the shared copy for 60 s, and fresh skips it", async () => {
  const stub = makeStub({ cachedCall: async () => ok({ items: [{ record_id: "c1", fields: {} }] }) });
  initEnv(queueEnv(stub));
  await withFetch(() => json({}), async () => {
    const rows = await listRecords("config-table", 500, { sharedCacheMs: 60_000, force: true });
    assert.equal(rows[0].record_id, "c1");
  });
  const input = stub.calls.find((c) => c.name === "cachedCall").args[0];
  assert.deepEqual([input.ttlMs, input.force, input.label], [60_000, true, "list"]);
  const source = (await import("node:fs")).readFileSync(new URL("./_lib/bonus-config.js", import.meta.url), "utf8");
  assert.match(source, /listRecords\(TABLE_BONUS_CONFIG, 500, \{ sharedCacheMs: 60_000, force: fresh \}\)/);
});

test("D: every permit is labelled for the queue's stats (token / fields / list / record-get / update / delete / create)", async () => {
  const old = makeStub(); delete old.larkCall; delete old.cachedCall;            // force the permit path for everything
  initEnv(queueEnv(old));
  await withFetch(() => json({ code: 0, data: { items: [], record: { record_id: "r1", fields: {} } } }), async () => {
    await listFields("t-labels");
    await listRecords("config-table", 10);
    await getRecord("customer-table", "r1");
    await updateRecord("customer-table", "r1", {});
    await deleteRecord("customer-table", "r1");
  });
  const labels = old.calls.filter((c) => c.name === "acquire").map((c) => c.args[3]);
  for (const expected of ["fields", "list", "record-get", "update", "delete"]) assert.ok(labels.includes(expected), `${expected} in ${labels.join(",")}`);
});

// ---- C: ownership through a merged search -----------------------------------------------------------------------------
const caRow = (id, agent, extra = {}) => ({ record_id: id, fields: { "Agent Name": agent, ...extra } });
function lark({ rows = [], recordOwner = "Agent A", searchFails = false } = {}) {
  const log = { searches: 0, gets: 0, puts: 0, putBodies: [] };
  return {
    log,
    route: (url, init) => {
      if (url.includes("/records/search")) { log.searches++; return searchFails ? json({ code: 1254290, msg: "TooManyRequest" }, 429) : json({ code: 0, data: { items: rows, has_more: false } }); }
      if (init.method === "PUT") { log.puts++; log.putBodies.push(JSON.parse(init.body)); return json({ code: 0, data: { record: { record_id: "rec1", fields: {} } } }); }
      if (!init.method || init.method === "GET") { log.gets++; return json({ code: 0, data: { record: { record_id: "rec1", fields: { "Agent Name": recordOwner } } } }); }
      return json({ code: 0, data: {} });
    },
  };
}
const submit = (extra = {}) => recordHandler({ body: JSON.stringify({ recordId: "rec1", agentName: "Agent A", username: "Player1", brand: "PP", inquiry: ["Others"], status: "Solved", chatLink: "https://my.livechatinc.com/chats/C/T", ...extra }) });

test("C: a submit by the row's owner is checked with ONE search (no record GET) and then updated", async () => {
  initEnv({ ...ENV });
  const fake = lark({ rows: [caRow("rec1", "Agent A")] });
  await withFetch((url, init) => fake.route(url, init), async (seen) => {
    const result = await submit();
    assert.equal(result.statusCode, 200);
    assert.deepEqual([fake.log.searches, fake.log.gets, fake.log.puts], [1, 0, 1]);
    const search = JSON.parse(seen.find((s) => s.url.includes("/records/search")).body);
    assert.deepEqual(search.filter.conditions, [{ field_name: "Username", operator: "is", value: ["player1"] }], "username lower-cased, the lookup's own key");
    assert.deepEqual(search.field_names.sort(), ["Agent Name", "Inquiry", "Status"], "only the columns the check needs");
  });
});

test("C: row missing from the search (index lag), search failing, or no username sent -> the single-record GET decides, same rules", async () => {
  initEnv({ ...ENV });
  for (const scenario of [
    { name: "row not in the search", fake: lark({ rows: [caRow("someone-else", "Agent B")] }), extra: {} },
    { name: "search fails", fake: lark({ searchFails: true }), extra: {} },
    { name: "old widget: no username", fake: lark({}), extra: { username: undefined } },
  ]) {
    await withFetch((url, init) => scenario.fake.route(url, init), async () => {
      const result = await submit(scenario.extra);
      assert.equal(result.statusCode, 200, scenario.name);
      assert.equal(scenario.fake.log.gets, 1, `${scenario.name}: GET fallback`);
      assert.equal(scenario.fake.log.puts, 1);
    });
  }
  const other = lark({ rows: [], recordOwner: "Agent B" });
  await withFetch((url, init) => other.route(url, init), async () => {
    const result = await submit();
    assert.equal(result.statusCode, 409, "the fallback still refuses another agent's row");
    assert.equal(other.log.puts, 0);
  });
});

const reasons = () => ({ ...larkClientStats.ownershipFallbackReasons });
const reasonDelta = (before) => Object.fromEntries(Object.entries(reasons()).map(([k, v]) => [k, v - (before[k] || 0)]).filter(([, v]) => v));

test("C: search says ANOTHER agent owns it -> the GET decides: true owner is me -> allowed; true owner is someone else -> refused with 409", async () => {
  initEnv({ ...ENV });
  const before = reasons();
  const stale = lark({ rows: [caRow("rec1", "Agent B")], recordOwner: "Agent A" });        // the search is stale, Lark's truth is me
  await withFetch((url, init) => stale.route(url, init), async () => {
    const result = await submit();
    assert.equal(result.statusCode, 200);
    assert.deepEqual([stale.log.searches, stale.log.gets, stale.log.puts], [1, 1, 1]);
  });
  const real = lark({ rows: [caRow("rec1", "Agent B")], recordOwner: "Agent B" });         // both say Agent B
  await withFetch((url, init) => real.route(url, init), async () => {
    const result = await submit();
    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.equal(body.notOwner, true);
    assert.equal(body.owner, "Agent B");
    assert.equal(real.log.puts, 0, "never written");
  });
  assert.deepEqual(reasonDelta(before), { otherOwner: 2 });
});

test("C: search says the owner is BLANK -> the GET decides (and counts as blankOwner)", async () => {
  initEnv({ ...ENV });
  const before = reasons();
  const blank = lark({ rows: [caRow("rec1", "")], recordOwner: "Agent A" });
  await withFetch((url, init) => blank.route(url, init), async () => {
    const result = await submit();
    assert.equal(result.statusCode, 200);
    assert.deepEqual([blank.log.searches, blank.log.gets, blank.log.puts], [1, 1, 1]);
  });
  const foreign = lark({ rows: [caRow("rec1", "")], recordOwner: "Agent B" });
  await withFetch((url, init) => foreign.route(url, init), async () => {
    assert.equal((await submit()).statusCode, 409);
    assert.equal(foreign.log.puts, 0);
  });
  assert.deepEqual(reasonDelta(before), { blankOwner: 2 });
});

test("C: every fallback reason is counted: noUsername, noAgent, missing, searchError (plus blankOwner / otherOwner above)", async () => {
  initEnv({ ...ENV });
  const before = reasons();
  const fake = lark({ rows: [caRow("someone-else", "Agent B")] });
  await withFetch((url, init) => fake.route(url, init), async () => {
    await submit({ username: undefined });                        // noUsername
    await recordHandler({ body: JSON.stringify({ recordId: "rec1", agentName: " ", picName: "", username: "player1", inquiry: ["Others"], status: "Solved" }) }).catch(() => {});   // noAgent -> rejected earlier, no search
    await submit();                                               // missing (row not in the result)
  });
  const failing = lark({ searchFails: true });
  await withFetch((url, init) => failing.route(url, init), async () => { await submit(); });          // searchError
  const delta = reasonDelta(before);
  assert.equal(delta.noUsername, 1);
  assert.equal(delta.missing, 1);
  assert.equal(delta.searchError, 1);
  const direct = await withFetchValue(() => readOwnershipMerged("rec1", "player1", ""), (url, init) => lark({ rows: [] }).route(url, init));
  assert.equal(direct.via, "get");
  assert.equal(reasonDelta(before).noAgent, 1, "no agent name -> never decided from the search");
});
async function withFetchValue(run, route) { let value; await withFetch(route, async () => { value = await run(); }); return value; }

test("C: unclaim and linkOnly use the same rule (owner in the search = me -> one search, no GET; anything else -> GET decides)", async () => {
  initEnv({ ...ENV });
  for (const body of [{ unclaim: true }, { linkOnly: true }]) {
    const other = lark({ rows: [caRow("rec1", "Agent B")], recordOwner: "Agent B" });
    await withFetch((url, init) => other.route(url, init), async () => {
      const result = await recordHandler({ body: JSON.stringify({ recordId: "rec1", agentName: "Agent A", username: "player1", chatLink: "https://x/y", ...body }) });
      assert.equal(result.statusCode, 409);
      assert.equal(other.log.puts, 0);
    });
    const mine = lark({ rows: [caRow("rec1", "Agent A")] });
    await withFetch((url, init) => mine.route(url, init), async () => {
      const result = await recordHandler({ body: JSON.stringify({ recordId: "rec1", agentName: "Agent A", username: "player1", chatLink: "https://x/y", ...body }) });
      assert.equal(result.statusCode, 200);
      assert.deepEqual([mine.log.searches, mine.log.gets], [1, 0]);
    });
  }
});

test("C: readOwnershipMerged answers from the search ONLY for this agent's own row (owner and blank flag from the projected columns)", async () => {
  initEnv({ ...ENV });
  const fake = lark({ rows: [caRow("rec1", "Agent A", { Status: "Solved" }), caRow("rec2", "Agent A"), caRow("rec3", "Agent B")], recordOwner: "Agent B" });
  await withFetch((url, init) => fake.route(url, init), async () => {
    assert.deepEqual(await readOwnershipMerged("rec1", "player1", "Agent A"), { owner: "Agent A", blank: false, via: "search" });
    assert.deepEqual(await readOwnershipMerged("rec2", "player1", "Agent A"), { owner: "Agent A", blank: true, via: "search" });
    const other = await readOwnershipMerged("rec3", "player1", "Agent A");
    assert.equal(other.via, "get");
    assert.equal(other.owner, "Agent B");
  });
});

// ---- instrumentation: counters the Pages side reports to the queue -------------------------------------------------
test("3a: noted counters are sent to the queue's reportCounters once, with safe names; failures, a missing method and a hung queue are ignored", async () => {
  const reports = [];
  const stub = makeStub({ reportCounters: async (report) => { reports.push(report); } });
  initEnv(queueEnv(stub));
  await flushCounters(); reports.length = 0;                      // counters left over from earlier tests
  noteCounter("queueCallFallback");
  noteCounter("ownershipFallback:missing", 3);
  noteCounter("lookupWarning:Custom bonus x y!");
  await flushCounters();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], { queueCallFallback: 1, "ownershipFallback:missing": 3, "lookupWarning:Custom_bonus_x_y_": 1 });
  await flushCounters();
  assert.equal(reports.length, 1, "nothing left to send");

  noteCounter("a");
  initEnv(queueEnv(makeStub({ reportCounters: undefined })));
  await flushCounters();                                          // the method is missing: dropped quietly
  noteCounter("b");
  initEnv(queueEnv(makeStub({ reportCounters: () => { throw new Error("boom"); } })));
  await flushCounters();
  noteCounter("c");
  initEnv(queueEnv(makeStub({ reportCounters: never })));
  const started = Date.now();
  await flushCounters();
  assert.ok(Date.now() - started < 2_000, "a hung queue delays the end of the request by at most ~1 s");
});

test("3a: the queue-side events are noted: requests without a start time, queue-call fallbacks, fail-open", async () => {
  const reports = [];
  const old = makeStub({ reportCounters: async (report) => { reports.push(report); } });
  delete old.larkCall;
  initEnv(queueEnv(old));
  await flushCounters();
  reports.length = 0;
  await withFetch(() => json({ code: 0, data: { record: { record_id: "r1", fields: {} } } }), async () => {
    await updateRecord("customer-table", "r1", {});                // no request context -> noRequestStart; larkCall missing -> fallback
  });
  await flushCounters();
  assert.ok(reports[0].noRequestStart >= 1, JSON.stringify(reports[0]));
  assert.equal(reports[0].queueCallFallback, 1);
  const source = (await import("node:fs")).readFileSync(new URL("./lark-search.js", import.meta.url), "utf8");
  assert.match(source, /noteCounter\("caseRowError"\)/);
  assert.match(source, /noteCounter\(`lookupWarning:\$\{source\}`\)/);
  assert.match(source, /noteCounter\("lookupHardDeadline"\)/);
  const adapt = (await import("node:fs")).readFileSync(new URL("./_lib/adapt.js", import.meta.url), "utf8");
  assert.match(adapt, /context\.waitUntil\?\.\(flushCounters\(\)\)/);
});

test("C: the widget sends the username with every record write (submit, edit, unclaim, link)", async () => {
  const app = (await import("node:fs")).readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.equal((app.match(/recordId: s\.caRecordId,\s+username: s\.username,\s+agentName: selectedAgent,/g) || []).length, 2, "both submit payloads");
  assert.match(app, /unclaim: true, agentName: selectedAgent, username: s\.username/);
  assert.match(app, /linkOnly: true, chatLink: s\.chatUrl, agentName: selectedAgent, username: s\.username/);
});

// ---- 4: batch updates are OFF unless LARK_BATCH_UPDATE=1 -------------------------------------------------------------
test("4: LARK_BATCH_UPDATE is off by default (updates use larkCall); on, they go to updateBatch; on with an older queue, they fall back to larkCall", async () => {
  const off = makeStub({ updateBatch: async () => ok({ record: { record_id: "r1", fields: {} } }) });
  initEnv(queueEnv(off));
  await withFetch(() => json({ code: 0, data: {} }), async () => { await updateRecord("customer-table", "r1", { Status: "Solved" }); });
  assert.equal(off.calls.filter((c) => c.name === "updateBatch").length, 0, "flag off: never");
  assert.equal(off.calls.filter((c) => c.name === "larkCall").length, 1);

  const on = makeStub({ updateBatch: async () => ok({ record: { record_id: "r1", fields: { Status: "Solved" } } }) });
  initEnv(queueEnv(on, { LARK_BATCH_UPDATE: "1" }));
  await withFetch(() => json({ code: 0, data: {} }), async () => {
    const record = await updateRecord("customer-table", "r1", { Status: "Solved" });
    assert.equal(record.fields.Status, "Solved");
  });
  assert.equal(on.calls.filter((c) => c.name === "updateBatch").length, 1);
  assert.equal(on.calls.filter((c) => c.name === "larkCall").length, 0);
  const sent = on.calls.find((c) => c.name === "updateBatch").args[0];
  assert.deepEqual([sent.method, sent.label], ["PUT", "update"]);
  assert.ok(sent.expiresAt > Date.now() + 60_000, "keeps the 90 s write deadline");

  const older = makeStub(); delete older.updateBatch;
  initEnv(queueEnv(older, { LARK_BATCH_UPDATE: "1" }));
  await withFetch(() => json({ code: 0, data: {} }), async () => { await updateRecord("customer-table", "r1", { Status: "Solved" }); });
  assert.equal(older.calls.filter((c) => c.name === "larkCall").length, 1, "an older queue still gets the write");

  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => on }, LARK_BATCH_UPDATE: "1" });          // no v2 protocol
  on.calls.length = 0;
  await withFetch(() => json({ code: 0, data: { record: { record_id: "r1", fields: {} } } }), async () => { await updateRecord("customer-table", "r1", {}); });
  assert.equal(on.calls.filter((c) => c.name === "updateBatch" || c.name === "larkCall").length, 0, "needs the v2 protocol");
});
