import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { archiveLink, createClient, histogram, pool, planAll, planEntries, scanChats, stepWithRetry, summarize, toCsv, windows } from "../qa/scan.js";

export { archiveLink, createClient, histogram, pool, planEntries, stepWithRetry, summarize, toCsv, windows };

export async function run({ step, fromMs, toMs, windowMs, write, onlyKnown = true, minAgentMessages = 1, minCustomerMessages = 1, show = "", exclude = [], csvPath = "", log = console.log, accounts = ["lc1", "lc2"] }) {
  const say = (line) => log(line);
  const scan = await scanChats({ step, fromMs, toMs, windowMs, onlyKnown, log: say, accounts });

  const existing = new Set();
  if (write) {
    let pageToken = "";
    do {
      const data = await step({ step: "existing", pageToken });
      if (!data.ok) throw new Error(`existing: ${data.error}`);
      data.keys.forEach((k) => existing.add(k));
      pageToken = data.next;
    } while (pageToken);
    log(`Unrecorded Chats table: ${existing.size} rows already there.`);
  }

  const all = planAll(scan, { existing, onlyKnown, minAgentMessages, minCustomerMessages, exclude, log: say });

  log("\nNever-recorded chats per agent email:");
  for (const [email, count] of summarize(all)) log(`  ${String(count).padStart(4)}  ${email}`);
  log(`  ${String(all.length).padStart(4)}  total`);
  log(`\nMessages the agent wrote per chat  -> ${histogram(all, "agentMessages")}`);
  log(`Messages the customer wrote per chat -> ${histogram(all, "customerMessages")}`);
  if (show) {
    const wanted = String(show).trim().toLowerCase();
    const sample = all.filter((entry) => entry.email === wanted).sort((a, b) => b.date - a.date).slice(0, 15);
    log(`\nThe 15 newest chats for ${wanted} (${all.filter((entry) => entry.email === wanted).length} in all) -- open a few and judge whether they needed recording:`);
    for (const entry of sample) log(`  ${archiveLink(entry.threadId)}  ${entry.date ? new Date(entry.date).toISOString().slice(0, 16).replace("T", " ") : "?"}  agent ${entry.agentMessages ?? "?"} / customer ${entry.customerMessages ?? "?"}  ${entry.customer || ""}`);
  }

  if (csvPath) {
    await writeFile(csvPath, toCsv(all, scan.byEmail), "utf8");
    log(`\nQA sheet written: ${csvPath} (${all.length} chats, ${summarize(all).length} agents, busiest agent first).`);
  }

  if (!write) { log("\nDry run: nothing was written. Add --write to put these rows in the Unrecorded Chats table."); return { entries: all, created: 0 }; }
  let created = 0;
  const failed = [];
  for (let i = 0; i < all.length; i += 25) {
    const data = await step({ step: "write", entries: all.slice(i, i + 25) });
    if (!data.ok) throw new Error(`write: ${data.error}`);
    created += data.created;
    failed.push(...(data.failed || []));
    log(`  written ${Math.min(i + 25, all.length)} / ${all.length}`);
  }
  log(`\nDone: ${created} rows written${failed.length ? `, ${failed.length} failed (re-run to retry them)` : ""}.`);
  return { entries: all, created, failed };
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) { args.set(arg.slice(2), next); i += 1; } else args.set(arg.slice(2), true);
  }
  const base = String(args.get("base") || "").replace(/\/$/, "");
  const key = process.env[String(args.get("key-env") || "SCAN_KEY")] || "";
  const fromMs = Date.parse(`${args.get("from") || "2026-10-07"}T00:00:00+08:00`);
  if (!base || !key || !Number.isFinite(fromMs)) {
    console.error("Usage: node scripts/crosscheck-unrecorded.mjs --base https://<site> [--from YYYY-MM-DD] [--write]   (the key is read from $env:SCAN_KEY)");
    process.exit(2);
  }
  const windowMs = Number(args.get("window-hours") || 6) * 3_600_000;
  await run({
    step: createClient({ base, key }), fromMs, toMs: Date.now(), windowMs, write: args.has("write"), onlyKnown: !args.has("all-writers"),
    minAgentMessages: Number(args.get("min-agent-messages") || 1), minCustomerMessages: Number(args.get("min-customer-messages") || 1),
    show: args.get("show") === true ? "" : String(args.get("show") || ""),
    exclude: args.get("exclude") === true ? [] : String(args.get("exclude") || "").split(","),
    csvPath: args.get("csv") === true ? `unrecorded-chats-${new Date().toISOString().slice(0, 10)}.csv` : String(args.get("csv") || ""),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
