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
// only (optional): a Set of lower-case emails; when given, nobody else is listed (the QA page's "who to check" filter).
// exclude: a Set of lower-case emails that are left out entirely (e.g. the admin's own logins); stats.excluded counts them.
export function planEntries(chats, recorded, existing, account, names = null, { onlyKnown = true, stats = {}, minAgentMessages = 1, minCustomerMessages = 1, exclude = new Set(), only = null } = {}) {
  const seen = new Set();
  const entries = [];
  for (const chat of chats) {
    for (const writer of chat.writers) {
      const email = String(writer).trim().toLowerCase();
      if (only && !only.has(email)) continue;
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
  const header = ["Agent", "Agent email", "Agent's unrecorded chats", "Date (MYT)", "Chat link", "Customer", "Agent messages", "Customer messages", "LiveChat account", "Unknown tick", "Username already on file", "QA verdict", "QA note"];
  const lines = [header, ...sortedEntries(entries).map((entry) => [
    byEmail.get(entry.email) || "", entry.email, perAgent.get(entry.email), myt(entry.date),
    archiveLink(entry.threadId), entry.customer, entry.agentMessages ?? "", entry.customerMessages ?? "", entry.account, MARK_LABELS[entry.mark] || "", entry.knownUsername || "", "", "",
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

// Logins that never belong in the list. Empty now: the admin's own two LiveChat logins were left out here at first and are included
// again (2026-10-14). To leave a login out, add its hash: a salted SHA-256 of the lower-case email, so the address is not readable
// in the public source (a hash only keeps the plain text out of sight: anyone who guesses an address can test it). The scan hashes
// the writers it actually met and drops the ones that match.
export const EXCLUDE_SALT = "rtn-qa-v1";
export const ALWAYS_EXCLUDED_HASHES = new Set([]);

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
export function planAll(scan, { existing = new Set(), onlyKnown = true, minAgentMessages = 1, minCustomerMessages = 1, exclude = [], only = null, log = () => {} } = {}) {
  const onlySet = only ? new Set(only.map((email) => String(email).trim().toLowerCase())) : null;
  const excluded = new Set([...(scan.alwaysExcluded || []), ...exclude.map((email) => String(email).trim().toLowerCase()).filter(Boolean)]);
  const all = [];
  for (const result of scan.results) {
    const { account, chats, fetchedAlone, unjudged, outreach } = result;
    if (!result.configured) { log(`${account}: not configured, skipped.`); continue; }
    const stats = {};
    const entries = planEntries([...chats.values()], scan.recorded, existing, account, scan.names, { onlyKnown, stats, minAgentMessages, minCustomerMessages, exclude: excluded, only: onlySet });
    log(`${account}: ${chats.size} ended chats with an agent message, ${entries.length} never recorded by an agent who uses the widget.${stats.excluded ? ` ${stats.excluded} chat/writer pairs left out: excluded emails.` : ""}${stats.unknownWriters ? ` ${stats.unknownWriters} chat/writer pairs left out: the writer is not in the Agent Logins table (customer service, bots, or an agent who has not opened the widget yet).` : ""}${stats.belowMinimum ? ` ${stats.belowMinimum} left out for having fewer messages than the minimum.` : ""}${outreach ? ` ${outreach} outreach-only chats (the customer never wrote, e.g. Blast) were left out.` : ""}${fetchedAlone ? ` ${fetchedAlone} chats had to be fetched one by one.` : ""}${unjudged ? ` ${unjudged} could NOT be judged (LiveChat refused them); run again to retry.` : ""}`);
    all.push(...entries);
  }
  return all;
}

// ---- What agents logged (Customer Approaching rows) --------------------------------------------------------------------------

// The agent names behind the built-in excluded logins: their logged rows are left out too (rows carry a name, not an email).
export async function excludedAgentNames(byEmail) {
  const names = new Set();
  for (const [email, name] of byEmail) if (name && ALWAYS_EXCLUDED_HASHES.has(await emailHash(email))) names.add(String(name).trim().toLowerCase());
  return names;
}

// Reads the rows agents logged in [fromMs, toMs), page by page, and drops the excluded agents'.
// onProgress(rowsScanned) after each page. Returns { rows, byEmail } -- the rows newest first within no particular agent order.
// only (optional): agent names; when given, only their rows are kept.
export async function loadLogged({ step, fromMs, toMs, only = null, onProgress = () => {}, isCancelled = () => false }) {
  const wanted = only && only.length ? new Set(only.map(nameKey)) : null;
  const agents = await step({ step: "agents" });
  if (!agents.ok) throw new Error(`agents: ${agents.error}`);
  const byEmail = new Map((agents.agents || []).map((agent) => [String(agent.email).toLowerCase(), agent.name]));
  const hidden = await excludedAgentNames(byEmail);
  const rows = [];
  let pageToken = "";
  let scanned = 0;
  do {
    if (isCancelled()) throw Object.assign(new Error("Stopped."), { cancelled: true });
    const data = await stepWithRetry(step, { step: "logged", fromMs, toMs, pageToken });
    if (!data.ok) throw new Error(`logged: ${data.error}`);
    for (const row of data.rows) if (!hidden.has(String(row.agent || "").trim().toLowerCase()) && (!wanted || wanted.has(nameKey(row.agent)))) rows.push(row);
    scanned += data.scanned || 0;
    onProgress(scanned);
    pageToken = data.next;
  } while (pageToken);
  return { rows, byEmail, hiddenAgents: hidden.size };
}

// What is obviously missing from a logged case. QA still judges whether what IS there matches the chat.
export function loggedIssues(row) {
  const issues = [];
  if (!row.inquiry || !row.inquiry.length) issues.push("No inquiry");
  if (!row.status) issues.push("No status");
  if (!row.username) issues.push("No username");
  if (!row.brand) issues.push("No brand");
  if (!row.link) issues.push("No chat link");
  return issues;
}

// [{ agent, total, incomplete }] the agents with the most logged chats first (names compared without letter case).
export function summarizeLogged(rows) {
  const perAgent = new Map();
  for (const row of rows) {
    const name = String(row.agent || "").trim() || "(no agent name)";
    const entry = perAgent.get(name.toLowerCase()) || { agent: name, total: 0, incomplete: 0 };
    entry.total += 1;
    if (loggedIssues(row).length) entry.incomplete += 1;
    perAgent.set(name.toLowerCase(), entry);
  }
  return [...perAgent.values()].sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
}

export const loggedLink = (row) => (row.threadId ? archiveLink(row.threadId) : row.link || "");

// The sheet for QA: one row per logged chat, agents with the most chats first, newest first within an agent.
export function toLoggedCsv(rows) {
  const rank = new Map(summarizeLogged(rows).map((entry, index) => [entry.agent.toLowerCase(), index]));
  const key = (row) => String(row.agent || "").trim().toLowerCase() || "(no agent name)";
  const sorted = [...rows].sort((a, b) => rank.get(key(a)) - rank.get(key(b)) || b.createdAt - a.createdAt);
  const header = ["Agent", "Date logged (MYT)", "Player username", "Brand", "Inquiry", "Status", "Released amount", "Missing", "Chat link", "QA verdict", "QA note"];
  const lines = [header, ...sorted.map((row) => [
    row.agent, myt(row.createdAt), row.username, row.brand, (row.inquiry || []).join(", "), row.status, row.amount ?? "", loggedIssues(row).join("; "), loggedLink(row), "", "",
  ])];
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---- Which unrecorded chats did the agent tick "Unknown player" on, and which did they just leave? -----------------------------

export const MARK_LABELS = {
  ticked: "Ticked Unknown",
  "ticked-auto": "Ticked Unknown (automatic: Look up said not VIP)",
  "not-ticked": "Not ticked: left without logging",
  untracked: "Before tick tracking",
};

// The ticks agents made (see functions/unknown-tick.js), all pages. configured: false when the site has no KV binding for them yet.
export async function loadTicks(step) {
  const ticks = [];
  let cursor = "";
  let configured = true;
  let since = 0;
  do {
    const data = await stepWithRetry(step, { step: "ticks", cursor });
    if (!data.ok) throw new Error(`ticks: ${data.error}`);
    configured = data.configured !== false;
    since = data.since || since;
    ticks.push(...(data.ticks || []));
    cursor = data.next;
  } while (cursor);
  return { ticks, configured, since };
}

const nameKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();

// Sets entry.mark on every unrecorded chat: ticked / ticked-auto when that agent ticked Unknown on that chat, otherwise not-ticked,
// except chats from before tracking began (or with tracking not set up), which cannot be judged: untracked.
// A tick made before the widget knew the thread is matched by chat id.
export function classifyEntries(entries, { ticks, configured, since }, byEmail) {
  const byThread = new Map();
  const byChat = new Map();
  for (const tick of ticks) {
    const agent = nameKey(tick.agent);
    if (tick.threadId) byThread.set(`${agent}|${tick.threadId}`, tick);
    else if (tick.chatId) byChat.set(`${agent}|${tick.chatId}`, tick);
  }
  for (const entry of entries) {
    const agent = nameKey(byEmail.get(entry.email));
    const tick = byThread.get(`${agent}|${entry.threadId}`) || byChat.get(`${agent}|${entry.chatId}`) || byChat.get(`${agent}|${entry.threadId}`);
    if (tick) entry.mark = tick.source === "auto" ? "ticked-auto" : "ticked";
    else if (!configured || !since || entry.date < since) entry.mark = "untracked";
    else entry.mark = "not-ticked";
  }
  return entries;
}

// Logins whose older "Before tracking" chats are not listed: the admin's own two. Their ticks from before tracking began were lost and cannot
// be judged, so those chats would only be noise; everything else of theirs still shows. Salted hashes, like ALWAYS_EXCLUDED_HASHES.
export const HIDE_UNTRACKED_HASHES = new Set([
  "8558db0b41fcc9498d501dd7de34117faa290e573aaebcfee20dac0d2dad902c",
  "c9bbc994474dc2dc433c0c11710a8e2626e978cb813fd615c03f82044044f6c9",
]);

// Only chats before this moment are hidden (15 Oct 2026, 00:00 Malaysian time): from that day on the admin's chats show like anyone's.
export const HIDE_UNTRACKED_BEFORE = Date.parse("2026-10-15T00:00:00+08:00");

// The entries without the "Before tracking" chats of the logins in HIDE_UNTRACKED_HASHES that are older than HIDE_UNTRACKED_BEFORE.
export async function dropOwnUntracked(entries) {
  const hide = new Map();
  for (const email of new Set(entries.map((entry) => entry.email))) hide.set(email, HIDE_UNTRACKED_HASHES.has(await emailHash(email)));
  return entries.filter((entry) => !(entry.mark === "untracked" && hide.get(entry.email) && entry.date < HIDE_UNTRACKED_BEFORE));
}

// { ticked, notTicked, untracked } counts (automatic ticks count as ticked).
export function countMarks(entries) {
  const counts = { ticked: 0, notTicked: 0, untracked: 0 };
  for (const entry of entries) {
    if (entry.mark === "ticked" || entry.mark === "ticked-auto") counts.ticked += 1;
    else if (entry.mark === "not-ticked") counts.notTicked += 1;
    else counts.untracked += 1;
  }
  return counts;
}

// ---- Choosing who to check -------------------------------------------------------------------------------------------------

// The agents to choose from: [{ name, emails }] by name (one name can have two LiveChat logins), A to Z, from the Agent Logins list.
export function agentChoices(agents) {
  const byName = new Map();
  for (const agent of agents || []) {
    const name = String(agent.name || "").trim().replace(/\s+/g, " ");
    if (!name || !agent.email) continue;
    const entry = byName.get(name.toLowerCase()) || { name, emails: [] };
    entry.emails.push(String(agent.email).trim().toLowerCase());
    byName.set(name.toLowerCase(), entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- "The agent ticked Unknown, but the customer already had a username on file" -------------------------------------------

// For the chats an agent ticked Unknown on by hand: asks whether the customer's chat was already recorded under a player username
// (the widget's "Last username recorded", found by the stable chat id) and sets entry.knownUsername. A chat the lookup could not
// answer is counted in failed and left unmarked. Returns { checked, found, failed }.
export async function checkKnownUsernames(entries, step, { onProgress = () => {}, isCancelled = () => false, concurrency = 3 } = {}) {
  const byChat = new Map();
  for (const entry of entries) if (entry.mark === "ticked" && entry.chatId) byChat.set(entry.chatId, [...(byChat.get(entry.chatId) || []), entry]);
  const result = { checked: 0, found: 0, failed: 0 };
  await pool([...byChat.entries()], concurrency, async ([chatId, list]) => {
    if (isCancelled()) throw Object.assign(new Error("Stopped."), { cancelled: true });
    const data = await stepWithRetry(step, { step: "lastusername", chatId });
    result.checked += 1;
    if (!data.ok) result.failed += 1;
    else if (data.found && data.username) { result.found += 1; for (const entry of list) entry.knownUsername = data.username; }
    onProgress(result.checked, byChat.size);
  });
  return result;
}

// ---- One chat: how was it logged? ------------------------------------------------------------------------------------------

// The thread id in whatever a person pastes: a LiveChat chat or archive link, or the id itself. "" when it is none of those.
export function threadFromInput(text) {
  const value = String(text || "").trim();
  const archive = /\/archives\/([A-Za-z0-9_-]{4,64})/.exec(value);
  if (archive) return archive[1];
  const live = /\/chats\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]{4,64})/.exec(value);
  if (live) return live[1];
  return /^[A-Za-z0-9_-]{4,64}$/.test(value) ? value : "";
}

// What QA should be told about one chat from the server's chatlog answer ({ rows, ticks, tracking }):
// verdict "logged" | "incomplete" | "ticked" | "nothing", a headline, the logged rows with what each is missing, and the ticks.
export function describeChatLog(data) {
  const rows = (data.rows || []).map((row) => ({ ...row, issues: loggedIssues(row) }));
  const ticks = (data.ticks || []).map((tick) => ({ ...tick, label: tick.source === "auto" ? "automatic: the Look up said not VIP" : "ticked by the agent" }));
  const agents = [...new Set(rows.map((row) => String(row.agent || "").trim() || "(no agent name)"))];
  let verdict;
  let headline;
  if (rows.length) {
    verdict = rows.some((row) => row.issues.length) ? "incomplete" : "logged";
    headline = `${verdict === "incomplete" ? "Logged, but something is missing: " : "Logged by "}${agents.join(", ")}`;
  } else if (ticks.length) {
    verdict = "ticked";
    headline = `Not logged: ${[...new Set(ticks.map((tick) => tick.agent))].join(", ")} ticked Unknown player on this chat`;
  } else {
    verdict = "nothing";
    headline = "Nothing was logged for this chat and nobody ticked Unknown player";
  }
  const since = data.tracking?.configured ? data.tracking.since : 0;
  const note = verdict === "nothing"
    ? (since ? `An Unknown tick is only recorded from ${myt(since)} (Malaysia time) on, so a chat older than that cannot tell you whether the agent ticked it.` : "Unknown ticks are not being recorded yet, so a tick could not have been saved.")
    : "";
  return { verdict, headline, rows, ticks, note };
}
