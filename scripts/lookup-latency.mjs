#!/usr/bin/env node
// How long does ONE everyday lookup take? Sends single lookups, one at a time, a few seconds apart (so each one meets an idle queue,
// like a real agent's lookup between bursts), and prints each time plus p50 / p95, with /queue-stats snapshots before and after.
//
//   QUEUE_STATS_KEY=...  node scripts/lookup-latency.mjs --base https://test-1-7wp.pages.dev --allow-production-reads [--count 10] [--spacing-ms 5000]
//
// What it sends:
//  * default: `preview: true` lookups (read only: the same ~12 searches a real lookup makes, but NO Customer Approaching row is created);
//  * --with-case-row --i-understand-this-creates-rows: real lookups with a chat link, which also claim / create the chat's row
//    (that is what an agent's lookup does, so it is the honest number). The usernames are zz...: delete those rows afterwards.
// Guarded like the load test (scripts/stress-guard.mjs): production needs --allow-production-reads and the queue stats key (the
// variable named by --stats-key-env, default QUEUE_STATS_KEY; its value is never printed). It refuses to start unless the queue is idle and at its base
// gap (--base-gap-ms, default 250), and stops, printing the snapshots and exiting non-zero, if a lookup is answered with a non-HTTP-200
// (more than --max-non-200, default 2) or Lark throttled while it ran.
import { checkRunStart, checkRunEnd, DEFAULT_BASE_GAP_MS, DEFAULT_MAX_NON_200 } from "./stress-guard.mjs";

const PRODUCTION_HOSTS = ["test-1-7wp.pages.dev"];
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(a.slice(2), next); i += 1; } else args.set(a.slice(2), true);
}
const base = String(args.get("base") || "").replace(/\/$/, "");
const count = Number(args.get("count") || 10);
const spacingMs = Number(args.get("spacing-ms") || 5_000);
const timeoutMs = Number(args.get("timeout-ms") || 45_000);
const baseGapMs = Number(args.get("base-gap-ms") || DEFAULT_BASE_GAP_MS);
const maxNon200 = args.has("max-non-200") ? Number(args.get("max-non-200")) : DEFAULT_MAX_NON_200;
const withCaseRow = args.has("with-case-row");
const statsKey = process.env[String(args.get("stats-key-env") || "QUEUE_STATS_KEY")] || "";
const prefix = String(args.get("prefix") || "zzlat");

if (!/^https?:\/\//.test(base)) { console.error("Usage: --base <url> [--count 10] [--spacing-ms 5000] [--with-case-row --i-understand-this-creates-rows] [--allow-production-reads]"); process.exit(2); }
const host = new URL(base).host;
const production = PRODUCTION_HOSTS.includes(host);
if (production && !args.has("allow-production-reads")) { console.error(`Refusing to run against ${host}: it is the production site. Pass --allow-production-reads if you mean it (each lookup spends real Lark quota).`); process.exit(2); }
if (withCaseRow && !args.has("i-understand-this-creates-rows")) { console.error("--with-case-row creates real Customer Approaching rows (usernames start with zz). It also needs --i-understand-this-creates-rows."); process.exit(2); }
if (production && !statsKey && !args.has("no-queue-guard")) { console.error("Refusing to run against production without the queue stats key (set the variable named by --stats-key-env, default QUEUE_STATS_KEY). --no-queue-guard keeps only the HTTP check."); process.exit(2); }
if (!(count >= 1 && count <= 30)) { console.error("--count must be between 1 and 30."); process.exit(2); }

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot() {
  if (!statsKey) return null;
  try {
    const res = await fetch(`${base}/queue-stats`, { headers: { "x-stats-key": statsKey }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json();
    return res.ok && json?.stats ? { at: json.at, ...json.stats } : null;
  } catch { return null; }
}
const brief = (s) => (s ? { at: s.at, gapMs: s.gapMs, active: s.active, queued: s.queued, limited: s.limited, retries429: s.retries429, tokenLimited: s.tokenLimited,
  upstream: s.upstream, startsByClass: s.startsByClass, bucketBursts: s.bucketBursts, burst: s.burst, location: s.location, uptimeSec: s.uptimeSec } : { unavailable: true });
const snapshots = [];
function stopWith(code, lines) {
  console.error(`\nSTOPPED: ${lines.join("; ")}`);
  if (snapshots.length) console.error(`queue snapshots: ${JSON.stringify(snapshots)}`);
  process.exit(code);
}

async function oneLookup(i) {
  const body = { username: `${prefix}${String(i + 1).padStart(3, "0")}`, brand: "PP", picName: "Latency Check", preview: !withCaseRow };
  if (withCaseRow) body.link = `https://my.livechatinc.com/chats/ZZLATC${i + 1}/ZZLATT${i + 1}`;
  const started = performance.now();
  try {
    const res = await fetch(`${base}/lark-search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    return { ms: performance.now() - started, status: res.status, ok: res.ok && data.ok === true, warnings: (data.lookupWarnings || []).length, caseRowError: !!data.caseRowError };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, ok: false, warnings: 0, caseRowError: false, error: String(error?.name || error) };
  }
}

console.log(`lookup latency: ${count} single ${withCaseRow ? "REAL (with case row)" : "preview (read-only)"} lookups, one at a time, ${spacingMs} ms apart, against ${host}`);
const first = await snapshot();
snapshots.push({ label: "before", ...brief(first) });
if (statsKey) {
  const start = checkRunStart(first, baseGapMs);
  if (!start.ok) stopWith(3, [`refusing to start: ${start.reason}`]);
  if (first?.location) console.log(`queue runs in: ${first.location.colo} (${first.location.loc})`);
}
const results = [];
for (let i = 0; i < count; i += 1) {
  if (i) await sleep(spacingMs);
  const before = i === 0 ? first : await snapshot();
  const r = await oneLookup(i);
  const after = await snapshot();
  results.push(r);
  const used = before && after ? ` | Lark calls ${Number(after.upstream) - Number(before.upstream)}, gate starts ${Number(after.startsByClass?.read || 0) + Number(after.startsByClass?.write || 0) - Number(before.startsByClass?.read || 0) - Number(before.startsByClass?.write || 0)}` : "";
  console.log(`  lookup ${String(i + 1).padStart(2)}: ${(r.ms / 1000).toFixed(2)} s  HTTP ${r.status}${r.ok ? "" : "  NOT OK"}${r.warnings ? `  warnings ${r.warnings}` : ""}${r.caseRowError ? "  caseRowError" : ""}${used}`);
  const verdict = checkRunEnd({ results, before: first, after, maxNon200 });
  if (verdict.stop) { snapshots.push({ label: `after lookup ${i + 1}`, ...brief(after) }); stopWith(1, [`after lookup ${i + 1}: ${verdict.reasons.join("; ")}`]); }
}
const last = await snapshot();
snapshots.push({ label: "after", ...brief(last) });
const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\np50 ${(pct(sorted, 50) / 1000).toFixed(2)} s   p95 ${(pct(sorted, 95) / 1000).toFixed(2)} s   min ${(sorted[0] / 1000).toFixed(2)} s   max ${(sorted.at(-1) / 1000).toFixed(2)} s   (n=${results.length}, ok ${results.filter((r) => r.ok).length})`);
console.log(`queue snapshots: ${JSON.stringify(snapshots)}`);
