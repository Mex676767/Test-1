// node --no-warnings --test proposal/worker-v2/gate.test.mjs
// Behavioural tests for the proposed gate/batcher against the synthetic Lark.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeLark } from "../sim/fake-lark.mjs";
import { initEnv as initPagesEnv, searchRecords as pagesSearch } from "../../../functions/_lib/lark.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, `../sim/.build/do-test-${process.pid}.ts`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, fs.readFileSync(path.join(here, "index.ts"), "utf8")
  .replace(/import \{ DurableObject \} from "cloudflare:workers";/, "class DurableObject { constructor(c, e) { this.ctx = c; this.env = e; } }"));
const { MyDurableObject } = await import(pathToFileURL(outFile).href);

const URL_ = (t) => `https://open.larksuite.com/open-apis/bitable/v1/apps/base/tables/${t}/records/search?page_size=20`;
const req = (table, username, extra = {}, conds = null) => ({
  url: URL_(table), method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" },
  body: JSON.stringify({ filter: { conjunction: "and", conditions: conds || [
    { field_name: "Username/UID", operator: "is", value: [username] }, { field_name: "Brand", operator: "is", value: ["PP"] }] },
    field_names: ["Status"], ...extra }),
  expiresAt: Date.now() + 30_000,
});
const mkTable = (n, rowsPer = 2) => {
  const rows = [];
  for (let u = 0; u < n; u++) for (let r = 0; r < rowsPer; r++) for (const brand of ["PP", "MY"])
    rows.push({ record_id: `r-${u}-${r}-${brand}`, created_time: 1, fields: { "Username/UID": [{ text: `u${u}`, type: "text" }], Brand: brand, Status: `s${u}-${r}` } });
  return { rows, schema: new Set(["Username/UID", "Brand", "Status", "Agent Name", "Inquiry"]) };
};
async function setup({ tables, quota = 1000, median = 20, gap = 20, conc = 4, longpoll, limitStatus = 429, shuffleBatch = false, dropFromBatch = 0, hangAfterWrite = 0, env = {} }) {
  const lark = createFakeLark({ tables, medianMs: median, sigma: 0, quota, limitStatus, shuffleBatch, dropFromBatch, hangAfterWrite });
  const real = globalThis.fetch; globalThis.fetch = lark.fetch;
  const d = new MyDurableObject({}, { GATE_START_GAP_MS: gap, GATE_CONCURRENCY: conc, ...(longpoll ? { GATE_LONGPOLL_MS: longpoll } : {}), ...env });
  return { lark, d, done: () => { globalThis.fetch = real; } };
}
const rowsFor = (res) => JSON.parse(res.body).data.items;

test("batch-while-busy: 100 staggered same-table callers use few upstream queries and get only their own rows", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(100) }, gap: 60 });
  try {
    const out = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 3));               // spread over ~300 ms, far beyond a 25 ms window
      return { i, res: await d.searchBatch(req("t1", `u${i}`)) };
    }));
    for (const { i, res } of out) {
      assert.equal(res.status, 200);
      assert.deepEqual(rowsFor(res).map((r) => r.record_id).sort(), [`r-${i}-0-MY`, `r-${i}-0-PP`, `r-${i}-1-MY`, `r-${i}-1-PP`].sort());
    }
    assert.ok(lark.stats.search <= 12, `expected <=12 upstream searches, saw ${lark.stats.search}`);
  } finally { done(); }
});

test("gate never exceeds concurrency or start spacing, and serves waiters FIFO", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(5) }, gap: 40, conc: 2, median: 60 });
  try {
    const order = [], starts = [];
    const tickets = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i));            // deterministic arrival order
      const p = await d.acquire("read", `w${i}`); order.push(i); starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 30)); await d.release(p.ticket); return p.ticket;
    }));
    assert.equal(tickets.filter(Boolean).length, 8);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 30, "start spacing honoured (timer slack allowed)");
    assert.ok(lark.stats.peakInFlight <= 2);
  } finally { done(); }
});

test("expired callers are dropped before a query is built (cancelled lookups do not consume quota)", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(10) }, gap: 200 });
  try {
    const hold = d.acquire(); const hold2 = d.acquire(); const hold3 = d.acquire(); const hold4 = d.acquire(); // saturate the gate
    const dead = d.searchBatch({ ...req("t1", "u1"), expiresAt: Date.now() + 50 });
    setTimeout(async () => { for (const p of await Promise.all([hold, hold2, hold3, hold4])) if (p.ticket) await d.release(p.ticket); }, 300);
    const res = await dead;
    assert.equal(res.status, 504);
    assert.equal(lark.stats.search, 0, "no upstream query was issued for an expired waiter");
  } finally { done(); }
});

test("a normalisation mismatch (Lark matches case-insensitively) never drops rows: falls back to exact single queries", async () => {
  const t = mkTable(3);
  t.ci = true;
  t.rows.push({ record_id: "upper", created_time: 1, fields: { "Username/UID": [{ text: "U1", type: "text" }], Brand: "PP", Status: "x" } });
  const { d, done } = await setup({ tables: { t1: t } });
  try {
    const out = await Promise.all([0, 1, 2].map((i) => d.searchBatch(req("t1", `u${i}`))));
    for (const res of out) assert.equal(res.status, 200);
    assert.ok(rowsFor(out[1]).some((r) => r.record_id === "upper"), "the case-variant row Lark considers a match is not silently dropped");
    assert.ok(d.getStats().orphanFallbacks >= 1);
  } finally { done(); }
});

test("a merged result that fits the row cap is paged, not bisected (50 users x 120 rows = 12 pages)", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(40, 60) } });   // 40 users x 60 x 2 brands = 4800 rows
  try {
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) => d.searchBatch(req("t1", `u${i}`))));
    assert.ok(out.every((r) => r.status === 200 && rowsFor(r).length === 120));
    assert.equal(d.getStats().bisected, 0);
    assert.ok(lark.stats.search <= 11, `expected ~10 pages, saw ${lark.stats.search}`);
  } finally { done(); }
});

test("a result larger than the row cap is split using Lark's `total` before paging, and every caller is still answered", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(40, 150) } });   // 12,000 rows > 10,000 cap
  try {
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) => d.searchBatch(req("t1", `u${i}`))));
    assert.ok(out.every((r) => r.status === 200 && rowsFor(r).length === 300));
    assert.ok(d.getStats().bisected >= 1);
  } finally { done(); }
});

test("one 12,000-row username does not fail or slow the other 49; it is remembered and run solo afterwards", async () => {
  const t = mkTable(49, 2);
  for (let r = 0; r < 6000; r++) for (const brand of ["PP", "MY"])
    t.rows.push({ record_id: `heavy-${r}-${brand}`, created_time: 1, fields: { "Username/UID": [{ text: "heavy", type: "text" }], Brand: brand, Status: "x" } });
  const { lark, d, done } = await setup({ tables: { t1: t } });
  try {
    const users = ["heavy", ...Array.from({ length: 49 }, (_, i) => `u${i}`)];
    const out = await Promise.all(users.map((u) => d.searchBatch(req("t1", u))));
    assert.equal(out[0].status, 502, "the heavy user fails explicitly instead of returning a partial result");
    assert.ok(out.slice(1).every((r) => r.status === 200 && rowsFor(r).length === 4));
    assert.ok(lark.stats.search <= 30, `expected a bounded split, saw ${lark.stats.search} upstream searches`);
    assert.equal(d.getStats().heavyUsers, 1);
    const before = lark.stats.search;
    const again = await Promise.all([d.searchBatch(req("t1", "heavy")), d.searchBatch(req("t1", "u1"))]);
    assert.equal(again[1].status, 200);
    assert.ok(lark.stats.search - before <= 4, "the next batch does not repeat the expensive split");
  } finally { done(); }
});

test("a waiter that re-polls acquire() with the same id keeps its place in line (no starvation after the long-poll times out)", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 10, longpoll: 120 });
  try {
    const hold = await d.acquire("read", "hold");
    assert.ok(hold.ticket);
    const a1 = await d.acquire("write", "A");                  // times out while the gate is held
    assert.equal(a1.ticket, null);
    let bGranted = false;
    const bPromise = d.acquire("write", "B").then((p) => { bGranted = true; return p; });
    await new Promise((r) => setTimeout(r, 30));
    await d.release(hold.ticket);                              // frees the slot: A is older than B
    const a2 = await d.acquire("write", "A");
    assert.ok(a2.ticket, "A is served first after re-polling");
    assert.equal(bGranted, false, "B did not jump ahead of A");
    await d.release(a2.ticket);
    assert.ok((await bPromise).ticket);
  } finally { done(); }
});

test("token outranks read outranks a fresh write, and a write that has waited past the aging window is served before a newer read", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 5, longpoll: 10_000 });
  try {
    const run = async (arrivals, waitBeforeLast = 0) => {
      const hold = await d.acquire("read", "hold-" + Math.random());
      const order = [];
      const jobs = [];
      for (const [kind, id, delay] of arrivals) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        jobs.push(d.acquire(kind, id).then(async (p) => { order.push(id); await d.release(p.ticket); }));
      }
      await d.release(hold.ticket);
      await Promise.all(jobs);
      return order;
    };
    assert.deepEqual(await run([["write", "w", 0], ["read", "r", 20], ["token", "t", 0]]), ["t", "r", "w"], "fresh write yields to reads and tokens");
    assert.deepEqual(await run([["write", "w", 0], ["read", "r", 3_200], ["token", "t", 0]]), ["t", "w", "r"], "an aged write is not starved by a newer read");
  } finally { done(); }
});

test("deadline is checked before every 429 retry: an expired caller stops consuming quota", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(2) }, quota: 0, gap: 20 });
  try {
    const res = await d.searchBatch({ ...req("t1", "u1"), expiresAt: Date.now() + 200 });
    assert.ok([429, 504].includes(res.status));
    assert.ok(lark.stats.search <= 3, `saw ${lark.stats.search} upstream attempts`);
  } finally { done(); }
});

for (const status of [200, 400]) {
  test(`code 1254290 with HTTP ${status} is honoured as a rate limit (cooldown + spacing backoff)`, async () => {
    const { d, done } = await setup({ tables: { t1: mkTable(2) }, quota: 0, gap: 10, limitStatus: status });
    try {
      const res = await d.searchBatch(req("t1", "u1"));
      assert.equal(JSON.parse(res.body).code, 1254290, "the caller still sees the throttle, never an empty success");
      assert.ok(d.getStats().limited >= 1, "treated as rate limited");
      assert.ok(d.getStats().gapMs > 10, "start spacing backed off");
    } finally { done(); }
  });
}

test("usernames that differ only by case are never co-batched", async () => {
  const t = mkTable(3);
  t.ci = true;
  t.rows.push({ record_id: "upper", created_time: 1, fields: { "Username/UID": [{ text: "U1", type: "text" }], Brand: "PP", Status: "x" } });
  const { lark, d, done } = await setup({ tables: { t1: t } });
  try {
    const [lower, upper] = await Promise.all([d.searchBatch(req("t1", "u1")), d.searchBatch(req("t1", "U1"))]);
    const lowerIds = rowsFor(lower).map((r) => r.record_id), upperIds = rowsFor(upper).map((r) => r.record_id);
    assert.ok(lowerIds.includes("upper") && upperIds.includes("upper"), "each variant still receives the row Lark matches for it");
    assert.ok(lark.stats.search >= 2, "they were queried separately");
  } finally { done(); }
});

test("repeated attribution mismatches switch batching off for that table", async () => {
  const t = mkTable(6);
  t.ci = true;
  for (let u = 0; u < 6; u++) t.rows.push({ record_id: `up${u}`, created_time: 1, fields: { "Username/UID": [{ text: `U${u}`, type: "text" }], Brand: "PP", Status: "x" } });
  const { d, done } = await setup({ tables: { t1: t } });
  try {
    for (let u = 0; u < 4; u++) await d.searchBatch(req("t1", `u${u}`));
    assert.ok(d.getStats().noBatchTrips >= 1, "kill switch tripped after repeated mismatches");
  } finally { done(); }
});

test("statistics buffers are bounded", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) } });
  try {
    const buf = [];
    for (let i = 0; i < 5_000; i++) d.sample(buf, i);
    assert.ok(buf.length <= 2_000);
  } finally { done(); }
});

test("Brand predicates survive Lark's field shapes through the whole DO->Pages split (text array, string, formula wrapper)", async () => {
  const t = { rows: [], schema: new Set(["Username/UID", "Brand", "Status"]) };
  const shapes = [[{ text: "PP", type: "text" }], "PP", { type: 1, value: [{ text: "PP", type: "text" }] }];
  shapes.forEach((brand, i) => t.rows.push({ record_id: `s${i}`, created_time: 1, fields: { "Username/UID": [{ text: "u1", type: "text" }], Brand: brand, Status: "x" } }));
  const { d, done } = await setup({ tables: { t1: t } });
  try {
    const res = await d.searchBatch({ ...req("t1", "u1", {}, [{ field_name: "Username/UID", operator: "is", value: ["u1"] }]), });
    assert.equal(rowsFor(res).length, 3, "all rows for the username come back; Brand filtering happens in the Pages matcher");
  } finally { done(); }
});

test("sustained 429s return an explicit failure to every caller after bounded retries", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(4) }, quota: 0 });
  try {
    const out = await Promise.all([0, 1, 2, 3].map((i) => d.searchBatch(req("t1", `u${i}`))));
    assert.ok(out.every((r) => r.status === 429), "callers see the 429, never an empty success");
    assert.ok(lark.stats.search <= 3 * 1 + 1, `bounded retries, saw ${lark.stats.search} upstream attempts`);
  } finally { done(); }
});

test("wide predicates with a column projection are merged into one query; each caller still gets that user's rows to re-filter", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(6) } });
  try {
    const wide = (u) => req("t1", u, {}, [{ field_name: "Username/UID", operator: "is", value: [u] },
      { field_name: "Agent Name", operator: "is", value: ["a"] }, { field_name: "Inquiry", operator: "isEmpty", value: [] }]);
    const out = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => d.searchBatch(wide(`u${i}`))));
    assert.equal(lark.stats.search, 1, "six lookups became one upstream query");
    out.forEach((res, i) => assert.deepEqual(rowsFor(res).map((r) => r.record_id).sort(),
      [`r-${i}-0-MY`, `r-${i}-0-PP`, `r-${i}-1-MY`, `r-${i}-1-PP`].sort()));
  } finally { done(); }
});

test("wide predicates WITHOUT a projection stay exact (a merge could drag whole row histories)", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(6) } });
  try {
    const wide = (u) => req("t1", u, { field_names: [] }, [{ field_name: "Username/UID", operator: "is", value: [u] },
      { field_name: "Agent Name", operator: "is", value: ["a"] }, { field_name: "Inquiry", operator: "isEmpty", value: [] }]);
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => d.searchBatch(wide(`u${i}`))));
    assert.equal(lark.stats.orQueries, 0);
    assert.equal(lark.stats.search, 6);
  } finally { done(); }
});

test("queries that differ only in automatic_fields share one merged query", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(4) } });
  try {
    const out = await Promise.all([d.searchBatch(req("t1", "u0", { automatic_fields: true })), d.searchBatch(req("t1", "u1")), d.searchBatch(req("t1", "u2", { automatic_fields: true }))]);
    assert.equal(lark.stats.search, 1);
    assert.ok(rowsFor(out[0]).every((r) => r.created_time !== undefined), "created_time requested because one caller needed it");
  } finally { done(); }
});

test("legacy bare acquire() (current Pages code) never holds the call past its 250 ms RPC timeout and never leaks a slot", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 5 });
  try {
    const first = await d.acquire();                       // gate free: granted immediately
    assert.ok(first.ticket);
    const startedAt = Date.now();
    const second = await d.acquire();                      // gate saturated: must answer "retry", fast
    assert.equal(second.ticket, null);
    assert.ok(second.retryAfterMs > 0);
    assert.ok(Date.now() - startedAt < 250, "answers inside the legacy client's RPC timeout");
    await d.release(first.ticket);
    const third = await d.acquire();                       // the cancelled waiter must not be holding the slot
    assert.ok(third.ticket, "no slot leaked by the timed-out legacy waiter");
    await d.release(third.ticket);
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

// ---- batched creates -----------------------------------------------------------------
const createReq = (table, fields) => ({
  url: `https://open.larksuite.com/open-apis/bitable/v1/apps/base/tables/${table}/records`, method: "POST",
  headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ fields }),
  expiresAt: Date.now() + 30_000,
});
const caTable = () => ({ rows: [], schema: new Set(["Username", "Brand", "Agent Name", "link"]) });
const caFields = (i) => ({ Username: `player${i}`, Brand: i % 2 ? "MY" : "PP", "Agent Name": `Agent ${i % 3}`, link: { link: `https://my.livechatinc.com/chats/C${i}/T${i}`, text: `https://my.livechatinc.com/chats/C${i}/T${i}` } });
const recordOf = (res) => JSON.parse(res.body).data.record;

test("many concurrent creates become a few batch_create calls and every caller gets its OWN record, even when Lark returns them reversed", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTable() }, shuffleBatch: true, gap: 40, conc: 2 });
  try {
    const out = await Promise.all(Array.from({ length: 30 }, (_, i) => d.createBatch(createReq("ca", caFields(i)))));
    out.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(recordOf(res).fields.Username, `player${i}`, "caller received the row created from its own fields");
    });
    assert.ok(lark.stats.batchCreate + lark.stats.create <= 4, `expected a few upstream writes, saw ${lark.stats.batchCreate + lark.stats.create}`);
    assert.equal(new Set(out.map((r) => recordOf(r).record_id)).size, 30, "no record id handed to two callers");
  } finally { done(); }
});

test("a lone create is an ordinary create (no batch_create)", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTable() } });
  try {
    const res = await d.createBatch(createReq("ca", caFields(1)));
    assert.equal(recordOf(res).fields.Username, "player1");
    assert.equal(lark.stats.create, 1);
    assert.equal(lark.stats.batchCreate || 0, 0);
  } finally { done(); }
});

test("if batch_create returns fewer rows than callers, everyone gets an error instead of a guessed record", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() }, dropFromBatch: 1 });
  try {
    const out = await Promise.all([1, 2, 3].map((i) => d.createBatch(createReq("ca", caFields(i)))));
    assert.ok(out.every((r) => r.status === 502), "fail closed");
    assert.equal(d.getStats().createMismatches, 1);
  } finally { done(); }
});

test("two identical creates WITHOUT a chat link (could be two chats) still get two separate rows", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() }, shuffleBatch: true });
  try {
    const { link, ...noLink } = caFields(5);
    const out = await Promise.all([d.createBatch(createReq("ca", noLink)), d.createBatch(createReq("ca", noLink))]);
    assert.ok(out.every((r) => r.status === 200));
    assert.notEqual(recordOf(out[0]).record_id, recordOf(out[1]).record_id);
  } finally { done(); }
});

test("a Lark error on batch_create is returned to every caller unchanged", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() }, quota: 0 });
  try {
    const out = await Promise.all([1, 2].map((i) => d.createBatch(createReq("ca", caFields(i)))));
    assert.ok(out.every((r) => JSON.parse(r.body).code === 1254290));
  } finally { done(); }
});

test("creates outrank nothing: reads that arrived within the aging window are served first, but creates are never starved", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTable(), t1: mkTable(2) }, conc: 1, gap: 10 });
  try {
    const hold = await d.acquire("read", "hold");
    const create = d.createBatch(createReq("ca", caFields(1)));
    const reads = Array.from({ length: 5 }, (_, i) => d.searchBatch(req("t1", `u${i % 2}`)));
    await d.release(hold.ticket);
    const [c] = await Promise.all([create, ...reads]);
    assert.equal(c.status, 200);
    assert.ok(lark.stats.create + (lark.stats.batchCreate || 0) >= 1);
  } finally { done(); }
});

// ---- review fixes: paging, pruning, write priority ----------------------------------------------
test("a request that already carries a page_token is never merged (it would restart at page 1)", async () => {
  const { lark, d, done } = await setup({ tables: { t1: mkTable(3) } });
  try {
    const paged = req("t1", "u1");
    paged.url += "&page_token=500";
    const res = await d.searchBatch(paged);
    assert.equal(res.status, 200);
    assert.equal(lark.stats.orQueries, 0, "sent exactly as the caller built it, not as an OR query");
    assert.equal(res.headers.some(([k]) => k === "x-lark-batched"), false);
  } finally { done(); }
});

test("orphan fallback with more than 500 rows for one user: the caller gets every record exactly once", async () => {
  const t = { ci: true, schema: new Set(["Username/UID", "Brand", "Status"]), rows: [] };
  for (let i = 0; i < 700; i++) t.rows.push({ record_id: `r${i}`, created_time: 1, fields: { "Username/UID": [{ text: "U1", type: "text" }], Brand: "PP", Status: `s${i}` } });
  const { lark, d, done } = await setup({ tables: { t1: t } });
  try {
    const stub = { acquire: (...a) => d.acquire(...a), release: (...a) => d.release(...a), penalize: (...a) => d.penalize(...a),
      searchBatch: (r) => d.searchBatch(r), createBatch: (r) => d.createBatch(r) };
    initPagesEnv({ LARK_APP_ID: "page-token-app", LARK_APP_SECRET: "s", LARK_BASE_APP_TOKEN: "base", LARK_QUEUE_PROTOCOL: "v2",
      LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub } });
    const rows = await pagesSearch("t1", [
      { field_name: "Username/UID", operator: "is", value: ["u1"] }, { field_name: "Brand", operator: "is", value: ["PP"] },
    ], undefined, { fieldNames: ["Status"], timeoutMs: 10_000 });
    assert.equal(rows.length, 700);
    assert.equal(new Set(rows.map((r) => r.record_id)).size, 700, "no record twice");
    assert.equal(d.getStats().orphanFallbacks, 1, "the page-2 request did not trigger a second merge + fallback");
    assert.ok(lark.stats.search <= 4, `saw ${lark.stats.search} upstream searches`);
  } finally { done(); }
});

test("expired heavy / kill-switch / orphan-strike entries are deleted when read and swept periodically", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(3) } });
  try {
    const past = Date.now() - 1_000;
    d.heavy.set("k|someone", past); d.noBatchUntil.set("k", past); d.orphanStrikes.set("k", { n: 1, first: past - 120_000 });
    d.pruneExpired();
    assert.deepEqual(d.getMapSizes(), { heavy: 0, noBatch: 0, orphanStrikes: 0 });
    // swept automatically as searches flow, without an explicit call
    d.heavy.set("k|someone", past); d.noBatchUntil.set("k", past); d.orphanStrikes.set("k", { n: 1, first: past - 120_000 });
    for (let i = 0; i < 50; i++) await d.searchBatch(req("t1", `u${i % 3}`));
    assert.deepEqual(d.getMapSizes(), { heavy: 0, noBatch: 0, orphanStrikes: 0 });
    // a live entry survives the sweep
    d.heavy.set("k|someone", Date.now() + 60_000); d.pruneExpired();
    assert.equal(d.getMapSizes().heavy, 1);
  } finally { done(); }
});

test("a create retried after a 429 keeps WRITE priority (not demoted to the read class)", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTable() }, gap: 10 });
  try {
    const realFetch = globalThis.fetch;
    let creates = 0;
    globalThis.fetch = async (url, init = {}) => {
      if (new URL(String(url)).pathname.endsWith("/records") && init.method === "POST" && ++creates === 1) {
        return new Response(JSON.stringify({ code: 1254290, msg: "TooManyRequest" }), { status: 429 });
      }
      return realFetch(url, init);
    };
    const res = await d.createBatch(createReq("ca", caFields(1)));
    assert.equal(res.status, 200);
    const stats = d.getStats();
    assert.equal(stats.startsByClass.write, 2, "first attempt and the 429 retry were both write-class starts");
    assert.equal(stats.startsByClass.read, 0);
    assert.equal(stats.retries429, 1);
  } finally { done(); }
});

// ======================================================================================
// Step 0: diagnostics -- permit wait/hold per class and Lark latency per call type
// ======================================================================================
test("getStats reports permit wait and hold per class, and Lark latency per call type", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(3), ca: caTable() }, conc: 1, gap: 5, median: 15 });
  try {
    const first = await d.acquire("write", "w1");
    const second = d.acquire("write", "w2");                       // has to wait for the first to be released
    await new Promise((r) => setTimeout(r, 80));
    await d.release(first.ticket);                                  // first held the slot ~80 ms
    const got = await second;
    await new Promise((r) => setTimeout(r, 30));
    await d.release(got.ticket);
    await d.searchBatch(req("t1", "u1"));
    await d.createBatch(createReq("ca", caFields(1)));
    const { permits, lark } = d.getStats();
    assert.equal(permits.write.wait.n >= 2, true);
    assert.ok(permits.write.wait.max >= 70, `second writer waited for the first (saw ${permits.write.wait.max} ms)`);
    assert.ok(permits.write.hold.max >= 70, `ticket hold covers the caller's whole call (saw ${permits.write.hold.max} ms)`);
    assert.ok(permits.read.hold.n >= 1 && permits.read.wait.n >= 1, "the merged search is a read-class permit");
    assert.equal(permits.token.wait.n, 0, "classes that were not used stay empty");
    assert.ok(lark.search.n >= 1 && lark.search.p50 >= 10, "search latency recorded");
    assert.ok(lark.create.n + lark.batchCreate.n >= 1, "create latency recorded");
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

test("the new sample arrays are bounded", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) } });
  try {
    for (let i = 0; i < 2600; i++) { d.sample(d.m.waitMs.read, i); d.sample(d.m.holdMs.write, i); d.sample(d.m.larkMs.search, i); }
    assert.ok(d.m.waitMs.read.length <= 2000 && d.m.holdMs.write.length <= 2000 && d.m.larkMs.search.length <= 2000);
    assert.equal(d.getStats().permits.read.wait.n, 2000);
  } finally { done(); }
});

test("a held slot is given back when the caller's deadline has already passed before the first page (it used to leak)", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 2 });
  try {
    const grant = await d.acquireSlot("read").promise;
    assert.equal(d.getStats().active, 1);
    let answer;
    const waiter = { input: req("t1", "u0"), body: JSON.parse(req("t1", "u0").body), usernameField: "Username/UID", username: "u0",
      expiresAt: Date.now() - 1, enqueuedAt: Date.now(), resolve: (r) => { answer = r; } };
    await d.execute("k", [["u0", [waiter]]], Date.now(), 0, grant);
    assert.equal(answer.status, 504);
    assert.equal(d.getStats().active, 0, "slot released");
  } finally { done(); }
});

// ======================================================================================
// Step 2: identical creates share ONE row
// ======================================================================================
test("two identical creates (same table + fields) at the same moment make ONE row and return the SAME record id", async () => {
  const tables = { ca: caTable() };
  const { lark, d, done } = await setup({ tables });
  try {
    const out = await Promise.all([d.createBatch(createReq("ca", caFields(7))), d.createBatch(createReq("ca", caFields(7)))]);
    assert.ok(out.every((r) => r.status === 200));
    assert.equal(recordOf(out[0]).record_id, recordOf(out[1]).record_id);
    assert.equal(tables.ca.rows.length, 1, "one row in Lark");
    assert.equal((lark.stats.create || 0) + (lark.stats.batchCreate || 0), 1, "one Lark call");
    assert.equal(d.getStats().createSharedInflight, 1);
  } finally { done(); }
});

test("a repeat of an identical create within the memory window is answered with NO Lark call", async () => {
  const tables = { ca: caTable() };
  const { lark, d, done } = await setup({ tables });
  try {
    const first = await d.createBatch(createReq("ca", caFields(3)));
    const callsBefore = lark.stats.calls;
    const again = await d.createBatch(createReq("ca", caFields(3)));
    assert.equal(recordOf(again).record_id, recordOf(first).record_id);
    assert.equal(lark.stats.calls, callsBefore, "no upstream call at all");
    assert.equal(tables.ca.rows.length, 1);
    assert.equal(d.getStats().createMemoryHits, 1);
  } finally { done(); }
});

test("different fields (or a different chat link) are separate rows, even in the same batch", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables });
  try {
    const out = await Promise.all([1, 2, 3].map((i) => d.createBatch(createReq("ca", caFields(i)))));
    assert.equal(new Set(out.map((r) => recordOf(r).record_id)).size, 3);
    const sameUserOtherChat = await d.createBatch(createReq("ca", { ...caFields(1), link: { link: "https://my.livechatinc.com/chats/OTHER/T9", text: "x" } }));
    assert.notEqual(recordOf(sameUserOtherChat).record_id, recordOf(out[0]).record_id);
    assert.equal(tables.ca.rows.length, 4);
  } finally { done(); }
});

test("the memory expires (CREATE_MEMORY_MS), and 0 switches it off", async () => {
  const short = await setup({ tables: { ca: caTable() }, env: { CREATE_MEMORY_MS: 60 } });
  try {
    const a = await short.d.createBatch(createReq("ca", caFields(4)));
    await new Promise((r) => setTimeout(r, 120));
    const b = await short.d.createBatch(createReq("ca", caFields(4)));
    assert.notEqual(recordOf(a).record_id, recordOf(b).record_id, "after the window a repeat is a genuinely new create");
  } finally { short.done(); }
  const off = await setup({ tables: { ca: caTable() }, env: { CREATE_MEMORY_MS: 0 } });
  try {
    const out = await Promise.all([off.d.createBatch(createReq("ca", caFields(4))), off.d.createBatch(createReq("ca", caFields(4)))]);
    assert.notEqual(recordOf(out[0]).record_id, recordOf(out[1]).record_id, "feature off = old behaviour");
  } finally { off.done(); }
});

test("forgetCreated(recordId): a row that was deleted or completed is never handed out again", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables });
  try {
    const first = await d.createBatch(createReq("ca", caFields(2)));
    await d.forgetCreated(recordOf(first).record_id);
    const next = await d.createBatch(createReq("ca", caFields(2)));
    assert.notEqual(recordOf(next).record_id, recordOf(first).record_id);
    await d.forgetCreated("not-a-known-id");                       // harmless
  } finally { done(); }
});

test("a failed create is not remembered: the next identical create really tries again", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables });
  try {
    const real = globalThis.fetch;
    let fail = true;
    globalThis.fetch = async (url, init = {}) => (fail && new URL(String(url)).pathname.endsWith("/records") && init.method === "POST"
      ? new Response(JSON.stringify({ code: 1254045, msg: "field not found" }), { status: 200 }) : real(url, init));
    const bad = await d.createBatch(createReq("ca", caFields(6)));
    assert.equal(JSON.parse(bad.body).code, 1254045);
    fail = false;
    const good = await d.createBatch(createReq("ca", caFields(6)));
    assert.equal(good.status, 200);
    assert.ok(recordOf(good).record_id);
    assert.equal(d.getStats().createMemoryHits, 0);
  } finally { done(); }
});

test("many identical pairs inside one burst: 10 chats x 2 callers = 10 rows, each pair sharing an id", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables, gap: 30, conc: 2 });
  try {
    const calls = [];
    for (let i = 0; i < 10; i++) calls.push(d.createBatch(createReq("ca", caFields(i))), d.createBatch(createReq("ca", caFields(i))));
    const out = await Promise.all(calls);
    for (let i = 0; i < 10; i++) assert.equal(recordOf(out[2 * i]).record_id, recordOf(out[2 * i + 1]).record_id, `pair ${i}`);
    assert.equal(new Set(out.map((r) => recordOf(r).record_id)).size, 10);
    assert.equal(tables.ca.rows.length, 10);
  } finally { done(); }
});

// ======================================================================================
// Step 3: client_token + one retry + 15 s write timeout
// ======================================================================================
const tokenOf = (url) => new URL(String(url)).searchParams.get("client_token");
function spyOnWrites() {
  const real = globalThis.fetch, writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const p = new URL(String(url)).pathname;
    if (init.method === "POST" && /\/records(\/batch_create)?$/.test(p)) writes.push({ path: p, token: tokenOf(url) });
    return real(url, init);
  };
  return writes;
}

test("every create (lone or batched) carries a client_token, and different batches get different tokens", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() }, gap: 10 });
  try {
    const writes = spyOnWrites();
    await d.createBatch(createReq("ca", caFields(1)));                                          // lone
    await Promise.all([2, 3, 4].map((i) => d.createBatch(createReq("ca", caFields(i)))));         // batched
    assert.ok(writes.length >= 2);
    for (const w of writes) assert.match(w.token || "", /^[0-9a-f-]{36}$/);
    assert.equal(new Set(writes.map((w) => w.token)).size, writes.length);
    assert.ok(writes.some((w) => w.path.endsWith("/batch_create")));
  } finally { done(); }
});

test("a batch that is written but times out is retried ONCE with the SAME token: exactly one row per caller", async () => {
  const tables = { ca: caTable() };
  const { lark, d, done } = await setup({ tables, hangAfterWrite: 1, env: { GATE_WRITE_TIMEOUT_MS: 150 }, gap: 10 });
  try {
    const writes = spyOnWrites();
    const out = await Promise.all([1, 2, 3].map((i) => d.createBatch(createReq("ca", caFields(i)))));
    out.forEach((res, i) => { assert.equal(res.status, 200); assert.equal(recordOf(res).fields.Username, `player${i + 1}`); });
    assert.equal(tables.ca.rows.length, 3, "exactly one row per caller, no duplicates");
    assert.equal(lark.stats.hung, 1);
    assert.equal(lark.stats.replays, 1, "the retry was recognised by its token");
    assert.equal(writes.length, 2);
    assert.equal(writes[0].token, writes[1].token, "same token on the retry");
    assert.equal(d.getStats().writeRetries, 1);
    assert.equal(d.getStats().active, 0, "no slot left held");
  } finally { done(); }
});

test("a lone create that is written but times out is retried once with the same token too", async () => {
  const tables = { ca: caTable() };
  const { lark, d, done } = await setup({ tables, hangAfterWrite: 1, env: { GATE_WRITE_TIMEOUT_MS: 150 } });
  try {
    const writes = spyOnWrites();
    const res = await d.createBatch(createReq("ca", caFields(9)));
    assert.equal(res.status, 200);
    assert.equal(tables.ca.rows.length, 1);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].token, writes[1].token);
    assert.equal(lark.stats.replays, 1);
  } finally { done(); }
});

test("a 5xx is retried once with the same token; a second failure is returned, not retried forever", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() } });
  try {
    const real = globalThis.fetch, seen = [];
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === "POST" && new URL(String(url)).pathname.endsWith("/records")) { seen.push(tokenOf(url)); return new Response("bad gateway", { status: 502 }); }
      return real(url, init);
    };
    const res = await d.createBatch(createReq("ca", caFields(1)));
    assert.equal(res.status, 502);
    assert.equal(seen.length, 2, "one attempt + one retry");
    assert.equal(seen[0], seen[1]);
    assert.equal(d.getStats().writeRetries, 1);
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

test("no retry for a normal Lark error answer, or when there is no time left", async () => {
  const a = await setup({ tables: { ca: caTable() } });
  try {
    const real = globalThis.fetch; let n = 0;
    globalThis.fetch = async (url, init = {}) => (init.method === "POST" && new URL(String(url)).pathname.endsWith("/records")
      ? (n++, new Response(JSON.stringify({ code: 1254068, msg: "URLFieldConvFail" }), { status: 200 })) : real(url, init));
    const res = await a.d.createBatch(createReq("ca", caFields(1)));
    assert.equal(JSON.parse(res.body).code, 1254068);
    assert.equal(n, 1, "an ordinary error answer is final");
  } finally { a.done(); }
  const b = await setup({ tables: { ca: caTable() }, hangAfterWrite: 5, env: { GATE_WRITE_TIMEOUT_MS: 100 } });
  try {
    const res = await b.d.createBatch({ ...createReq("ca", caFields(1)), expiresAt: Date.now() + 600 });
    assert.equal(res.status, 504);
    assert.ok(b.d.getStats().writeRetries <= 1);
  } finally { b.done(); }
});

test("writes get a 15 s upstream timeout, searches keep 6 s (checked in the source), and the write timeout is really applied", async () => {
  const source = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  assert.match(source, /const UPSTREAM_TIMEOUT_MS = 6_000;/);
  assert.match(source, /const WRITE_TIMEOUT_MS = 15_000;/);
  const { d, done } = await setup({ tables: { ca: caTable() }, hangAfterWrite: 1, env: { GATE_WRITE_TIMEOUT_MS: 120 } });
  try {
    const started = Date.now();
    const res = await d.createBatch(createReq("ca", caFields(1)));
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started >= 110 && Date.now() - started < 2_000, "gave up on the hung write at ~the configured write timeout, then retried");
  } finally { done(); }
});
