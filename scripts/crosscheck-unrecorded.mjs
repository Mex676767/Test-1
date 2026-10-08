#!/usr/bin/env node
// One-time crosscheck: which chats since a start date did an agent write in, but nobody ever recorded in Customer Approaching?
// The result goes into the Lark table "Unrecorded Chats" and each agent's widget lists their own rows.
//
//   $env:SCAN_KEY = "<the same value as SCAN_KEY in the Cloudflare Pages settings>"
//   node scripts/crosscheck-unrecorded.mjs --base https://test-1-7wp.pages.dev --from 2026-10-07            (dry run: only prints)
//   node scripts/crosscheck-unrecorded.mjs --base https://test-1-7wp.pages.dev --from 2026-10-07 --write    (writes the rows)
//
// It only talks to the site's /crosscheck endpoint (small steps, one at a time, with a pause between them), so the credentials
// stay in Cloudflare. A chat counts as recorded when ANY Customer Approaching row created since the start date carries its
// thread id in the link. Run it again later and it adds only what is missing (rows already written are skipped).
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// chats: [{ chatId, threadId, date, customer, writers: [email] }]; recorded: Set of thread ids; existing: Set of "thread|email".
export function planEntries(chats, recorded, existing, account) {
  const seen = new Set();
  const entries = [];
  for (const chat of chats) {
    if (recorded.has(chat.threadId)) continue;
    for (const writer of chat.writers) {
      const email = String(writer).trim().toLowerCase();
      const key = `${chat.threadId}|${email}`;
      if (!email || existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      entries.push({ threadId: chat.threadId, chatId: chat.chatId, account, email, date: chat.date, customer: chat.customer });
    }
  }
  return entries;
}

export function windows(fromMs, toMs, stepMs) {
  const out = [];
  for (let start = fromMs; start < toMs; start += stepMs) out.push([start, Math.min(start + stepMs, toMs)]);
  return out;
}

export function summarize(entries) {
  const perWriter = new Map();
  for (const entry of entries) perWriter.set(entry.email, (perWriter.get(entry.email) || 0) + 1);
  return [...perWriter.entries()].sort((a, b) => b[1] - a[1]);
}

export function createClient({ base, key, fetchImpl = fetch, pauseMs = 300, retries = 3 }) {
  return async function step(body) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/crosscheck`, { method: "POST", headers: { "Content-Type": "application/json", "x-scan-key": key }, body: JSON.stringify(body) });
        const data = await response.json();
        if (response.status === 401 || response.status === 404) throw Object.assign(new Error(`The site answered ${response.status}: check the key and that SCAN_KEY is set in Cloudflare Pages.`), { fatal: true });
        if (pauseMs) await sleep(pauseMs);
        return data;
      } catch (error) {
        if (error.fatal || attempt >= retries) throw error;
        await sleep(1000 * attempt);
      }
    }
  };
}

export async function run({ step, fromMs, toMs, windowMs, write, log = console.log, accounts = ["lc1", "lc2"] }) {
  const recorded = new Set();
  let pageToken = "";
  let rows = 0;
  do {
    const data = await step({ step: "recorded", fromMs, pageToken });
    if (!data.ok) throw new Error(`recorded: ${data.error}`);
    data.threads.forEach((thread) => recorded.add(thread));
    rows += data.rows;
    pageToken = data.next;
  } while (pageToken);
  log(`Customer Approaching: read ${rows} rows; ${recorded.size} chats since the start date have a record.`);

  const existing = new Set();
  pageToken = "";
  if (write) {
    do {
      const data = await step({ step: "existing", pageToken });
      if (!data.ok) throw new Error(`existing: ${data.error}`);
      data.keys.forEach((k) => existing.add(k));
      pageToken = data.next;
    } while (pageToken);
    log(`Unrecorded Chats table: ${existing.size} rows already there.`);
  }

  const all = [];
  for (const account of accounts) {
    const chats = new Map();
    let missingEvents = 0;
    let configured = true;
    for (const [from, to] of windows(fromMs, toMs, windowMs)) {
      let pageId = "";
      do {
        const data = await step({ step: "archives", account, from, to, pageId });
        if (!data.ok) {
          if (/not configured/i.test(data.error || "")) { configured = false; break; }
          throw new Error(`archives (${account}): ${data.error}`);
        }
        data.chats.forEach((chat) => chats.set(chat.threadId, chat));
        missingEvents += data.withoutEvents || 0;
        pageId = data.next;
      } while (pageId);
      if (!configured) break;
    }
    if (!configured) { log(`${account}: not configured, skipped.`); continue; }
    const entries = planEntries([...chats.values()], recorded, existing, account);
    log(`${account}: ${chats.size} ended chats with an agent message, ${entries.length} never recorded${missingEvents ? ` (${missingEvents} chats came without messages and could not be judged)` : ""}.`);
    all.push(...entries);
  }

  log("\nNever-recorded chats per agent email:");
  for (const [email, count] of summarize(all)) log(`  ${String(count).padStart(4)}  ${email}`);
  log(`  ${String(all.length).padStart(4)}  total`);

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
  await run({ step: createClient({ base, key }), fromMs, toMs: Date.now(), windowMs, write: args.has("write") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
