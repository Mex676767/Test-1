import { readFileSync } from "node:fs";
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
const agents = Number(args.get("agents") || 100);
const rounds = Number(args.get("rounds") || 1);
const gapMs = Number(args.get("round-gap-ms") || 0);
const write = args.has("write");
const timeoutMs = Number(args.get("timeout-ms") || 45_000);
const baseGapMs = Number(args.get("base-gap-ms") || DEFAULT_BASE_GAP_MS);
const maxNon200 = args.has("max-non-200") ? Number(args.get("max-non-200")) : DEFAULT_MAX_NON_200;
const statsKey = process.env[String(args.get("stats-key-env") || "QUEUE_STATS_KEY")] || "";

if (!/^https?:\/\//.test(base)) { console.error("Usage: --base <url> [--agents 100] [--rounds 1] [--round-gap-ms 0] [--users file] [--write]"); process.exit(2); }
const host = new URL(base).host;
if (PRODUCTION_HOSTS.includes(host) && !args.has("allow-production-reads")) {
  console.error(`Refusing to load-test ${host}: it is the production site. Use a staging copy, or pass --allow-production-reads (read-only) if you really mean it.`);
  process.exit(2);
}
if (write && (PRODUCTION_HOSTS.includes(host) || !args.has("i-understand-this-writes-rows"))) {
  console.error("--write creates real rows. It is refused on production and needs --i-understand-this-writes-rows on a staging copy.");
  process.exit(2);
}

const players = args.has("users")
  ? readFileSync(String(args.get("users")), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [u, b] = l.split(","); return { username: u.trim(), brand: (b || "PP").trim() }; })
  : Array.from({ length: agents }, (_, i) => ({ username: `loadtest${i}`, brand: "PP" }));
if (!players.length) { console.error("No players to look up."); process.exit(2); }

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function oneLookup(agentIndex, round) {
  const p = players[(agentIndex + round * agents) % players.length];
  const body = { username: p.username, brand: p.brand, picName: `Load Agent ${agentIndex % 20}`, preview: !write };
  if (write) body.link = `https://my.livechatinc.com/chats/LT${round}-${agentIndex}/TH${round}-${agentIndex}`;
  const started = performance.now();
  try {
    const res = await fetch(`${base}/lark-search`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return { ms: performance.now() - started, status: res.status, ok: res.ok && data.ok === true, warnings: (data.lookupWarnings || []).length, caseRowError: !!data.caseRowError };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, ok: false, warnings: 0, caseRowError: false, error: String(error?.name || error) };
  }
}

if (PRODUCTION_HOSTS.includes(host) && !statsKey && !args.has("no-queue-guard")) {
  console.error("Refusing to load-test production without the queue stats key (set the variable named by --stats-key-env, default QUEUE_STATS_KEY): the guard cannot see throttles or a backed-off queue without it. --no-queue-guard keeps only the HTTP check.");
  process.exit(2);
}
async function snapshot() {
  if (!statsKey) return null;
  try {
    const res = await fetch(`${base}/queue-stats`, { headers: { "x-stats-key": statsKey }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json();
    return res.ok && json?.stats ? { at: json.at, ...json.stats } : null;
  } catch { return null; }
}
const snapshots = [];
function stopWith(code, lines) {
  console.error(`\nSTOPPED: ${lines.join("; ")}`);
  if (snapshots.length) console.error(`queue snapshots: ${JSON.stringify(snapshots)}`);
  process.exit(code);
}

const all = [];
for (let round = 0; round < rounds; round += 1) {
  const before = await snapshot();
  if (statsKey) {
    snapshots.push({ label: `round ${round + 1} before`, ...(before || { unavailable: true }) });
    const start = checkRunStart(before, baseGapMs);
    if (!start.ok) stopWith(3, [`refusing to start round ${round + 1}: ${start.reason}`]);
  }
  const results = await Promise.all(Array.from({ length: agents }, (_, i) => oneLookup(i, round)));
  all.push(...results);
  const after = await snapshot();
  if (statsKey) snapshots.push({ label: `round ${round + 1} after`, ...(after || { unavailable: true }) });
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`round ${round + 1}/${rounds}: ok ${results.filter((r) => r.ok).length}/${agents}  p50 ${pct(ms, 50).toFixed(0)} ms  p95 ${pct(ms, 95).toFixed(0)} ms  max ${ms.at(-1).toFixed(0)} ms`);
  const verdict = checkRunEnd({ results, before, after, maxNon200 });
  if (verdict.stop) {
    for (const r of results.filter((x) => x.status !== 200).slice(0, 5)) console.error(`  non-200 sample: status ${r.status} ${r.error || ""}`);
    stopWith(1, [`after round ${round + 1}: ${verdict.reasons.join("; ")}`]);
  }
  if (gapMs && round < rounds - 1) await new Promise((r) => setTimeout(r, gapMs));
}

const ms = all.map((r) => r.ms).sort((a, b) => a - b);
const byStatus = {};
for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log("\n--- summary ---");
console.log(`lookups ${all.length}  ok ${all.filter((r) => r.ok).length}  with source warnings ${all.filter((r) => r.warnings).length}  case-row errors ${all.filter((r) => r.caseRowError).length}`);
console.log(`latency p50 ${pct(ms, 50).toFixed(0)} ms  p90 ${pct(ms, 90).toFixed(0)} ms  p95 ${pct(ms, 95).toFixed(0)} ms  p99 ${pct(ms, 99).toFixed(0)} ms  max ${ms.at(-1).toFixed(0)} ms`);
console.log(`HTTP status counts ${JSON.stringify(byStatus)}  client timeouts ${all.filter((r) => r.error === "TimeoutError").length}`);
console.log(`target: ok = all, p95 < 10000 ms (read-only), no case-row errors`);
