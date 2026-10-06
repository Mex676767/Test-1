// Load simulation: real lark-search.js handler + real Durable Object class,
// synthetic Lark. Usage:
//   node proposal/sim/run.mjs --do=v1|v2|none --pages=orig|nocap|v2 --n=100 \
//        --arrival=burst|<spreadMs> --live=0|1 --median=200 --quota=20
// All data is synthetic. Nothing here touches production or credentials.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createFakeLark, fieldText } from "./fake-lark.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = "1"] = a.replace(/^--/, "").split("="); return [k, v]; }));
const N = Number(args.n || 100), DO_V = args.do || "v1", PAGES = args.pages || "orig";
const ARRIVAL = args.arrival || "burst", LIVE = args.live === "1", MEDIAN = Number(args.median || 200);
const QUOTA = Number(args.quota || 20), RPC_MS = Number(args.rpc || 8), USERS = Number(args.users || 600);
const ROWS_MAX = Number(args.rows || 4);
const CA_HIST = Number(args.cahist || 12), BG_MS = Number(args.bg || 0), CFG = Number(args.cfg || 0);
const PER_COND = Number(args.percond || 0), LIMIT_STATUS = Number(args.limitstatus || 429);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");                      // claude-lookup-review/.. = Test-1 root (functions/)
const build = path.join(here, ".build"); fs.mkdirSync(build, { recursive: true });

// ---- build variants of the Pages code and the DO --------------------------------
function buildPages(variant) {
  const dest = path.join(build, `pages-${variant}-${process.pid}`);
  fs.mkdirSync(path.join(dest, "_lib"), { recursive: true });
  const fromHead = variant !== "v2";           // orig/nocap = code as of git HEAD (before the review fixes); v2 = working tree
  const read = (rel) => fromHead ? execFileSync("git", ["show", `HEAD:${rel}`], { cwd: repo, maxBuffer: 1 << 26 }).toString("utf8")
    : fs.readFileSync(path.join(repo, rel), "utf8");
  fs.writeFileSync(path.join(dest, "lark-search.js"), read("functions/lark-search.js"));
  const libFiles = execFileSync("git", ["ls-files", "functions/_lib"], { cwd: repo }).toString().split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
  for (const rel of libFiles) fs.writeFileSync(path.join(dest, "_lib", path.basename(rel)), read(rel));
  fs.writeFileSync(path.join(dest, "package.json"), '{"type":"module"}');
  if (variant === "nocap") {   // ideal "many isolates" case: no per-isolate cap of 3
    const larkPath = path.join(dest, "_lib/lark.js");
    fs.writeFileSync(larkPath, fs.readFileSync(larkPath, "utf8").replace("const MAX_CONCURRENT_LARK_SEARCHES = 3;", "const MAX_CONCURRENT_LARK_SEARCHES = 100000;"));
  }
  return dest;
}
async function loadDO(version) {
  const srcFile = version === "v2" ? path.join(here, "../worker-v2/index.ts") : path.join(here, "../../worker/src/index.ts");
  let code = fs.readFileSync(srcFile, "utf8").replace(/import \{ DurableObject \} from "cloudflare:workers";/,
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
  const out = path.join(build, `do-${version}-${process.pid}.ts`);
  fs.writeFileSync(out, code);
  return (await import(pathToFileURL(out).href)).MyDurableObject;
}
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  return { storage: { sql: { exec(sql, ...p) {
    if (!p.length && sql.split(";").filter((s) => s.trim()).length > 1) { db.exec(sql); return { toArray: () => [] }; }
    const rows = db.prepare(sql).all(...p); return { toArray: () => rows, one: () => rows[0] };
  } } } };
}

// ---- synthetic data (deterministic) ------------------------------------------------
const h = (a, b, c) => ((Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791)) >>> 0);
const pick = (arr, n) => arr[n % arr.length];
const T = { ca: "t-ca", redeem: "t-redeem", pnl: "t-pnl", grace: "t-grace", top: "t-top", ltv: "t-ltv", risk: "t-risk", special: "t-special",
  vip: "t-vip", tg: "t-tg", moon: "t-moon", vs96: "t-vs96" };
const COMMON = ["Brand", "Status", "SW Check", "SW Checker", "Claimed Copy", "Time of Inspection", "Bonus Amount", "Expried", "Date", "Date Expired"];
const userField = { ca: "Username", pnl: "Username", risk: "Username", moon: "UID" };
function makeTables() {
  const tables = {};
  for (const [name, id] of Object.entries(T)) {
    const uf = userField[name] || "Username/UID";
    const extra = name === "pnl" ? ["Tier", "Tittle name"] : name === "ca" ? ["Agent Name", "Inquiry", "link", "Tier"] : [];
    tables[id] = { rows: [], schema: new Set([uf, ...COMMON, ...extra]), uf };
  }
  const statuses = {
    vip: ["Eligible", "Claimed", "Expired"], special: ["Eligible Angpao", "Claimed Angpao"], tg: ["Eligible", "Claimed"],
    risk: ["7D 20% Reload", "1D No Bonus", "Claimed"], redeem: ["Active", "Claimed", "Expired"], moon: ["Pass", "Claimed"], vs96: ["Pass", "Failed", "Claimed"],
    top: ["Pass"], ltv: ["Pass"], grace: ["Activated"],
  };
  const swChecks = ["Pass RM10", "Batch 09-09-2026 Claimed RM58", "Failed", "Activated : 2026-09-19 16:52 - Pass", "Expired"];
  const swCheckers = ["Pass", "Failed", "Claimed RM18", "Pass RM30"];
  for (let u = 0; u < USERS; u++) for (const [bi, brand] of ["PP", "MY"].entries()) for (const [ti, [name, id]] of Object.entries(T).entries()) {
    if (name === "ca") continue;
    const nrows = 1 + (h(u, bi, ti) % ROWS_MAX);
    for (let r = 0; r < nrows; r++) {
      const k = h(u, bi * 31 + ti, r);
      const f = { [tables[id].uf]: [{ text: `u${String(u).padStart(4, "0")}`, type: "text" }], Brand: brand,
        Status: pick(statuses[name] || ["Pass"], k), "SW Check": pick(swChecks, k >> 3), "SW Checker": pick(swCheckers, k >> 5),
        "Claimed Copy": (k & 7) === 0, "Time of Inspection": 1.79e12 + r * 1e6 + (k % 1000), "Bonus Amount": 8 + (k % 5) * 5,
        Expried: 1.79e12 + 5e8 + (k % 1e6), Date: 1.79e12 + r * 1e6, "Date Expired": 1.79e12 + 9e8 };
      if (name === "pnl") { f.Tier = "optT1"; f["Tittle name"] = `Name${u}`; }
      tables[id].rows.push({ record_id: `${id}-${u}-${bi}-${r}`, created_time: 1.79e12 + u * 100 + r, fields: f });
    }
  }
  // Customer Approaching = the case log: long per-customer history (many chats, other agents/brands).
  const blank = (u, r) => r === 0 && u % 40 === 0;      // blank (unfinished) case rows are rare and transient in production
  for (let u = 0; u < USERS; u++) for (const [bi, brand] of ["PP", "MY"].entries()) for (let r = 0; r < CA_HIST; r++) {
    tables[T.ca].rows.push({ record_id: `ca-${u}-${bi}-${r}`, created_time: 1.7e12 + u * 1000 + r, fields: {
      Username: [{ text: `u${String(u).padStart(4, "0")}`, type: "text" }], Brand: brand, "Agent Name": `agent${r % 5}`, Inquiry: blank(u, r) ? "" : "Deposit",
      Status: blank(u, r) ? "" : "Done", link: { link: `https://my.livechatinc.com/chats/H${u}/T${u}-${r}`, text: "x" } } });
  }
  if (CFG) {
    tables["t-cfg"] = { rows: [], schema: new Set(["Key"]), uf: "Key" };
    for (let c = 0; c < CFG; c++) {
      const id = "t-cfgsrc" + c;
      tables[id] = { rows: [], schema: new Set(["Username/UID", "Brand", "Status", "Time of Inspection"]), uf: "Username/UID" };
      tables["t-cfg"].rows.push({ record_id: "cfg" + c, created_time: 1, fields: { Key: "cfg" + c, Label: "Config " + c, Active: true,
        "Source Table ID": id, "Username Field": "Username/UID", "Brand Field": "Brand", "Date Field": "Time of Inspection", "Display Field": "Status",
        "Eligibility Rule": "any_text", Selection: "oldest", Inquiry: "Bonus" } });
      for (let u = 0; u < USERS; u++) for (const [bi, brand] of ["PP", "MY"].entries()) if (h(u, bi, 900 + c) % 3 === 0)
        tables[id].rows.push({ record_id: id + "-" + u + "-" + bi, created_time: 1, fields: { "Username/UID": [{ text: "u" + String(u).padStart(4, "0"), type: "text" }], Brand: brand, Status: pick(["Pass", "Claimed"], h(u, bi, c)), "Time of Inspection": 1.79e12 } });
    }
  }
  return tables;
}

// ---- run -------------------------------------------------------------------------------
const tables = makeTables();
const tableEnv = { LARK_APP_ID: "synthetic", LARK_APP_SECRET: "synthetic", LARK_BASE_APP_TOKEN: "synthetic-base",
  LARK_TABLE_CUSTOMER_APPROACHING: T.ca, LARK_TABLE_REDEEM_CODE: T.redeem, LARK_TABLE_PNL: T.pnl, LARK_TABLE_GRACE_PERIOD: T.grace,
  LARK_TABLE_TOP_PNL_NIGHT: T.top, LARK_TABLE_LTV_DAY: T.ltv, LARK_TABLE_RISK_PLAYER: T.risk, LARK_TABLE_SPECIAL_RELOAD: T.special,
  ...(CFG ? { LARK_TABLE_BONUS_CONFIG: "t-cfg" } : {}), LARK_TABLE_VIP_BOOSTER: T.vip, LARK_TABLE_TELEGRAM28: T.tg, LARK_TABLE_MOONCAKE: T.moon, LARK_TABLE_VS96_FEEDBACK: T.vs96 };

const pagesDir = buildPages(PAGES);
const { handler } = await import(pathToFileURL(path.join(pagesDir, "lark-search.js")).href);
const { initEnv } = await import(pathToFileURL(path.join(pagesDir, "_lib/lark.js")).href);
const realFetch = globalThis.fetch;
const agents = Array.from({ length: N }, (_, i) => ({ username: `u${String(i).padStart(4, "0")}`, brand: i % 2 ? "MY" : "PP",
  link: `https://my.livechatinc.com/chats/SIMCHAT${i}/SIMTHREAD${i}` }));
const call = (a) => handler({ body: JSON.stringify({ username: a.username, brand: a.brand, picName: `agent${a.username}`, link: LIVE ? a.link : "", preview: !LIVE }) });

// Oracle: the same handler, unbatched, unlimited quota, zero latency, sequential.
const refLark = createFakeLark({ tables, medianMs: 0, sigma: 0, perRowMs: 0, enforce: false });
globalThis.fetch = refLark.fetch;
initEnv({ ...tableEnv });
const expected = new Map();
for (const a of agents) { const r = JSON.parse((await handler({ body: JSON.stringify({ username: a.username, brand: a.brand, preview: true }) })).body); expected.set(a.username, JSON.stringify({ row: r.row, otherBrands: r.otherBrands, notVip: r.notVip })); }
for (const t of Object.values(tables)) t.rows = t.rows.filter((r) => !String(r.record_id).startsWith("rec_new_"));

// System under test
const lark = createFakeLark({ tables, medianMs: MEDIAN, quota: QUOTA, enforce: true, perCondMs: PER_COND, limitStatus: LIMIT_STATUS, shuffleBatch: args.shuffle === "1" });
globalThis.fetch = lark.fetch;
let doInstance = null, queue;
const rpc = (fn) => async (...a) => { await new Promise((r) => setTimeout(r, RPC_MS)); const v = await fn(...a); await new Promise((r) => setTimeout(r, RPC_MS)); return v; };
if (DO_V !== "none") {
  const DO = await loadDO(DO_V);
  doInstance = new DO(fakeCtx(), { GATE_START_GAP_MS: args.gap ? Number(args.gap) : undefined, GATE_CONCURRENCY: args.conc ? Number(args.conc) : undefined, GATE_LONGPOLL_MS: args.longpoll ? Number(args.longpoll) : undefined });
  const stub = Object.fromEntries(["acquire", "release", "penalize", "searchBatch", "createBatch"].map((m) => [m, rpc((...a) => doInstance[m](...a))]));
  queue = { idFromName: () => "g", get: () => stub };
}
initEnv({ ...tableEnv, LARK_SEARCH_QUEUE: queue, ...(PAGES === "v2" ? { LARK_QUEUE_PROTOCOL: "v2" } : {}), ...(args.batchcreate === "1" ? { LARK_BATCH_CREATE: "1" } : {}) });

let bgCount = 0, bgFail = 0, stopBg = false;
const larkLib = await import(pathToFileURL(path.join(pagesDir, "_lib/lark.js")).href);
async function backgroundPoller(i) {      // emulates /lark-stale-records: 1 unbatchable search per visible widget per interval
  await new Promise((r) => setTimeout(r, (i / N) * BG_MS));
  while (!stopBg) {
    bgCount++;
    await larkLib.searchRecords(T.ca, [{ field_name: "Agent Name", operator: "is", value: [`agent${i % 5}`] }, { field_name: "Inquiry", operator: "isEmpty", value: [] }, { field_name: "Status", operator: "isEmpty", value: [] }],
      undefined, { pageSize: 500, automaticFields: true, timeoutMs: 40_000 }).catch(() => { bgFail++; });
    await new Promise((r) => setTimeout(r, BG_MS));
  }
}
if (BG_MS) for (let i = 0; i < N; i++) void backgroundPoller(i);
const t0 = Date.now();
const results = await Promise.all(agents.map(async (a, i) => {
  if (ARRIVAL !== "burst") await new Promise((r) => setTimeout(r, (i / N) * Number(ARRIVAL)));
  const s = Date.now();
  let res, body;
  try { res = await call(a); body = JSON.parse(res.body); } catch (e) { body = { ok: false, error: String(e) }; res = { statusCode: 0 }; }
  return { a, ms: Date.now() - s, ok: res.statusCode === 200 && body.ok, warnings: body.lookupWarnings || [], body };
}));
const wall = Date.now() - t0;
stopBg = true;
const sorted = results.map((r) => r.ms).sort((x, y) => x - y);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const complete = results.filter((r) => r.ok && !r.warnings.length);
let wrong = 0;
for (const r of complete) if (JSON.stringify({ row: r.body.row, otherBrands: r.body.otherBrands, notVip: r.body.notVip }) !== expected.get(r.a.username)) wrong++;
// LiveChat mode: every lookup must own exactly one row, and it must be ITS row.
let caChecked = 0, caWrongOwner = 0, caDuplicateIds = 0, caRowsCreated = 0;
if (LIVE) {
  const byId = new Map(tables[T.ca].rows.map((r) => [r.record_id, r]));
  const seenIds = new Set();
  for (const r of results.filter((x) => x.ok)) {
    caChecked++;
    const id = r.body.caRecordId;
    if (seenIds.has(id)) caDuplicateIds++;
    seenIds.add(id);
    const row = byId.get(id);
    if (!row || fieldText(row.fields.Username) !== r.a.username || fieldText(row.fields.Brand) !== r.a.brand) caWrongOwner++;
  }
  caRowsCreated = tables[T.ca].rows.filter((r) => String(r.record_id).startsWith("rec_new_")).length;
}
const sizes = lark.stats.orSizes, st = doInstance?.getStats?.();
console.log(JSON.stringify({
  batchCreate: args.batchcreate === "1", background: BG_MS ? { intervalMs: BG_MS, polls: bgCount, failed: bgFail } : undefined,
  config: { do: DO_V, cfgBonuses: CFG, caHistoryPerUserBrand: CA_HIST, perCondMs: PER_COND, limitStatus: LIMIT_STATUS, gap: args.gap, conc: args.conc, pages: PAGES, n: N, arrival: ARRIVAL, live: LIVE, upstreamMedianMs: MEDIAN, quotaPerSec: QUOTA, rpcMs: RPC_MS },
  latencyMs: { p50: q(0.5), p95: q(0.95), max: sorted.at(-1), wallToLastResult: wall },
  caRows: LIVE ? { checked: caChecked, wrongOwner: caWrongOwner, duplicateIds: caDuplicateIds, rowsCreated: caRowsCreated } : undefined,
  results: { complete: complete.length, errorsOrWarnings: results.length - complete.length, wrongVsOracle: wrong,
    warningSources: [...new Set(results.flatMap((r) => r.warnings))] },
  upstream: { total: lark.stats.calls, search: lark.stats.search, create: lark.stats.create, fields: lark.stats.fields, token: lark.stats.token,
    http429: lark.stats.limited, peakStartsPerSecond: lark.stats.peakPerSecond, peakInFlight: lark.stats.peakInFlight,
    orQueries: lark.stats.orQueries, avgOrSize: sizes.length ? +(sizes.reduce((x, y) => x + y, 0) / sizes.length).toFixed(1) : 0,
    maxOrSize: Math.max(0, ...sizes), extraPages: lark.stats.pagesBeyondFirst, rowsReturned: lark.stats.rowsReturned },
  ...(st ? { doStats: st } : {}), clientStats: larkLib.larkClientStats,
}));
globalThis.fetch = realFetch;
process.exit(0);
