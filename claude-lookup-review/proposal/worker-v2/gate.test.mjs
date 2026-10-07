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
async function setup({ tables, quota = 1000, median = 20, gap = 20, conc = 4, longpoll, limitStatus = 429, shuffleBatch = false, dropFromBatch = 0, hangAfterWrite = 0, batchUpdateAtomic = true, env = {} }) {
  const lark = createFakeLark({ tables, medianMs: median, sigma: 0, quota, limitStatus, shuffleBatch, dropFromBatch, hangAfterWrite, batchUpdateAtomic });
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

// ======================================================================================
// Item A: the queue orders every step of a request by the request's START time
// ======================================================================================
const caRow = (id, fields = {}) => ({ record_id: id, created_time: 1, fields: { Username: "p", Brand: "PP", "Agent Name": "Agent A", ...fields } });
const recordUrl = (id, table = "ca") => `https://open.larksuite.com/open-apis/bitable/v1/apps/base/tables/${table}/records/${id}`;
const call = (method, id, extra = {}, body) => ({ url: recordUrl(id), method, headers: { authorization: "Bearer x", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), ...extra });
const caTableWith = (...rows) => ({ rows, schema: new Set(["Username", "Brand", "Agent Name", "link", "Inquiry", "Status"]) });

test("A: an older lookup's create runs before newer lookups' reads that were already waiting", async () => {
  const run = async (stamped) => {
    const { lark, d, done } = await setup({ tables: { ca: caTable(), t1: mkTable(2), t2: mkTable(2), t3: mkTable(2) }, conc: 1, gap: 20 });
    try {
      const base = Date.now();
      const hold = await d.acquire("read", "hold");                               // gate busy: everything below queues up
      const stamp = (ms) => (stamped ? { requestStartedAt: base + ms } : {});
      const newerReads = ["t1", "t2", "t3"].map((t, i) => d.searchBatch({ ...req(t, "u0"), ...stamp(1_000 + i) }));   // newer requests, waiting first
      await new Promise((r) => setTimeout(r, 10));
      const olderCreate = d.createBatch({ ...createReq("ca", caFields(1)), ...stamp(0) });                          // OLDER request's create, arrives later
      await new Promise((r) => setTimeout(r, 80));                                  // every bucket is now waiting at the gate
      await d.release(hold.ticket);
      await Promise.all([...newerReads, olderCreate]);
      return lark.stats.order.filter((k) => k !== "token");
    } finally { done(); }
  };
  const withAge = await run(true);
  assert.equal(withAge[0], "create", `the older request's create goes first (saw ${withAge.join(",")})`);
  const legacy = await run(false);
  assert.equal(legacy[0], "search", `without a request start the old behaviour (reads first) is unchanged (saw ${legacy.join(",")})`);
});

test("A: a submit's PUT runs before the GETs of newer submits that are still waiting (the request keeps its age)", async () => {
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  const { d, done } = await setup({ tables: { ca: caTableWith(...ids.map((id) => caRow(id))) }, conc: 1, gap: 20, median: 60 });
  try {
    const real = globalThis.fetch, seen = [];
    globalThis.fetch = async (url, init = {}) => {
      const m = new URL(String(url)).pathname.match(/\/records\/(r\d)$/);
      if (m) seen.push(`${init.method || "GET"} ${m[1]}`);
      return real(url, init);
    };
    const base = Date.now();
    const submit = async (id, startedAt) => {
      await d.larkCall(call("GET", id, { requestStartedAt: startedAt }));
      return d.larkCall(call("PUT", id, { requestStartedAt: startedAt }, { fields: { Status: "Solved" } }));
    };
    await Promise.all(ids.map((id, i) => submit(id, base + i * 100)));
    // A GET that was already granted when the PUT was queued may run first (that is one pipeline stage), but no submit
    // that is TWO or more positions younger may start its GET before this submit's PUT.
    for (let i = 0; i < ids.length - 2; i++) {
      const put = seen.indexOf(`PUT ${ids[i]}`);
      for (let j = i + 2; j < ids.length; j++) assert.ok(put < seen.indexOf(`GET ${ids[j]}`), `PUT ${ids[i]} before GET ${ids[j]} (order: ${seen.join(", ")})`);
    }
  } finally { done(); }
});

test("A (control): without a request start the same traffic is ordered by arrival, so PUTs wait behind later GETs", async () => {
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  const { d, done } = await setup({ tables: { ca: caTableWith(...ids.map((id) => caRow(id))) }, conc: 1, gap: 20, median: 60 });
  try {
    const real = globalThis.fetch, seen = [];
    globalThis.fetch = async (url, init = {}) => {
      const m = new URL(String(url)).pathname.match(/\/records\/(r\d)$/);
      if (m) seen.push(`${init.method || "GET"} ${m[1]}`);
      return real(url, init);
    };
    const submit = async (id) => { await d.larkCall(call("GET", id)); return d.larkCall(call("PUT", id, {}, { fields: { Status: "Solved" } })); };
    await Promise.all(ids.map((id) => submit(id)));
    assert.ok(seen.indexOf("PUT r1") > seen.indexOf("GET r5"), `un-stamped PUT r1 only after every GET (order: ${seen.join(", ")})`);
  } finally { done(); }
});

test("A: writes WITHOUT a request start keep the 3 s write delay; a legacy acquire() is unchanged", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 5 });
  try {
    const order = [];
    const hold = await d.acquire("read", "hold");
    const write = d.acquire("write", "w").then((p) => { order.push("write"); return p; });
    await new Promise((r) => setTimeout(r, 20));
    const read = d.acquire("read", "r").then((p) => { order.push("read"); return p; });   // arrived later, but writes wait 3 s
    await d.release(hold.ticket);
    const first = await Promise.race([write, read]);
    assert.equal(order[0], "read", "an un-stamped write is still delayed behind a read that arrived within 3 s");
    await d.release(first.ticket);
    const second = await Promise.all([write, read]);
    for (const p of second) if (p.ticket) await d.release(p.ticket).catch(() => {});
  } finally { done(); }
});

test("A: acquire() with a request start orders by it, and a stamped write is not delayed", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 5 });
  try {
    const base = Date.now();
    const order = [];
    const hold = await d.acquire("read", "hold");
    const newerRead = d.acquire("read", "newer", base + 500, "record-get").then((p) => { order.push("newer-read"); return p; });
    await new Promise((r) => setTimeout(r, 10));
    const olderWrite = d.acquire("write", "older", base, "update").then((p) => { order.push("older-write"); return p; });
    await d.release(hold.ticket);
    const first = await Promise.race([newerRead, olderWrite]);
    assert.equal(order[0], "older-write");
    await d.release(first.ticket);
    const rest = await Promise.all([newerRead, olderWrite]);
    for (const p of rest) if (p.ticket) await d.release(p.ticket).catch(() => {});
    assert.deepEqual({ ...d.getStats().labels }, { other: 1, "record-get": 1, update: 1 }, "the unlabelled hold counts as other");
  } finally { done(); }
});

// ======================================================================================
// Item B: record get / update / delete run INSIDE the DO
// ======================================================================================
test("B: larkCall holds the slot for Lark's latency only, and records latency per call type", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTableWith(caRow("r1")) }, median: 60, gap: 5 });
  try {
    const got = await d.larkCall(call("GET", "r1"));
    const put = await d.larkCall(call("PUT", "r1", {}, { fields: { Status: "Solved" } }));
    assert.equal(JSON.parse(got.body).data.record.record_id, "r1");
    assert.equal(JSON.parse(put.body).data.record.fields.Status, "Solved");
    const del = await d.larkCall(call("DELETE", "r1"));
    assert.equal(JSON.parse(del.body).code, 0);
    const { permits, lark: latency } = d.getStats();
    assert.ok(permits.write.hold.n === 2 && permits.write.hold.max >= 55 && permits.write.hold.max < 130, `write hold ${permits.write.hold.max} ms ~ Lark latency (60 ms)`);
    assert.ok(permits.read.hold.n === 1 && permits.read.hold.max < 130);
    assert.deepEqual([latency.get.n, latency.update.n, latency.delete.n], [1, 1, 1]);
    assert.ok(latency.update.p50 >= 55);
    assert.equal(lark.stats.get + lark.stats.update + lark.stats.delete, 3);
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

test("B: a write the DO accepted is applied exactly once even if the caller has gone away mid-queue", async () => {
  const tables = { ca: caTableWith(caRow("r1")) };
  const { lark, d, done } = await setup({ tables, conc: 1, gap: 10 });
  try {
    const hold = await d.acquire("read", "hold");                                 // the write has to queue
    void d.larkCall(call("PUT", "r1", { requestStartedAt: Date.now() }, { fields: { Status: "Solved", Inquiry: ["Others"] } }));   // nobody awaits it: the caller is gone
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lark.stats.update || 0, 0, "still queued");
    await d.release(hold.ticket);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lark.stats.update, 1, "applied once");
    assert.equal(tables.ca.rows[0].fields.Status, "Solved");
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

test("B: a timed-out / 5xx GET or PUT is retried once; a DELETE is not", async () => {
  const { d, done } = await setup({ tables: { ca: caTableWith(caRow("r1"), caRow("r2")) } });
  try {
    const real = globalThis.fetch; const seen = [];
    let fails = 1;
    globalThis.fetch = async (url, init = {}) => {
      const p = new URL(String(url)).pathname;
      if (/\/records\/r[12]$/.test(p)) { seen.push(init.method); if (fails > 0) { fails--; return new Response("bad gateway", { status: 502 }); } }
      return real(url, init);
    };
    const put = await d.larkCall(call("PUT", "r1", {}, { fields: { Status: "Solved" } }));
    assert.equal(put.status, 200);
    assert.deepEqual(seen, ["PUT", "PUT"]);
    seen.length = 0; fails = 1;
    const del = await d.larkCall(call("DELETE", "r2"));
    assert.equal(del.status, 502);
    assert.deepEqual(seen, ["DELETE"], "no second DELETE");
  } finally { done(); }
});

test("B: updating or deleting a row through the DO also drops it from the create memory", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables });
  try {
    const first = await d.createBatch(createReq("ca", caFields(2)));
    const id = recordOf(first).record_id;
    await d.larkCall(call("PUT", id, {}, { fields: { Status: "Solved" } }));
    const next = await d.createBatch(createReq("ca", caFields(2)));
    assert.notEqual(recordOf(next).record_id, id, "an updated row is not handed out again");
  } finally { done(); }
});

// ======================================================================================
// Item D: shared cached reads + permit labels
// ======================================================================================
const listFieldsUrl = "https://open.larksuite.com/open-apis/bitable/v1/apps/base/tables/ca/fields?page_size=100";
const fieldsCall = (extra = {}) => ({ url: listFieldsUrl, method: "GET", headers: { authorization: "Bearer x" }, cacheKey: "fields::ca", ttlMs: 300, staleMs: 10_000, label: "fields", ...extra });

test("D: a shared read is fetched once per TTL, shared between concurrent callers, and refreshed after it", async () => {
  const { lark, d, done } = await setup({ tables: { ca: caTable() }, gap: 5 });
  try {
    const [a, b, c] = await Promise.all([d.cachedCall(fieldsCall()), d.cachedCall(fieldsCall()), d.cachedCall(fieldsCall())]);
    assert.equal(lark.stats.fields, 1, "three concurrent callers share one Lark call");
    assert.equal(a.body, b.body);
    assert.equal(c.status, 200);
    await d.cachedCall(fieldsCall());
    assert.equal(lark.stats.fields, 1, "within the TTL: no Lark call");
    assert.equal(d.getStats().cacheHits, 1);
    await new Promise((r) => setTimeout(r, 350));
    await d.cachedCall(fieldsCall());
    assert.equal(lark.stats.fields, 2, "after the TTL: one refresh");
    await d.cachedCall(fieldsCall({ force: true }));
    assert.equal(lark.stats.fields, 3, "force skips the fresh copy");
    assert.equal(d.getStats().labels.fields, 3);
  } finally { done(); }
});

test("D: when Lark fails, the last good copy is served (within staleMs); failures are never cached", async () => {
  const { d, done } = await setup({ tables: { ca: caTable() }, gap: 5 });
  try {
    const real = globalThis.fetch; let broken = false;
    globalThis.fetch = async (url, init = {}) => (broken && /\/fields/.test(String(url)) ? new Response(JSON.stringify({ code: 1254290, msg: "TooManyRequest" }), { status: 200 }) : real(url, init));
    const good = await d.cachedCall(fieldsCall({ ttlMs: 50 }));
    await new Promise((r) => setTimeout(r, 80));
    broken = true;
    const served = await d.cachedCall(fieldsCall({ ttlMs: 50 }));
    assert.equal(served.body, good.body, "stale copy served while Lark is failing");
    assert.equal(d.getStats().cacheStaleServed, 1);
    const tooOld = await d.cachedCall(fieldsCall({ ttlMs: 50, staleMs: 10 }));
    assert.equal(JSON.parse(tooOld.body).code, 1254290, "past staleMs the failure is returned");
    broken = false;
    assert.equal((await d.cachedCall(fieldsCall({ ttlMs: 50 }))).status, 200, "and was not cached");
  } finally { done(); }
});

test("D: permit labels are counted per purpose; unknown or odd labels are grouped as 'other' and the set is bounded", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 2 });
  try {
    for (const label of ["token", "fields", "record-get", "update", "delete", "token"]) {
      const p = await d.acquire("write", `w-${label}-${Math.random()}`, Date.now(), label);
      await d.release(p.ticket);
    }
    const bad = await d.acquire("write", "bad", Date.now(), "Not A Label!!");
    await d.release(bad.ticket);
    assert.deepEqual(d.getStats().labels, { token: 2, fields: 1, "record-get": 1, update: 1, delete: 1, other: 1 });
    for (let i = 0; i < 40; i++) d.countLabel(`l-${i}`);
    assert.ok(Object.keys(d.getStats().labels).length <= 25);
  } finally { done(); }
});

// ======================================================================================
// Items A + B + C end to end: the real Pages code against the real DO and the fake Lark
// ======================================================================================
import { readOwnershipMerged } from "../../../functions/_lib/ca-row.js";
import { handler as recordHandler } from "../../../functions/lark-record.js";
import { runWithRequestStart as runWithRequestStartE2E } from "../../../functions/_lib/lark.js";

const pagesStub = (d) => {
  const stub = Object.fromEntries(["acquire", "release", "penalize", "searchBatch", "createBatch", "larkCall", "updateBatch", "cachedCall", "forgetCreated", "reportCounters"]
    .map((m) => [m, (...a) => d[m](...a)]));
  return { idFromName: () => "g", get: () => stub };
};
const e2eEnv = (d) => ({ LARK_APP_ID: "a", LARK_APP_SECRET: "s", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_CUSTOMER_APPROACHING: "ca",
  LARK_SEARCH_QUEUE: pagesStub(d), LARK_QUEUE_PROTOCOL: "v2" });
const caSchema = new Set(["Username", "Brand", "Agent Name", "link", "Inquiry", "Status", "Released amount", "Claim Secret", "Player D.O.B", "Telegram",
  "Query 1 Feedback (VS96 Feedback)", "Query 2 Feedback (VS96 Feedback)"]);
const fiftyRows = (agentFor = () => "Agent A") => Array.from({ length: 50 }, (_, i) => ({
  record_id: `rec${i}`, created_time: 1, fields: { Username: [{ text: `player${i}`, type: "text" }], Brand: "PP", "Agent Name": agentFor(i) } }));

test("C: 50 ownership checks at once cost at most 3 Lark searches (merged by the queue); rows that are mine are decided by the search, the others by a GET", async () => {
  const { lark, d, done } = await setup({ tables: { ca: { rows: fiftyRows((i) => (i % 5 === 0 ? "Agent B" : "Agent A")), schema: caSchema } }, gap: 20, conc: 3 });
  try {
    initPagesEnv(e2eEnv(d));
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => runWithRequestStartE2E(() => readOwnershipMerged(`rec${i}`, `Player${i}`, "Agent A"))));
    out.forEach((r, i) => {
      assert.equal(r.owner, i % 5 === 0 ? "Agent B" : "Agent A", `rec${i}`);
      assert.equal(r.via, i % 5 === 0 ? "get" : "search", `rec${i}: only this agent's own rows are decided from the search`);
    });
    assert.ok(lark.stats.search <= 3, `ownership searches: ${lark.stats.search}`);
    assert.equal(lark.stats.get, 10, "one GET for each of the 10 rows owned by someone else");
  } finally { done(); }
});

test("A+B+C: 50 whole submits through the real handler -> 3 or fewer searches, 50 updates, 0 GETs, every row right, foreign rows refused", async () => {
  const rows = fiftyRows((i) => (i === 7 ? "Agent B" : "Agent A"));
  const { lark, d, done } = await setup({ tables: { ca: { rows, schema: caSchema } }, gap: 20, conc: 3 });
  try {
    initPagesEnv(e2eEnv(d));
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => recordHandler({ body: JSON.stringify({
      recordId: `rec${i}`, username: `Player${i}`, agentName: "Agent A", brand: "PP", inquiry: ["Others"], status: i % 2 ? "Solved" : "Unsolved",
      chatLink: `https://my.livechatinc.com/chats/C${i}/T${i}`, telegram: false, claimSecret: false }) })));
    results.forEach((res, i) => assert.equal(res.statusCode, i === 7 ? 409 : 200, `submit ${i}`));
    assert.ok(lark.stats.search <= 3, `searches: ${lark.stats.search}`);
    assert.equal(lark.stats.update, 49, "every owned row updated exactly once; the foreign row untouched");
    assert.equal(lark.stats.get, 1, "only the foreign row needed a GET to be refused");
    rows.forEach((row, i) => {
      if (i === 7) { assert.equal(row.fields.Status, undefined, "another agent's row is never written"); return; }
      assert.equal(row.fields.Status, i % 2 ? "Solved" : "Unsolved");
      assert.deepEqual(row.fields.Inquiry, ["Others"]);
      assert.equal(row.fields["Agent Name"], "Agent A");
    });
    const stats = d.getStats();
    assert.equal(stats.lark.update.n, 49);
    assert.ok(stats.permits.write.hold.max < 150, "the slot is held for Lark's latency only (fake latency 20 ms)");
    assert.equal(stats.active, 0);
  } finally { done(); }
});

test("A: a Pages request stamps its start on all its steps, so an older submit finishes before a newer one's PUT is even asked for", async () => {
  const rows = fiftyRows();
  const { lark, d, done } = await setup({ tables: { ca: { rows, schema: caSchema } }, gap: 20, conc: 1, median: 40 });
  try {
    initPagesEnv(e2eEnv(d));
    const submit = (i) => recordHandler({ body: JSON.stringify({ recordId: `rec${i}`, username: `player${i}`, agentName: "Agent A", brand: "PP", inquiry: ["Others"], status: "Solved", chatLink: "https://x/y" }) });
    const finished = [];
    const run = [0, 1, 2, 3].map(async (i) => { await new Promise((r) => setTimeout(r, i * 5)); await submit(i); finished.push(i); });
    await Promise.all(run);
    assert.deepEqual(finished, [0, 1, 2, 3], "older submits complete first");
  } finally { done(); }
});

// ======================================================================================
// Follow-up 2: writes to the same record run one at a time, newest wins
// ======================================================================================
const putCall = (id, fields, extra = {}) => ({ url: recordUrl(id), method: "PUT", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ fields }), ...extra });
function spyOnPuts(id) {
  const real = globalThis.fetch, puts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "PUT" && String(url).endsWith(`/records/${id}`)) puts.push(JSON.parse(init.body).fields);
    return real(url, init);
  };
  return puts;
}

test("2: Unsolved then Solved for one record, both queued -> ONE Lark PUT, final value Solved, both callers get the answer", async () => {
  const tables = { ca: caTableWith(caRow("r1")) };
  const { lark, d, done } = await setup({ tables, conc: 1, gap: 20 });
  try {
    const hold = await d.acquire("read", "hold");                                // keep the gate busy so both writes queue
    const puts = spyOnPuts("r1");
    const first = d.larkCall(putCall("r1", { Status: "Unsolved", Inquiry: ["Others"] }));
    const second = d.larkCall(putCall("r1", { Status: "Solved" }));
    await new Promise((r) => setTimeout(r, 30));
    await d.release(hold.ticket);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(JSON.parse(a.body).data.record.fields.Status, "Solved");
    assert.equal(tables.ca.rows[0].fields.Status, "Solved", "latest submit wins");
    assert.deepEqual(tables.ca.rows[0].fields.Inquiry, ["Others"], "fields only the older write had are kept (same as applying them in order)");
    assert.equal(lark.stats.update, 1, "<= 2 PUTs, here exactly one");
    assert.equal(puts.length, 1);
    assert.equal(d.getStats().writesSuperseded, 1);
  } finally { done(); }
});

test("2: an older write already IN FLIGHT is never cancelled: the newer one runs after it, so the newer is applied last", async () => {
  const tables = { ca: caTableWith(caRow("r1")) };
  const { lark, d, done } = await setup({ tables, conc: 4, gap: 5, median: 80 });
  try {
    const puts = spyOnPuts("r1");
    const older = d.larkCall(putCall("r1", { Status: "Unsolved" }));
    await new Promise((r) => setTimeout(r, 30));                                  // the older PUT is now on its way to Lark
    const newer = d.larkCall(putCall("r1", { Status: "Solved" }));
    await Promise.all([older, newer]);
    assert.deepEqual(puts.map((p) => p.Status), ["Unsolved", "Solved"], "in order, newest last");
    assert.equal(tables.ca.rows[0].fields.Status, "Solved");
    assert.equal(lark.stats.update, 2);
    assert.equal(d.getStats().writesSuperseded, 0);
  } finally { done(); }
});

test("2: in flight + two newer queued -> the two newer merge into one write that runs after the in-flight one", async () => {
  const tables = { ca: caTableWith(caRow("r1")) };
  const { lark, d, done } = await setup({ tables, conc: 4, gap: 5, median: 80 });
  try {
    const puts = spyOnPuts("r1");
    const a = d.larkCall(putCall("r1", { Status: "Unsolved" }));
    await new Promise((r) => setTimeout(r, 30));
    const b = d.larkCall(putCall("r1", { Status: "Given", "Claim Secret": true }));
    const c = d.larkCall(putCall("r1", { Status: "Solved" }));
    await Promise.all([a, b, c]);
    assert.deepEqual(puts.map((p) => p.Status), ["Unsolved", "Solved"]);
    assert.equal(tables.ca.rows[0].fields["Claim Secret"], true, "merged with the newer value winning per field");
    assert.equal(lark.stats.update, 2);
    assert.equal(d.getStats().writesSuperseded, 1);
  } finally { done(); }
});

test("2: writes to DIFFERENT records are independent, and a failed write answers every waiter with the same error", async () => {
  const tables = { ca: caTableWith(caRow("r1"), caRow("r2")) };
  const { lark, d, done } = await setup({ tables, conc: 4, gap: 5 });
  try {
    await Promise.all([d.larkCall(putCall("r1", { Status: "Solved" })), d.larkCall(putCall("r2", { Status: "Solved" }))]);
    assert.equal(lark.stats.update, 2);
    assert.equal(d.getStats().writesSuperseded, 0);
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => (init.method === "PUT" ? new Response(JSON.stringify({ code: 1254045, msg: "field not found" }), { status: 200 }) : real(url, init));
    const [x, y] = await Promise.all([d.larkCall(putCall("r1", { Status: "A" })), d.larkCall(putCall("r1", { Status: "B" }))]);
    assert.equal(JSON.parse(x.body).code, 1254045);
    assert.equal(x.body, y.body);
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

test("2: the 90 s write deadline is kept (a queued write is dropped only after its own deadline) and a merged write uses the longest one", async () => {
  const { d, done } = await setup({ tables: { ca: caTableWith(caRow("r1")) }, conc: 1, gap: 5 });
  try {
    const hold = await d.acquire("read", "hold");
    const short = d.larkCall(putCall("r1", { Status: "A" }, { expiresAt: Date.now() + 150 }));
    const long = d.larkCall(putCall("r1", { Status: "B" }, { expiresAt: Date.now() + 90_000 }));
    await new Promise((r) => setTimeout(r, 250));                                 // past the short deadline
    await d.release(hold.ticket);
    const [a, b] = await Promise.all([short, long]);
    assert.equal(a.status, 200, "merged into the write that has the longer deadline");
    assert.equal(b.status, 200);
  } finally { done(); }
});

// ======================================================================================
// Follow-up 3: instrumentation
// ======================================================================================
test("3a: reportCounters adds up what Pages reports, rejects odd names, and bounds the set", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) } });
  try {
    await d.reportCounters({ queueCallFallback: 2, "ownershipFallback:missing": 3 });
    await d.reportCounters({ queueCallFallback: 1, "bad name!": 5, neg: -1, nan: "x", zero: 0 });
    assert.deepEqual(d.getStats().pagesCounters, { queueCallFallback: 3, "ownershipFallback:missing": 3 });
    for (let i = 0; i < 100; i++) await d.reportCounters({ [`n${i}`]: 1 });
    assert.ok(Object.keys(d.getStats().pagesCounters).length <= 66, "bounded (64 names + other)");
    assert.ok(d.getStats().pagesCounters.other > 0);
    await d.reportCounters(null);
    await d.reportCounters("junk");
  } finally { done(); }
});

test("3b: getStats reports when this queue instance started", async () => {
  const before = Date.now();
  const { d, done } = await setup({ tables: { t1: mkTable(1) } });
  try {
    const stats = d.getStats();
    assert.ok(Date.parse(stats.startedAt) >= before - 5 && Date.parse(stats.startedAt) <= Date.now());
    assert.ok(stats.uptimeSec >= 0);
  } finally { done(); }
});

test("3c: per-minute history: starts, 429s, queue-wait p95 and peak queue per minute, kept for 24 h, columnar", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(2) }, conc: 1, gap: 5, median: 5 });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const minute0 = Math.floor(Date.now() / 60_000);
    await Promise.all(Array.from({ length: 6 }, (_, i) => d.acquire("read", `a${i}`).then((p) => d.release(p.ticket))));
    offset += 60_000;                                                              // next minute
    const first = await d.acquire("read", "b0"); await d.release(first.ticket, true, 1);   // one 429
    offset += 3 * 60_000;
    const last = await d.acquire("read", "c0"); await d.release(last.ticket);
    const pm = d.getStats().perMinute;
    assert.deepEqual(Object.keys(pm).sort(), ["isolates", "limited", "limitedOther", "limitedSearch", "limitedWrite", "minutes", "peakQueue", "searchP95", "starts", "tokenStarts", "totalStarts", "updateP95", "waitP95"]);
    assert.equal(pm.minutes.length, pm.starts.length);
    const at = (m) => pm.minutes.indexOf(m);
    assert.equal(pm.starts[at(minute0)], 6);
    assert.ok(pm.waitP95[at(minute0)] > 0, "the queue wait of that minute was recorded");
    assert.ok(pm.peakQueue[at(minute0)] >= 3, "and its peak queue");
    assert.equal(pm.starts[at(minute0 + 1)], 1);
    assert.equal(pm.limited[at(minute0 + 1)], 1, "the 429 was counted in the minute it happened");
    assert.equal(pm.starts[at(minute0 + 4)], 1);
    assert.equal(at(minute0 + 2), -1, "idle minutes are not stored");
    // 24 h window: a day later the old minutes are gone, and the ring never grows past 1,440
    offset += 25 * 3_600_000;
    const later = await d.acquire("read", "d0"); await d.release(later.ticket);
    const after = d.getStats().perMinute;
    assert.ok(after.minutes.every((m) => m > Math.floor(Date.now() / 60_000) - 1440));
    assert.equal(after.minutes.includes(minute0), false);
    for (let i = 0; i < 1600; i++) { offset += 60_000; d.minuteNow().starts++; }      // 1,600 busy minutes in a row
    assert.ok(d.getStats().perMinute.minutes.length <= 1440);
  } finally { Date.now = realNow; done(); }
});

// ======================================================================================
// Follow-up 4: batch_update (OFF unless Pages calls updateBatch)
// ======================================================================================
const manyRows = (n) => Array.from({ length: n }, (_, i) => caRow(`b${i}`, { Username: `p${i}` }));
function spyOnBatchUpdates() {
  const real = globalThis.fetch, bodies = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST" && String(url).includes("/records/batch_update")) bodies.push(JSON.parse(init.body).records);
    return real(url, init);
  };
  return bodies;
}

test("4: many updates for different records share ONE batch_update, and every caller gets its OWN record with its OWN values", async () => {
  const tables = { ca: caTableWith(...manyRows(20)) };
  const { lark, d, done } = await setup({ tables, gap: 20, conc: 2 });
  try {
    const bodies = spyOnBatchUpdates();
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => d.updateBatch(putCall(`b${i}`, { Status: i % 2 ? "Solved" : "Unsolved", Inquiry: [`I${i}`] }, { requestStartedAt: Date.now() }))));
    out.forEach((res, i) => {
      assert.equal(res.status, 200);
      const record = JSON.parse(res.body).data.record;
      assert.equal(record.record_id, `b${i}`);
      assert.equal(record.fields.Status, i % 2 ? "Solved" : "Unsolved");
    });
    tables.ca.rows.forEach((row, i) => assert.deepEqual(row.fields.Inquiry, [`I${i}`]));
    assert.ok(lark.stats.batchUpdate <= 2, `batch_update calls: ${lark.stats.batchUpdate}`);
    assert.equal(lark.stats.update || 0, 0, "no single PUTs");
    assert.equal(bodies.flat().length, 20);
    const stats = d.getStats();
    assert.ok(stats.updateBatches >= 1 && stats.updatedInBatches === 20);
    assert.equal(stats.lark.batchUpdate.n, lark.stats.batchUpdate);
    assert.equal(stats.active, 0);
  } finally { done(); }
});

test("4: results are matched by record_id, not position (Lark may answer in any order)", async () => {
  const tables = { ca: caTableWith(...manyRows(6)) };
  const { d, done } = await setup({ tables, gap: 20, conc: 2 });
  try {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const res = await real(url, init);
      if (!String(url).includes("/records/batch_update")) return res;
      const body = await res.json();
      body.data.records.reverse();
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => d.updateBatch(putCall(`b${i}`, { Status: `S${i}` }, { requestStartedAt: Date.now() }))));
    out.forEach((res, i) => assert.equal(JSON.parse(res.body).data.record.fields.Status, `S${i}`));
  } finally { done(); }
});

test("4: two writes for ONE record inside a burst become one entry (newest wins); a write in flight is not cancelled and the newer goes in the next batch", async () => {
  const tables = { ca: caTableWith(...manyRows(4)) };
  const { lark, d, done } = await setup({ tables, gap: 20, conc: 2, median: 60 });
  try {
    const bodies = spyOnBatchUpdates();
    const hold = await d.acquire("read", "hold");
    const a1 = d.updateBatch(putCall("b0", { Status: "Unsolved" }, { requestStartedAt: Date.now() }));
    const a2 = d.updateBatch(putCall("b0", { Status: "Solved" }, { requestStartedAt: Date.now() }));
    const others = [1, 2, 3].map((i) => d.updateBatch(putCall(`b${i}`, { Status: "Given" }, { requestStartedAt: Date.now() })));
    await new Promise((r) => setTimeout(r, 40));
    await d.release(hold.ticket);
    await Promise.all([a1, a2, ...others]);
    assert.equal(bodies.flat().filter((r) => r.record_id === "b0").length, 1, "b0 appears once in the batch");
    assert.equal(tables.ca.rows[0].fields.Status, "Solved");
    assert.equal(d.getStats().writesSuperseded, 1);
    // a newer write that arrives while that batch is in flight goes AFTER it
    bodies.length = 0;
    const first = d.updateBatch(putCall("b1", { Status: "X1" }, { requestStartedAt: Date.now() }));
    const second = d.updateBatch(putCall("b2", { Status: "Y1" }, { requestStartedAt: Date.now() }));
    await new Promise((r) => setTimeout(r, 40));                                // the batch holding b1 and b2 is now in flight
    const later = d.updateBatch(putCall("b1", { Status: "X2" }, { requestStartedAt: Date.now() }));
    await Promise.all([first, second, later]);
    assert.equal(tables.ca.rows[1].fields.Status, "X2", "the newer write was applied last");
    assert.equal(tables.ca.rows[2].fields.Status, "Y1");
  } finally { done(); }
});

test("4: a transient failure is retried ONCE with the same body; a second failure goes to every caller (no endless retry)", async () => {
  const tables = { ca: caTableWith(...manyRows(5)) };
  const { d, done } = await setup({ tables, gap: 10, conc: 2 });
  try {
    const real = globalThis.fetch, seen = [];
    let fails = 1;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/records/batch_update")) { seen.push(init.body); if (fails > 0) { fails--; return new Response("bad gateway", { status: 502 }); } }
      return real(url, init);
    };
    const out = await Promise.all(Array.from({ length: 5 }, (_, i) => d.updateBatch(putCall(`b${i}`, { Status: "Solved" }, { requestStartedAt: Date.now() }))));
    assert.ok(out.every((r) => r.status === 200));
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], "the retry sent the same batch");
    seen.length = 0; fails = 5;
    const failing = await Promise.all(Array.from({ length: 5 }, (_, i) => d.updateBatch(putCall(`b${i}`, { Status: "Again" }, { requestStartedAt: Date.now() }))));
    assert.ok(failing.every((r) => r.status === 502));
    assert.equal(seen.length, 2, "one attempt + one retry, then the error is returned");
    assert.equal(d.getStats().active, 0);
  } finally { done(); }
});

// ---- batch_update against the REAL Lark behaviour (measured 2026-10-07, see LARK_BATCH_UPDATE_NOTES.md): errors are HTTP 200 + a code, the whole
// call is rejected and nothing is applied. 1254043 names the record in msg; field-value errors (1254061 NumberFieldConvFail) do not.
const fiftyUpdateRows = () => manyRows(50);
const fiftyCalls = (d, ids, fields = { Status: "Solved" }) => Promise.all(ids.map((id) => d.updateBatch(putCall(id, fields, { requestStartedAt: Date.now() }))));
const idsOf = (n) => Array.from({ length: n }, (_, i) => `b${i}`);

test("4 (real Lark): one ghost record_id in 50 -> only that caller fails (1254043), the other 49 are updated in a second batch call", async () => {
  const tables = { ca: caTableWith(...fiftyUpdateRows()) };
  const { lark, d, done } = await setup({ tables, gap: 10, conc: 2 });
  try {
    const bodies = spyOnBatchUpdates();
    const ids = idsOf(50); ids[23] = "ghost";
    const out = await fiftyCalls(d, ids);
    out.forEach((res, i) => {
      if (ids[i] === "ghost") { assert.equal(JSON.parse(res.body).code, 1254043); assert.match(JSON.parse(res.body).msg, /ghost/); }
      else { assert.equal(res.status, 200, ids[i]); assert.equal(JSON.parse(res.body).data.record.fields.Status, "Solved"); }
    });
    assert.equal(tables.ca.rows.filter((row) => row.fields.Status === "Solved").length, 49, "49 rows written, nothing for the ghost");
    assert.ok(lark.stats.batchUpdate <= 2, `batch_update calls: ${lark.stats.batchUpdate}`);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].length, 50); assert.equal(bodies[1].length, 49, "the rest went again as ONE batch");
    assert.ok(!bodies[1].some((r) => r.record_id === "ghost"));
    assert.equal(lark.stats.update || 0, 0, "no single PUTs");
    const stats = d.getStats();
    assert.equal(stats.updateRecordRejects, 1); assert.equal(stats.updateSplits, 0); assert.equal(stats.updateWholeCallErrors, 0);
    assert.equal(stats.active, 0);
  } finally { done(); }
});

test("4 (real Lark): several ghosts are peeled off one by one (each re-send removes at least one); everything else is updated", async () => {
  const tables = { ca: caTableWith(...fiftyUpdateRows()) };
  const { lark, d, done } = await setup({ tables, gap: 10, conc: 2 });
  try {
    const ids = idsOf(50); ids[3] = "ghostA"; ids[30] = "ghostB"; ids[44] = "ghostC";
    const out = await fiftyCalls(d, ids);
    out.forEach((res, i) => { if (ids[i].startsWith("ghost")) assert.equal(JSON.parse(res.body).code, 1254043); else assert.equal(res.status, 200); });
    assert.equal(tables.ca.rows.filter((row) => row.fields.Status === "Solved").length, 47);
    assert.ok(lark.stats.batchUpdate <= 4, `batch_update calls: ${lark.stats.batchUpdate}`);
    assert.equal(d.getStats().updateRecordRejects, 3);
  } finally { done(); }
});

test("4 (real Lark): one invalid field value in 50 (1254061, the record is NOT named) -> bisect isolates it; the other 49 are updated, the bad row is untouched", async () => {
  const tables = { ca: caTableWith(...fiftyUpdateRows()) };
  tables.ca.numberFields = ["Released amount"];
  tables.ca.schema.add("Released amount");
  const { lark, d, done } = await setup({ tables, gap: 10, conc: 4 });
  try {
    const bodies = spyOnBatchUpdates();
    const ids = idsOf(50);
    const out = await Promise.all(ids.map((id, i) => d.updateBatch(putCall(id, { Status: "Solved", "Released amount": i === 31 ? "twelve dollars" : 10 + i }, { requestStartedAt: Date.now() }))));
    out.forEach((res, i) => {
      if (i === 31) { assert.equal(JSON.parse(res.body).code, 1254061, "only the bad record's caller gets Lark's error"); assert.doesNotMatch(res.body, /b31/); }
      else { assert.equal(res.status, 200, ids[i]); assert.equal(JSON.parse(res.body).code, 0); }
    });
    tables.ca.rows.forEach((row, i) => {
      if (i === 31) { assert.equal(row.fields.Status, undefined); assert.equal(row.fields["Released amount"], undefined, "the bad row is untouched"); }
      else { assert.equal(row.fields.Status, "Solved"); assert.equal(row.fields["Released amount"], 10 + i); }
    });
    const stats = d.getStats();
    assert.ok(stats.updateSplits >= 1 && stats.updateSplits <= 7, `splits: ${stats.updateSplits}`);
    assert.equal(stats.updateRecordRejects, 0, "1254061 has no record id to shortcut on");
    assert.equal(stats.updateWholeCallErrors, 0);
    assert.ok(lark.stats.batchUpdate <= 13, `bisect stayed cheap: ${lark.stats.batchUpdate} batch calls + ${lark.stats.update || 0} single PUT`);
    assert.ok(bodies[0].length === 50 && bodies.slice(1).every((records) => records.length < 50));
    assert.equal(stats.active, 0);
  } finally { done(); }
});

for (const [label, reply] of [
  ["invalid tenant token 99991663", { code: 99991663, msg: "Invalid access token for authorization" }],
  ["permission denied 1254302", { code: 1254302, msg: "Permission denied" }],
  ["permission denied 1254304", { code: 1254304, msg: "Permission denied" }],
  ["table not found 1254041", { code: 1254041, msg: "TableIdNotFound" }],
  ["wrong table id 1254004", { code: 1254004, msg: "WrongTableId" }],
  ["write conflict 1254291", { code: 1254291, msg: "Write conflict" }],
  ["a code nobody has seen", { code: 1299999, msg: "something new" }],
]) {
  test(`4 (real Lark): a whole-call error (${label}) is NOT split: exactly one batch call, every caller gets the error, nothing else is sent`, async () => {
    const tables = { ca: caTableWith(...fiftyUpdateRows()) };
    const { lark, d, done } = await setup({ tables, gap: 10, conc: 2 });
    try {
      const real = globalThis.fetch, seen = [];
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).includes("/records/batch_update")) { seen.push(init.body); return new Response(JSON.stringify(reply), { status: 200 }); }
        return real(url, init);
      };
      const out = await fiftyCalls(d, idsOf(50));
      assert.equal(seen.length, 1, "no split, no retry");
      for (const res of out) assert.equal(JSON.parse(res.body).code, reply.code, "every caller gets the error");
      assert.equal(lark.stats.update || 0, 0, "no single PUTs either");
      assert.ok(tables.ca.rows.every((row) => row.fields.Status === undefined));
      const stats = d.getStats();
      assert.equal(stats.updateWholeCallErrors, 1); assert.equal(stats.updateSplits, 0); assert.equal(stats.updateRecordRejects, 0);
      assert.equal(stats.active, 0);
    } finally { done(); }
  });
}

test("4 (real Lark): a non-JSON non-2xx reply (e.g. 403 from a gateway) is a whole-call error too, not a reason to split", async () => {
  const tables = { ca: caTableWith(...manyRows(10)) };
  const { d, done } = await setup({ tables, gap: 10, conc: 2 });
  try {
    const real = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (url, init = {}) => (String(url).includes("/records/batch_update") ? (calls++, new Response("forbidden", { status: 403 })) : real(url, init));
    const out = await fiftyCalls(d, idsOf(10));
    assert.equal(calls, 1);
    assert.ok(out.every((r) => r.status === 403));
  } finally { done(); }
});

test("4 (real Lark): duplicates are never sent: the same record written three times in one burst is ONE entry carrying the newest values", async () => {
  const tables = { ca: caTableWith(...manyRows(6)) };
  const { d, done } = await setup({ tables, gap: 10, conc: 2 });
  try {
    const bodies = spyOnBatchUpdates();
    const calls = [
      d.updateBatch(putCall("b0", { Status: "First", Inquiry: ["I1"] }, { requestStartedAt: Date.now() })),
      d.updateBatch(putCall("b0", { Status: "Second" }, { requestStartedAt: Date.now() })),
      d.updateBatch(putCall("b0", { Status: "Third" }, { requestStartedAt: Date.now() })),
      ...[1, 2, 3, 4].map((i) => d.updateBatch(putCall(`b${i}`, { Status: "Solved" }, { requestStartedAt: Date.now() }))),
    ];
    const out = await Promise.all(calls);
    assert.ok(out.every((r) => r.status === 200));
    const sent = bodies.flat();
    assert.equal(sent.filter((r) => r.record_id === "b0").length, 1, "b0 was sent once");
    assert.deepEqual(sent.find((r) => r.record_id === "b0").fields, { Status: "Third", Inquiry: ["I1"] });
    assert.equal(tables.ca.rows[0].fields.Status, "Third");
    assert.equal(new Set(sent.map((r) => r.record_id)).size, sent.length, "no record id twice in any batch");
  } finally { done(); }
});

test("fake Lark mirrors the measured real replies (HTTP 200 + code, atomic rejection, order, last wins, client_token repeats)", async () => {
  const tables = { ca: caTableWith(caRow("r1"), caRow("r2"), caRow("r3")) };
  tables.ca.numberFields = ["Released amount"];
  const { lark, done } = await setup({ tables, median: 1 });
  try {
    const base = "https://open.larksuite.com/open-apis/bitable/v1/apps/x/tables/ca/records";
    const post = async (path, body) => { const res = await lark.fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) }); return { status: res.status, json: await res.json() }; };
    let r = await post("/batch_update", { records: [{ record_id: "r2", fields: { Status: "B" } }, { record_id: "r1", fields: { Status: "A" } }] });
    assert.equal(r.status, 200); assert.equal(r.json.code, 0);
    assert.deepEqual(r.json.data.records, [{ record_id: "r2", fields: { Status: "B" } }, { record_id: "r1", fields: { Status: "A" } }], "request order, only the sent fields");
    r = await post("/batch_update", { records: [{ record_id: "r1", fields: { Status: "X" } }, { record_id: "recNOPE", fields: { Status: "X" } }] });
    assert.equal(r.status, 200); assert.equal(r.json.code, 1254043); assert.equal(r.json.msg, "record not found,id = recNOPE");
    assert.equal(tables.ca.rows[0].fields.Status, "A", "atomic: the valid record was not applied");
    r = await post("/batch_update", { records: [{ record_id: "r3", fields: { Status: "X" } }, { record_id: "r1", fields: { "Released amount": "not a number" } }] });
    assert.equal(r.status, 200); assert.equal(r.json.code, 1254061); assert.equal(r.json.msg, "NumberFieldConvFail"); assert.doesNotMatch(JSON.stringify(r.json), /r1/);
    assert.equal(tables.ca.rows[2].fields.Status, undefined, "atomic: nothing applied");
    r = await post("/batch_update", { records: [{ record_id: "r3", fields: { Status: "first" } }, { record_id: "r3", fields: { Status: "last" } }] });
    assert.equal(r.json.code, 0); assert.equal(tables.ca.rows[2].fields.Status, "last", "same record twice: the last value wins");
    const before = tables.ca.rows.length;
    const one = await post("/records?client_token=T1", { fields: { Username: "n", Brand: "PP" } });
    const again = await post("/records?client_token=T1", { fields: { Username: "n", Brand: "PP" } });
    assert.deepEqual(again.json, one.json, "a repeat returns the SAME record");
    const batch = await post("/records/batch_create?client_token=T2", { records: [{ fields: { Username: "m", Brand: "PP" } }] });
    const batchAgain = await post("/records/batch_create?client_token=T2", { records: [{ fields: { Username: "m", Brand: "PP" } }] });
    assert.deepEqual(batchAgain.json, batch.json);
    assert.equal(tables.ca.rows.length, before + 2, "no duplicate rows from the repeats");
  } finally { done(); }
});

test("4: if Lark instead applies the others and leaves the bad record out of its reply, that record is re-sent alone (never assumed written)", async () => {
  const tables = { ca: caTableWith(...manyRows(5)) };
  const { lark, d, done } = await setup({ tables, gap: 10, conc: 2, batchUpdateAtomic: false });
  try {
    const ids = ["b0", "b1", "ghost", "b3", "b4"];
    const out = await Promise.all(ids.map((id) => d.updateBatch(putCall(id, { Status: "Solved" }, { requestStartedAt: Date.now() }))));
    ids.forEach((id, i) => { if (id === "ghost") assert.equal(JSON.parse(out[i].body).code, 1254043); else assert.equal(out[i].status, 200); });
    assert.equal(d.getStats().updateMismatches, 1);
    assert.ok(lark.stats.update >= 1, "the missing record went out as a single PUT");
    assert.equal(tables.ca.rows[0].fields.Status, "Solved");
  } finally { done(); }
});

test("4: a lone update stays an ordinary PUT; anything that is not a plain field update (DELETE, odd body) takes the ordinary path", async () => {
  const tables = { ca: caTableWith(...manyRows(3)) };
  const { lark, d, done } = await setup({ tables, gap: 10 });
  try {
    const one = await d.updateBatch(putCall("b0", { Status: "Solved" }, { requestStartedAt: Date.now() }));
    assert.equal(one.status, 200);
    assert.equal(lark.stats.update, 1);
    assert.equal(lark.stats.batchUpdate, 0);
    const del = await d.updateBatch(call("DELETE", "b1"));
    assert.equal(JSON.parse(del.body).code, 0);
    assert.equal(lark.stats.delete, 1);
    const odd = await d.updateBatch({ ...putCall("b2", {}), body: JSON.stringify({ fields: { Status: "x" }, extra: 1 }) });
    assert.equal(odd.status, 200);
    assert.equal(lark.stats.batchUpdate, 0);
  } finally { done(); }
});

test("4: batches never exceed the size cap (100 records)", async () => {
  const tables = { ca: caTableWith(...manyRows(230)) };
  const { d, done } = await setup({ tables, gap: 5, conc: 3, median: 10 });
  try {
    const bodies = spyOnBatchUpdates();
    await Promise.all(Array.from({ length: 230 }, (_, i) => d.updateBatch(putCall(`b${i}`, { Status: "Solved" }, { requestStartedAt: Date.now() }))));
    assert.ok(bodies.every((records) => records.length <= 100), bodies.map((r) => r.length).join(","));
    assert.equal(bodies.flat().length + (d.getStats().lark.update.n), 230);
    assert.ok(tables.ca.rows.every((row) => row.fields.Status === "Solved"));
  } finally { done(); }
});

test("4: the update memory rule still holds: a row updated through a batch is dropped from the create memory", async () => {
  const tables = { ca: caTable() };
  const { d, done } = await setup({ tables, gap: 10 });
  try {
    const made = await Promise.all([d.createBatch(createReq("ca", caFields(1))), d.createBatch(createReq("ca", caFields(2)))]);
    const ids = made.map((r) => recordOf(r).record_id);
    await Promise.all(ids.map((id) => d.updateBatch(putCall(id, { Status: "Solved" }, { requestStartedAt: Date.now() }))));
    const again = await d.createBatch(createReq("ca", caFields(1)));
    assert.notEqual(recordOf(again).record_id, ids[0], "an updated row is not handed out again");
  } finally { done(); }
});

// Pages + real DO + fake Lark, flag on: 409s are decided BEFORE the batch
test("4: end to end with the flag on: refused (409) rows never enter a batch; the rest share a few batch_update calls", async () => {
  const rows = fiftyRows((i) => (i % 10 === 7 ? "Agent B" : "Agent A"));
  const { lark, d, done } = await setup({ tables: { ca: { rows, schema: caSchema } }, gap: 20, conc: 3 });
  try {
    initPagesEnv({ ...e2eEnv(d), LARK_BATCH_UPDATE: "1" });
    const bodies = spyOnBatchUpdates();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => recordHandler({ body: JSON.stringify({
      recordId: `rec${i}`, username: `Player${i}`, agentName: "Agent A", brand: "PP", inquiry: ["Others"], status: "Solved",
      chatLink: `https://my.livechatinc.com/chats/C${i}/T${i}`, telegram: false, claimSecret: false }) })));
    results.forEach((res, i) => assert.equal(res.statusCode, i % 10 === 7 ? 409 : 200, `submit ${i}`));
    const sent = bodies.flat().map((r) => r.record_id);
    for (const i of [7, 17, 27, 37, 47]) { assert.ok(!sent.includes(`rec${i}`), `rec${i} (another agent's) was never sent`); assert.equal(rows[i].fields.Status, undefined); }
    assert.equal(sent.length, 45);
    assert.ok(lark.stats.batchUpdate <= 3, `batch_update calls: ${lark.stats.batchUpdate}`);
    assert.equal(lark.stats.update || 0, 0);
    rows.forEach((row, i) => { if (i % 10 !== 7) assert.equal(row.fields.Status, "Solved"); });
  } finally { done(); }
});

// ======================================================================================
// Token lane: tenant-token permits do not use the read/write gate
// ======================================================================================
const holdFor = async (d, kind, id, ms = 10) => { const p = await d.acquire(kind, id); await new Promise((r) => setTimeout(r, ms)); await d.release(p.ticket); return Date.now(); };

test("TOKEN: a token permit is granted at once even while the read/write gate is completely busy, and it takes nothing from it", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 1, gap: 300, env: { TOKEN_GAP_MS: 5 } });
  try {
    const hold = await d.acquire("read", "hold");                                   // the only read/write slot is taken
    const queuedRead = d.acquire("read", "r1");                                     // and a read is waiting
    const queuedWrite = d.acquire("write", "w1");
    const startedAt = Date.now();
    const token = await d.acquire("token", "t1");
    assert.ok(token.ticket, "token granted");
    assert.ok(Date.now() - startedAt < 100, `token waited ${Date.now() - startedAt} ms behind a saturated gate`);
    const before = d.getStats();
    assert.equal(before.active, 1, "the main gate still has exactly its one held slot");
    assert.equal(before.queued, 2, "and its two queued waiters are untouched");
    await d.release(token.ticket);
    const after = d.getStats();
    assert.equal(after.active, 1);
    assert.equal(after.peakStartsPerSec <= 1, true, "token starts are not counted as read/write starts");
    assert.equal(after.perMinute.starts.at(-1), 1, "per-minute main starts exclude the token start");
    assert.equal(after.perMinute.tokenStarts.at(-1), 1, "per-minute token-lane starts count it");
    await d.release(hold.ticket);
    for (const p of await Promise.all([queuedRead, queuedWrite])) if (p.ticket) await d.release(p.ticket).catch(() => {});
  } finally { done(); }
});

test("TOKEN: 30 cold-isolate token fetches during a burst add at most 1 s to the reads' completion (they used to add ~7 s)", async () => {
  const run = async (withTokens) => {
    const { d, done } = await setup({ tables: { t1: mkTable(1) }, conc: 2, gap: 40 });
    try {
      const startedAt = Date.now();
      const reads = Array.from({ length: 24 }, (_, i) => holdFor(d, "read", `r${i}`));
      const tokens = withTokens ? Array.from({ length: 30 }, (_, i) => holdFor(d, "token", `t${i}`)) : [];
      const readDone = Math.max(...await Promise.all(reads));
      await Promise.all(tokens);
      return { readsMs: readDone - startedAt, stats: d.getStats() };
    } finally { done(); }
  };
  const baseline = await run(false);
  const mixed = await run(true);
  assert.ok(mixed.readsMs - baseline.readsMs <= 1_000, `reads took ${mixed.readsMs} ms with 30 token fetches vs ${baseline.readsMs} ms without`);
  assert.equal(mixed.stats.startsByClass.token, 30);
  assert.equal(mixed.stats.startsByClass.read, 24);
  assert.equal(mixed.stats.active + mixed.stats.tokenLane.active, 0, "everything released");
});

test("TOKEN: the lane has its own limit (concurrency and spacing), configurable with TOKEN_CONCURRENCY / TOKEN_GAP_MS", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 5, env: { TOKEN_CONCURRENCY: 2, TOKEN_GAP_MS: 60 } });
  try {
    assert.deepEqual([d.getStats().tokenLane.concurrency, d.getStats().tokenLane.gapMs], [2, 60]);
    const granted = [];
    const held = [];
    for (let i = 0; i < 5; i++) d.acquire("token", `t${i}`).then((p) => { granted.push(Date.now()); held.push(p); });
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(granted.length, 2, "only 2 at a time while they are held");
    assert.ok(granted[1] - granted[0] >= 50, `starts are spaced (${granted[1] - granted[0]} ms)`);
    assert.equal(d.getStats().tokenLane.queued, 3);
    for (const p of held.splice(0)) await d.release(p.ticket);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(granted.length, 4);
    for (const p of held.splice(0)) await d.release(p.ticket);
    await new Promise((r) => setTimeout(r, 120));
    for (const p of held.splice(0)) await d.release(p.ticket);
    assert.equal(granted.length, 5);
    assert.equal(d.getStats().tokenLane.active, 0);
    const defaults = await setup({ tables: { t1: mkTable(1) } });
    try { assert.deepEqual([defaults.d.getStats().tokenLane.concurrency, defaults.d.getStats().tokenLane.gapMs], [4, 50]); } finally { defaults.done(); }
  } finally { done(); }
});

test("TOKEN: a rate-limited token reply cools the token lane only; the main gate's 429 counters and gap are untouched", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 20 });
  try {
    const p = await d.acquire("token", "t1");
    await d.release(p.ticket, true, 10);
    const stats = d.getStats();
    assert.equal(stats.limited, 0);
    assert.equal(stats.tokenLimited, 1);
    assert.equal(stats.gapMs, 20, "the main gate did not slow down");
    const started = Date.now();
    const next = await d.acquire("token", "t2");                                  // waits out the token lane's own cooldown (>= 1 s)
    assert.ok(next.ticket);
    assert.ok(Date.now() - started >= 900, "token lane cooled down");
    await d.release(next.ticket);
    const read = await d.acquire("read", "r1");                                   // reads never waited for it
    assert.ok(read.ticket);
    await d.release(read.ticket);
  } finally { done(); }
});

test("TOKEN: an abandoned token waiter does not hold the lane (cancelled entries are skipped), and a lost ticket is reclaimed by the lease", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, env: { TOKEN_CONCURRENCY: 1, TOKEN_GAP_MS: 5 } });
  try {
    const first = await d.acquire("token", "a");
    const abandoned = d.acquire("token", "b", undefined, undefined);              // queued, then the caller never comes back for it
    await d.release(first.ticket);
    const p = await abandoned;
    assert.ok(p.ticket);
    await d.release(p.ticket);
    assert.equal(d.getStats().tokenLane.active, 0);
  } finally { done(); }
});

// ======================================================================================
// Per-minute: search / update p95, token-lane starts, distinct isolate ids
// ======================================================================================
test("MINUTE: search p95, update p95, token-lane starts and distinct Pages isolates are recorded per minute", async () => {
  const tables = { t1: mkTable(3), ca: caTableWith(caRow("r1"), caRow("r2")) };
  const { d, done } = await setup({ tables, gap: 5, median: 30 });
  try {
    await d.searchBatch(req("t1", "u1"));
    await d.larkCall(call("PUT", "r1", {}, { fields: { Status: "Solved" } }));
    await d.updateBatch(putCall("r2", { Status: "Solved" }, { requestStartedAt: Date.now() }));
    const t = await d.acquire("token", "t1"); await d.release(t.ticket);
    await d.reportCounters({}, "isolate-aaaa-1111");
    await d.reportCounters({ x: 1 }, "isolate-aaaa-1111");                          // same isolate again: counted once
    await d.reportCounters({}, "isolate-bbbb-2222");
    await d.reportCounters({}, "bad id with spaces");                               // ignored
    await d.reportCounters({}, 12345);                                              // ignored
    const pm = d.getStats().perMinute;
    assert.deepEqual(Object.keys(pm).sort(), ["isolates", "limited", "limitedOther", "limitedSearch", "limitedWrite", "minutes", "peakQueue", "searchP95", "starts", "tokenStarts", "totalStarts", "updateP95", "waitP95"]);
    const last = pm.minutes.length - 1;
    assert.ok(pm.searchP95[last] >= 25, `search p95 ${pm.searchP95[last]}`);
    assert.ok(pm.updateP95[last] >= 25, `update p95 ${pm.updateP95[last]}`);
    assert.equal(pm.tokenStarts[last], 1);
    assert.equal(pm.isolates[last], 2);
    assert.equal(new Set(Object.values(pm).map((a) => a.length)).size, 1, "all columns line up");
    assert.equal(JSON.stringify(d.getStats()).includes("isolate-aaaa"), false, "isolate ids are only counted, never listed");
  } finally { done(); }
});

// ======================================================================================
// Secrets never leave the queue in text
// ======================================================================================
test("SECRETS: a token-shaped string in an upstream error is scrubbed from the reply, and nothing token-like is in the stats", async () => {
  const secret = "t-SECRETSECRETSECRETSECRET0123";
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 5 });
  try {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === "GET") throw new Error(`connect failed for Authorization: Bearer ${secret} (${secret})`);
      return real(url, init);
    };
    const reply = await d.larkCall({ ...call("GET", "r1"), headers: { authorization: `Bearer ${secret}` } });
    assert.equal(reply.status, 504);
    assert.doesNotMatch(reply.body, /SECRETSECRET/);
    assert.match(reply.body, /\[token\]/);
    const stats = JSON.stringify(d.getStats());
    assert.doesNotMatch(stats, /SECRETSECRET|Bearer/);
    await d.acquire("token", "x", Date.now(), `t-${secret}`).then((p) => d.release(p.ticket));
    assert.doesNotMatch(JSON.stringify(d.getStats().labels), /SECRETSECRET/, "an odd label is grouped as 'other'");
  } finally { done(); }
});

// ======================================================================================
// Throttle visibility: every 429 is counted by call label and by Lark code, logged with what Lark said, and the per-minute
// history says which kind of call was throttled and how many requests really left for Lark (gate + token lane).
// ======================================================================================
function captureWarnings() {
  const real = console.warn, lines = [];
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = real; } };
}
const throttleOnce = (matches, headers = {}) => {
  const real = globalThis.fetch; let fired = false;
  globalThis.fetch = async (url, init = {}) => {
    if (!fired && matches(String(url), init)) {
      fired = true;
      return new Response(JSON.stringify({ code: 1254290, msg: "TooManyRequest" }), { status: 429, headers });
    }
    return real(url, init);
  };
};
const lastOf = (column) => column.reduce((a, b) => a + b, 0);

test("THROTTLE: a 429 on a search is counted by label and code, and the log line says label, code, status, Retry-After, x-ogw-ratelimit-* headers and table id (no token)", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(3) }, gap: 20 });
  const warn = captureWarnings();
  try {
    throttleOnce((url) => url.includes("/records/search"), { "Retry-After": "2", "x-ogw-ratelimit-limit": "20", "x-ogw-ratelimit-remaining": "0", "x-ogw-ratelimit-reset": "1", "x-tt-logid": "LOG-ABC", "x-other": "ignore-me" });
    const res = await d.searchBatch(req("t1", "u1"));
    assert.equal(res.status, 200, "the throttled search was retried and succeeded");
    const stats = d.getStats();
    assert.equal(stats.limited, 1); assert.equal(stats.retries429, 1, "the DO retried the throttled search once (limited +1, retries429 +1)");
    assert.deepEqual(stats.limitedByLabel, { search: 1 });
    assert.deepEqual(stats.limitedByCode, { 1254290: 1 });
    assert.equal(lastOf(stats.perMinute.limitedSearch), 1); assert.equal(lastOf(stats.perMinute.limitedWrite), 0); assert.equal(lastOf(stats.perMinute.limitedOther), 0);
    const line = warn.lines.find((l) => l.startsWith("Lark rate limit"));
    assert.ok(line, "the warning was logged");
    const info = JSON.parse(line.slice("Lark rate limit ".length));
    assert.equal(info.label, "search"); assert.equal(info.httpStatus, 429); assert.equal(info.code, 1254290); assert.equal(info.retryAfter, "2");
    assert.deepEqual(info.ratelimit, { "retry-after": "2", "x-ogw-ratelimit-limit": "20", "x-ogw-ratelimit-remaining": "0", "x-ogw-ratelimit-reset": "1" }, "only Retry-After and x-ogw-ratelimit-* headers");
    assert.equal(info.table, "t1"); assert.equal(info.logId, "LOG-ABC");
    assert.equal(info.baseGapMs, 20); assert.equal(info.gapMs, 40, "the logged gap is the new, doubled one");
    assert.ok("active" in info && "queued" in info && "startsLastSecond" in info);
    assert.doesNotMatch(line, /Bearer|authorization/i);
  } finally { warn.restore(); done(); }
});

test("THROTTLE: a 429 on a record update is a 'write' throttle, labelled update; on a batch_update, batchUpdate", async () => {
  const tables = { ca: caTableWith(...manyRows(4)) };
  const { d, done } = await setup({ tables, gap: 10 });
  const warn = captureWarnings();
  try {
    throttleOnce((url, init) => init.method === "PUT");
    assert.equal((await d.larkCall(putCall("b0", { Status: "Solved" }, { requestStartedAt: Date.now() }))).status, 200);
    throttleOnce((url) => url.endsWith("/records/batch_update"));
    const out = await Promise.all([1, 2, 3].map((i) => d.updateBatch(putCall(`b${i}`, { Status: "Solved" }, { requestStartedAt: Date.now() }))));
    assert.ok(out.every((r) => r.status === 200));
    const stats = d.getStats();
    assert.deepEqual(stats.limitedByLabel, { update: 1, batchUpdate: 1 });
    assert.equal(lastOf(stats.perMinute.limitedWrite), 2); assert.equal(lastOf(stats.perMinute.limitedSearch), 0);
    const tables_ = warn.lines.filter((l) => l.startsWith("Lark rate limit")).map((l) => JSON.parse(l.slice(16)).table);
    assert.deepEqual(tables_, ["ca", "ca"]);
  } finally { warn.restore(); done(); }
});

test("THROTTLE: a token-lane throttle is counted under label 'token' (and tokenLimited), not in the main gate's `limited`, and lands in limitedOther", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 20 });
  const warn = captureWarnings();
  try {
    const p = await d.acquire("token", "t1");
    await d.release(p.ticket, true, 1000);
    const stats = d.getStats();
    assert.equal(stats.tokenLimited, 1); assert.equal(stats.limited, 0);
    assert.deepEqual(stats.limitedByLabel, { token: 1 });
    assert.equal(lastOf(stats.perMinute.limitedOther), 1);
    assert.ok(warn.lines.some((l) => l.startsWith("Lark rate limit") && JSON.parse(l.slice(16)).label === "token"));
  } finally { warn.restore(); done(); }
});

test("THROTTLE: stats and log are bounded and carry no secret: odd codes are grouped, the by-code table stays small", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(1) }, gap: 5 });
  const warn = captureWarnings();
  try {
    const real = globalThis.fetch; let n = 0;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/records/search") && n < 30) { n++; return new Response(JSON.stringify({ code: n === 1 ? "t-SECRETSECRETSECRETSECRET12345" : 1254000 + n, msg: "x" }), { status: 429, headers: { "x-ogw-ratelimit-note": "Bearer t-SECRETSECRETSECRETSECRET12345" } }); }
      return real(url, init);
    };
    await d.searchBatch(req("t1", "u1", {}, null)).catch(() => {});
    const stats = d.getStats();
    assert.ok(Object.keys(stats.limitedByCode).length <= 17, JSON.stringify(stats.limitedByCode));
    assert.doesNotMatch(JSON.stringify(stats), /SECRETSECRET/);
    assert.doesNotMatch(warn.lines.join("\n"), /SECRETSECRET/);
  } finally { warn.restore(); done(); }
});

test("MINUTE: totalStarts counts gate starts AND token-lane starts (the real request rate towards Lark)", async () => {
  const { d, done } = await setup({ tables: { t1: mkTable(5) }, gap: 5 });
  try {
    for (let i = 0; i < 3; i++) { const p = await d.acquire("token", `t${i}`); await d.release(p.ticket); }
    await Promise.all([1, 2].map((i) => d.searchBatch(req("t1", `u${i}`))));
    const pm = d.getStats().perMinute;
    assert.equal(lastOf(pm.tokenStarts), 3);
    assert.ok(lastOf(pm.starts) >= 1);
    assert.equal(lastOf(pm.totalStarts), lastOf(pm.starts) + lastOf(pm.tokenStarts), "total = gate starts + token starts");
    assert.ok(pm.totalStarts.every((v, i) => v === pm.starts[i] + pm.tokenStarts[i]));
  } finally { done(); }
});
