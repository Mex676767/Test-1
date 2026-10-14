// The crosscheck logic shared by the QA page in the admin preview (qa/index.html) and the command-line
// script (scripts/crosscheck-unrecorded.mjs). Runs in a browser and in Node: no Node-only imports in here.
//
// Question answered: which chats since a start date did an agent write in, but nobody ever recorded in Customer Approaching?
// (Ticking "Unknown player" stores nothing anywhere, so such chats show up here too: QA judges whether each really was unknown.)
// Everything goes through the site's /crosscheck endpoint in small steps; the LiveChat and Lark credentials stay in Cloudflare.
// Nothing is written to Lark from here.

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
// the widget since the email column was added are picked up by running the scan again later.
// minAgentMessages / minCustomerMessages (default 1 = no filter) leave out chats with fewer messages, judged on the writer's own
// messages and the customer's; stats.belowMinimum counts them. A chat that came without counts is never filtered out.
// exclude: a Set of lower-case emails that are left out entirely (e.g. the admin's own logins); stats.excluded counts them.
export function planEntries(chats, recorded, existing, account, names = null, { onlyKnown = true, stats = {}, minAgentMessages = 1, minCustomerMessages = 1, exclude = new Set() } = {}) {
  const seen = new Set();
  const entries = [];
  for (const chat of chats) {
    for (const writer of chat.writers) {
      const email = String(writer).trim().toLowerCase();
      if (exclude.has(email)) { stats.excluded = (stats.excluded || 0) + 1; continue; }
      const agent = names?.byEmail.get(email);
      if (onlyKnown && names && names.byEmail.size && !agent) { stats.unknownWriters = (stats.unknownWriters || 0) + 1; continue; }
      const isRecorded = agent ? names.pairs.has(`${chat.threadId}|${agent.toLowerCase()}`) : recorded.has(chat.threadId);
      if (isRecorded) continue;
      const key = `${chat.threadId}|${email}`;
      if (!email || existing.has(key) || seen.has(key)) continue;
      const agentMessages = chat.counts ? (chat.counts[email] || 0) : null;
      const customerMessages = chat.counts ? (chat.customerMessages || 0) : null;
      if (chat.counts && (agentMessages < minAgentMessages || customerMessages < minCustomerMessages)) { stats.belowMinimum = (stats.belowMinimum || 0) + 1; continue; }
      seen.add(key);
      entries.push({ threadId: chat.threadId, chatId: chat.chatId, account, email, date: chat.date, customer: chat.customer, agentMessages, customerMessages });
    }
  }
  return entries;
}

export function windows(fromMs, toMs, stepMs) {
  const out = [];
  for (let start = fromMs; start < toMs; start += stepMs) out.push([start, Math.min(start + stepMs, toMs)]);
  return out;
}

// "1: 120, 2: 40, 3-5: 30, 6+: 10" -- how many entries have that many messages (entries without counts are skipped).
export function histogram(entries, field) {
  const buckets = [["1", (n) => n === 1], ["2", (n) => n === 2], ["3-5", (n) => n >= 3 && n <= 5], ["6+", (n) => n >= 6]];
  const counted = entries.filter((entry) => typeof entry[field] === "number");
  return buckets.map(([label, test]) => `${label}: ${counted.filter((entry) => test(entry[field])).length}`).join(", ");
}

// [[email, count], ...] busiest first.
export function summarize(entries) {
  const perWriter = new Map();
  for (const entry of entries) perWriter.set(entry.email, (perWriter.get(entry.email) || 0) + 1);
  return [...perWriter.entries()].sort((a, b) => b[1] - a[1]);
}

// A cell that starts with = + - @ would run as a formula when the file is opened in Excel / Sheets: customer names are typed by
// customers, so they get a leading apostrophe. Everything with a comma, quote or line break is quoted.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const archiveLink = (threadId) => `https://my.livechatinc.com/archives/${threadId}`;
// Malaysian time (UTC+8), like the dates people type: "2026-10-04 08:00".
export const myt = (ms) => (ms ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") : "");

// Agents with the most never-recorded chats first, each agent's newest chats first.
export function sortedEntries(entries) {
  const perAgent = new Map(summarize(entries));
  return [...entries].sort((a, b) => perAgent.get(b.email) - perAgent.get(a.email) || a.email.localeCompare(b.email) || b.date - a.date);
}

// The sheet for QA: one row per chat, with empty "QA verdict" / "QA note" columns to fill in.
export function toCsv(entries, byEmail = new Map()) {
  const perAgent = new Map(summarize(entries));
  const header = ["Agent", "Agent email", "Agent's unrecorded chats", "Date (MYT)", "Chat link", "Customer", "Agent messages", "Customer messages", "LiveChat account", "QA verdict", "QA note"];
  const lines = [header, ...sortedEntries(entries).map((entry) => [
    byEmail.get(entry.email) || "", entry.email, perAgent.get(entry.email), myt(entry.date),
    archiveLink(entry.threadId), entry.customer, entry.agentMessages ?? "", entry.customerMessages ?? "", entry.account, "", "",
  ])];
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// The caller of the site's /crosscheck endpoint (base "" = the same site). Identifies itself with the admin's scan `key`, or with
// a LiveChat sign-in `login` = { account: "lc1", token }. Retries a network blip; a refusal (wrong key, not signed in, not QA)
// stops at once, with the site's own words when it gave any.
export function createClient({ base, key = "", login = null, fetchImpl = fetch, pauseMs = 300, retries = 3 }) {
  const identity = login ? { "x-livechat-account": login.account, "x-livechat-token": login.token } : { "x-scan-key": key };
  return async function step(body) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/crosscheck`, { method: "POST", headers: { "Content-Type": "application/json", ...identity }, body: JSON.stringify(body) });
        const data = await response.json();
        if ([401, 403, 404].includes(response.status)) throw Object.assign(new Error(data?.error && response.status !== 404 ? data.error : `The site answered ${response.status}: check the key and that SCAN_KEY is set in Cloudflare Pages.`), { fatal: true, status: response.status, loginExpired: Boolean(data?.loginExpired) });
        if (pauseMs) await sleep(pauseMs);
        return data;
      } catch (error) {
        if (error.fatal || attempt >= retries) throw error;
        await sleep(1000 * attempt);
      }
    }
  };
}

// Logins that never belong in the list (the admin's own LiveChat logins). Kept as salted SHA-256 hashes, not as emails, so the
// addresses are not readable in the public source. A hash only keeps the plain text out of sight: it is not a secret, and
// anyone who guesses an address can test it. The scan hashes the writers it actually met and drops the ones that match.
export const EXCLUDE_SALT = "rtn-qa-v1";
export const ALWAYS_EXCLUDED_HASHES = new Set([
  "8558db0b41fcc9498d501dd7de34117faa290e573aaebcfee20dac0d2dad902c",
  "c9bbc994474dc2dc433c0c11710a8e2626e978cb813fd615c03f82044044f6c9",
]);

export async function emailHash(email) {
  const data = new TextEncoder().encode(`${EXCLUDE_SALT}:${String(email).trim().toLowerCase()}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The writers among `chats` (a Map of chats) whose hash is in `hashes`, as lower-case emails.
async function matchingEmails(chatMaps, hashes) {
  const writers = new Set();
  for (const chats of chatMaps) for (const chat of chats.values()) for (const writer of chat.writers || []) writers.add(String(writer).trim().toLowerCase());
  const found = new Set();
  for (const email of writers) if (hashes.has(await emailHash(email))) found.add(email);
  return found;
}

// Reads everything needed to judge the chats of [fromMs, toMs): the recorded chats, the agent list, and the ended chats of each
// LiveChat account (several time windows at once, both accounts at the same time).
// isCancelled(): checked between steps; true stops the scan with an error whose .cancelled is true.
export async function scanChats({ step, fromMs, toMs, windowMs, onlyKnown = true, log = () => {}, accounts = ["lc1", "lc2"], isCancelled = () => false }) {
  const stopIfCancelled = () => { if (isCancelled()) throw Object.assign(new Error("Stopped."), { cancelled: true }); };
  const recorded = new Set();
  const pairs = new Set();
  let pageToken = "";
  let rows = 0;
  do {
    stopIfCancelled();
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
  log(`Agent Logins: ${byEmail.size} agents have their LiveChat email filled in (they are judged on their own records; the rest on "any row for the chat").`);
  // With nobody known yet, "only agents who use the widget" would list nobody: say so instead of showing nothing quietly.
  if (onlyKnown && byEmail.size === 0) throw new Error("No agent has their LiveChat email in the Agent Logins table yet, so there is nobody to list. Wait until agents have opened the widget.");

  async function scanAccount(account) {
    const chats = new Map();
    const result = { account, chats, configured: true, fetchedAlone: 0, unjudged: 0, outreach: 0 };
    const list = windows(fromMs, toMs, windowMs);
    let done = 0;
    await pool(list, WINDOW_CONCURRENCY, async ([from, to]) => {
      if (!result.configured) return;
      let pageId = "";
      do {
        stopIfCancelled();
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
          stopIfCancelled();
          const one = await stepWithRetry(step, { step: "chat", account, chatId: pending.chatId, threadId: pending.threadId });
          result.fetchedAlone += 1;
          if (!one.ok) { result.unjudged += 1; continue; }
          result.outreach += one.outreach || 0;
          if (one.chat) chats.set(one.chat.threadId, one.chat);
        }
        pageId = data.next;
      } while (pageId);
      done += 1;
      log(`  [${account}] window ${done}/${list.length} done, ${chats.size} chats so far`, { account, done, total: list.length });
    });
    return result;
  }

  const results = await Promise.all(accounts.map(scanAccount));
  const alwaysExcluded = await matchingEmails(results.map((result) => result.chats), ALWAYS_EXCLUDED_HASHES);
  return { recorded, names: { pairs, byEmail }, byEmail, results, alwaysExcluded };
}

// Judges what scanChats read: the never-recorded chats, per account, with one summary line per account.
export function planAll(scan, { existing = new Set(), onlyKnown = true, minAgentMessages = 1, minCustomerMessages = 1, exclude = [], log = () => {} } = {}) {
  const excluded = new Set([...(scan.alwaysExcluded || []), ...exclude.map((email) => String(email).trim().toLowerCase()).filter(Boolean)]);
  const all = [];
  for (const result of scan.results) {
    const { account, chats, fetchedAlone, unjudged, outreach } = result;
    if (!result.configured) { log(`${account}: not configured, skipped.`); continue; }
    const stats = {};
    const entries = planEntries([...chats.values()], scan.recorded, existing, account, scan.names, { onlyKnown, stats, minAgentMessages, minCustomerMessages, exclude: excluded });
    log(`${account}: ${chats.size} ended chats with an agent message, ${entries.length} never recorded by an agent who uses the widget.${stats.excluded ? ` ${stats.excluded} chat/writer pairs left out: excluded emails.` : ""}${stats.unknownWriters ? ` ${stats.unknownWriters} chat/writer pairs left out: the writer is not in the Agent Logins table (customer service, bots, or an agent who has not opened the widget yet).` : ""}${stats.belowMinimum ? ` ${stats.belowMinimum} left out for having fewer messages than the minimum.` : ""}${outreach ? ` ${outreach} outreach-only chats (the customer never wrote, e.g. Blast) were left out.` : ""}${fetchedAlone ? ` ${fetchedAlone} chats had to be fetched one by one.` : ""}${unjudged ? ` ${unjudged} could NOT be judged (LiveChat refused them); run again to retry.` : ""}`);
    all.push(...entries);
  }
  return all;
}
