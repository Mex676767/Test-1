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
// How many time windows of one account are read at once.
const WINDOW_CONCURRENCY = 3;

// Runs fn(item) for every item, `limit` at a time; the first failure rejects.
export async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next]; next += 1; await fn(item); }
  }));
}

// A step LiveChat refused only for now (rate limit, timeout, busy) is asked again after a pause, up to `tries` times.
export async function stepWithRetry(step, body, tries = 4, pauseMs = 2000) {
  for (let attempt = 1; ; attempt += 1) {
    const data = await step(body);
    if (data.ok || attempt >= tries || !/too many|rate.?limit|timeout|timed out|temporar|busy|unavailable|try again/i.test(data.error || "")) return data;
    await sleep(pauseMs * attempt);
  }
}

// chats: [{ chatId, threadId, date, customer, writers: [email] }]; recorded: Set of thread ids; existing: Set of "thread|email".
// names (optional): { pairs: Set of "thread|agent name" in lower case, byEmail: Map email -> agent name }. A writer whose email is
// known as an agent is judged on THEIR OWN record (a chat another agent recorded still counts as unrecorded for them); a
// writer who is not known falls back to "does any row carry this chat".
// onlyKnown (the default once any agent is known): the LiveChat accounts also hold the whole customer-service team and bots,
// who never use this tool -- their chats are not meant to be recorded here and nobody's widget would show them. Only writers
// whose email is in the Agent Logins table are listed; stats.unknownWriters counts the rest. Agents who have not opened
// the widget since the email column was added are picked up by running the script again later.
export function planEntries(chats, recorded, existing, account, names = null, { onlyKnown = true, stats = {} } = {}) {
  const seen = new Set();
  const entries = [];
  for (const chat of chats) {
    for (const writer of chat.writers) {
      const email = String(writer).trim().toLowerCase();
      const agent = names?.byEmail.get(email);
      if (onlyKnown && names && names.byEmail.size && !agent) { stats.unknownWriters = (stats.unknownWriters || 0) + 1; continue; }
      const isRecorded = agent ? names.pairs.has(`${chat.threadId}|${agent.toLowerCase()}`) : recorded.has(chat.threadId);
      if (isRecorded) continue;
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

export async function run({ step, fromMs, toMs, windowMs, write, onlyKnown = true, log = console.log, accounts = ["lc1", "lc2"] }) {
  const recorded = new Set();
  const pairs = new Set();
  let pageToken = "";
  let rows = 0;
  do {
    const data = await step({ step: "recorded", fromMs, pageToken });
    if (!data.ok) throw new Error(`recorded: ${data.error}`);
    data.threads.forEach((thread) => recorded.add(thread));
    (data.pairs || []).forEach((pair) => pairs.add(pair));
    rows += data.rows;
    pageToken = data.next;
  } while (pageToken);
  log(`Customer Approaching: read ${rows} rows; ${recorded.size} chats since the start date have a record.`);

  const agents = await step({ step: "agents" });
  if (!agents.ok) throw new Error(`agents: ${agents.error}`);
  const byEmail = new Map((agents.agents || []).map((agent) => [String(agent.email).toLowerCase(), agent.name]));
  const names = { pairs, byEmail };
  log(`Agent Logins: ${byEmail.size} agents have their LiveChat email filled in (they are judged on their own records; the rest on "any row for the chat").`);
  // With nobody known yet, "only agents who use the widget" would list nobody: say so instead of writing nothing quietly.
  if (onlyKnown && byEmail.size === 0) throw new Error("No agent has their LiveChat email in the Agent Logins table yet, so there is nobody to list. Wait until agents have opened the widget, or add --all-writers to list every writer (customer service and bots included).");

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

  // Both LiveChat accounts are read at the same time (separate credentials, separate limits), and several time windows of
  // one account at once, with a progress line per finished window.
  async function scanAccount(account) {
    const chats = new Map();
    const result = { account, chats, configured: true, fetchedAlone: 0, unjudged: 0, outreach: 0 };
    const list = windows(fromMs, toMs, windowMs);
    let done = 0;
    await pool(list, WINDOW_CONCURRENCY, async ([from, to]) => {
      if (!result.configured) return;
      let pageId = "";
      do {
        const data = await stepWithRetry(step, { step: "archives", account, from, to, pageId });
        if (!data.ok) {
          if (/not configured/i.test(data.error || "")) { result.configured = false; return; }
          throw new Error(`archives (${account}): ${data.error}`);
        }
        data.chats.forEach((chat) => chats.set(chat.threadId, chat));
        result.outreach += data.outreach || 0;
        // Ended chats that came without their messages are fetched one by one, so nothing is left unjudged.
        for (const pending of data.pending || []) {
          if (chats.has(pending.threadId)) continue;
          const one = await stepWithRetry(step, { step: "chat", account, chatId: pending.chatId, threadId: pending.threadId });
          result.fetchedAlone += 1;
          if (!one.ok) { result.unjudged += 1; continue; }
          result.outreach += one.outreach || 0;
          if (one.chat) chats.set(one.chat.threadId, one.chat);
        }
        pageId = data.next;
      } while (pageId);
      done += 1;
      log(`  [${account}] window ${done}/${list.length} done, ${chats.size} chats so far`);
    });
    return result;
  }

  const all = [];
  for (const result of await Promise.all(accounts.map(scanAccount))) {
    const { account, chats, fetchedAlone, unjudged, outreach } = result;
    if (!result.configured) { log(`${account}: not configured, skipped.`); continue; }
    const stats = {};
    const entries = planEntries([...chats.values()], recorded, existing, account, names, { onlyKnown, stats });
    log(`${account}: ${chats.size} ended chats with an agent message, ${entries.length} never recorded by an agent who uses the widget.${stats.unknownWriters ? ` ${stats.unknownWriters} chat/writer pairs left out: the writer is not in the Agent Logins table (customer service, bots, or an agent who has not opened the widget yet).` : ""}${outreach ? ` ${outreach} outreach-only chats (the customer never wrote, e.g. Blast) were left out.` : ""}${fetchedAlone ? ` ${fetchedAlone} chats had to be fetched one by one.` : ""}${unjudged ? ` ${unjudged} could NOT be judged (LiveChat refused them); run again to retry.` : ""}`);
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
  await run({ step: createClient({ base, key }), fromMs, toMs: Date.now(), windowMs, write: args.has("write"), onlyKnown: !args.has("all-writers") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
