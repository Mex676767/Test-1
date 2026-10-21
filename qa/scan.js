const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW_CONCURRENCY = 3;

export async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next]; next += 1; await fn(item); }
  }));
}

export async function stepWithRetry(step, body, tries = 4, pauseMs = 2000) {
  for (let attempt = 1; ; attempt += 1) {
    const data = await step(body);
    if (data.ok || attempt >= tries || !/too many|rate.?limit|timeout|timed out|temporar|busy|unavailable|try again/i.test(data.error || "")) return data;
    await sleep(pauseMs * attempt);
  }
}

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

export function histogram(entries, field) {
  const buckets = [["1", (n) => n === 1], ["2", (n) => n === 2], ["3-5", (n) => n >= 3 && n <= 5], ["6+", (n) => n >= 6]];
  const counted = entries.filter((entry) => typeof entry[field] === "number");
  return buckets.map(([label, test]) => `${label}: ${counted.filter((entry) => test(entry[field])).length}`).join(", ");
}

export function summarize(entries) {
  const perWriter = new Map();
  for (const entry of entries) perWriter.set(entry.email, (perWriter.get(entry.email) || 0) + 1);
  return [...perWriter.entries()].sort((a, b) => b[1] - a[1]);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const archiveLink = (threadId) => `https://my.livechatinc.com/archives/${threadId}`;
export const myt = (ms) => (ms ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") : "");

export function sortedEntries(entries) {
  const perAgent = new Map(summarize(entries));
  return [...entries].sort((a, b) => perAgent.get(b.email) - perAgent.get(a.email) || a.email.localeCompare(b.email) || b.date - a.date);
}

export function toCsv(entries, byEmail = new Map()) {
  const perAgent = new Map(summarize(entries));
  const header = ["Agent", "Agent email", "Agent's unrecorded chats", "Date (MYT)", "Chat link", "Customer", "Agent messages", "Customer messages", "LiveChat account", "Unknown tick", "Username already on file", "QA verdict", "QA note"];
  const lines = [header, ...sortedEntries(entries).map((entry) => [
    byEmail.get(entry.email) || "", entry.email, perAgent.get(entry.email), myt(entry.date),
    archiveLink(entry.threadId), entry.customer, entry.agentMessages ?? "", entry.customerMessages ?? "", entry.account, MARK_LABELS[entry.mark] || "", entry.knownUsername || "", "", "",
  ])];
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

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

export const EXCLUDE_SALT = "rtn-qa-v1";
export const ALWAYS_EXCLUDED_HASHES = new Set([]);

export async function emailHash(email) {
  const data = new TextEncoder().encode(`${EXCLUDE_SALT}:${String(email).trim().toLowerCase()}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matchingEmails(chatMaps, hashes) {
  const writers = new Set();
  for (const chats of chatMaps) for (const chat of chats.values()) for (const writer of chat.writers || []) writers.add(String(writer).trim().toLowerCase());
  const found = new Set();
  for (const email of writers) if (hashes.has(await emailHash(email))) found.add(email);
  return found;
}

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

export function loggedIssues(row) {
  const issues = [];
  if (!row.inquiry || !row.inquiry.length) issues.push("No inquiry");
  if (!row.status) issues.push("No status");
  if (!row.username) issues.push("No username");
  if (!row.brand) issues.push("No brand");
  if (!row.link) issues.push("No chat link");
  return issues;
}

export const MARK_LABELS = {
  ticked: "Ticked Unknown",
  "ticked-auto": "Ticked Unknown (automatic: Look up said not VIP)",
  "not-ticked": "Not ticked: left without logging",
  untracked: "Before tick tracking",
};

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

export const HIDE_UNTRACKED_HASHES = new Set([
  "8558db0b41fcc9498d501dd7de34117faa290e573aaebcfee20dac0d2dad902c",
  "c9bbc994474dc2dc433c0c11710a8e2626e978cb813fd615c03f82044044f6c9",
]);

export const HIDE_UNTRACKED_BEFORE = Date.parse("2026-10-15T00:00:00+08:00");

export async function dropOwnUntracked(entries) {
  const hide = new Map();
  for (const email of new Set(entries.map((entry) => entry.email))) hide.set(email, HIDE_UNTRACKED_HASHES.has(await emailHash(email)));
  return entries.filter((entry) => !(entry.mark === "untracked" && hide.get(entry.email) && entry.date < HIDE_UNTRACKED_BEFORE));
}

export function countMarks(entries) {
  const counts = { ticked: 0, notTicked: 0, untracked: 0 };
  for (const entry of entries) {
    if (entry.mark === "ticked" || entry.mark === "ticked-auto") counts.ticked += 1;
    else if (entry.mark === "not-ticked") counts.notTicked += 1;
    else counts.untracked += 1;
  }
  return counts;
}

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

const sameName = (a, b) => String(a || "").trim().replace(/\s+/g, " ").toLowerCase() === String(b || "").trim().replace(/\s+/g, " ").toLowerCase();
const firstNumber = (value) => { const match = /-?\d+(?:\.\d+)?/.exec(String(value ?? "")); return match ? Number(match[0]) : null; };

export function checkClaim(claim, row) {
  const expectedAmount = firstNumber(claim.amount);
  return {
    expectedAmount,
    inquiryOk: claim.inquiry ? (row.inquiry || []).some((tag) => sameName(tag, claim.inquiry)) : null,
    amountOk: expectedAmount === null ? null : row.amount !== null && row.amount !== undefined && Number(row.amount) === expectedAmount,
  };
}

export function describeChatLog(data) {
  const claims = data.claims || [];
  const rows = (data.rows || []).map((row) => ({
    ...row,
    issues: loggedIssues(row),
    claims: claims.filter((claim) => sameName(claim.agent, row.agent)).map((claim) => ({ ...claim, ...checkClaim(claim, row) })),
  }));
  const orphanClaims = claims.filter((claim) => !rows.some((row) => sameName(row.agent, claim.agent)));
  const ticks = (data.ticks || []).map((tick) => ({ ...tick, label: tick.source === "auto" ? "automatic: the Look up said not VIP" : "ticked by the agent" }));
  const agents = [...new Set(rows.map((row) => String(row.agent || "").trim() || "(no agent name)"))];
  const mismatched = [...new Set([
    ...rows.filter((row) => row.claims.some((claim) => claim.inquiryOk === false || claim.amountOk === false)).map((row) => String(row.agent || "").trim() || "(no agent name)"),
    ...orphanClaims.map((claim) => claim.agent),
  ])];
  let verdict;
  let headline;
  if (rows.length) {
    verdict = mismatched.length ? "mismatch" : rows.some((row) => row.issues.length) ? "incomplete" : "logged";
    headline = mismatched.length
      ? `Logged, but the inquiry or amount does not match the bonus claimed: ${mismatched.join(", ")}`
      : `${verdict === "incomplete" ? "Logged, but something is missing: " : "Logged by "}${agents.join(", ")}`;
  } else if (orphanClaims.length) {
    verdict = "mismatch";
    headline = `Not logged: ${[...new Set(orphanClaims.map((claim) => claim.agent))].join(", ")} claimed a bonus on this chat but logged nothing`;
  } else if (ticks.length) {
    verdict = "ticked";
    headline = `Not logged: ${[...new Set(ticks.map((tick) => tick.agent))].join(", ")} ticked Unknown player on this chat`;
  } else {
    verdict = "nothing";
    headline = "Nothing was logged for this chat and nobody ticked Unknown player";
  }
  const since = data.tracking?.configured ? data.tracking.since : 0;
  const claimsSince = data.tracking?.configured ? data.tracking.claimsSince || 0 : 0;
  const notes = [];
  if (verdict === "nothing") notes.push(since ? `An Unknown tick is only recorded from ${myt(since)} (Malaysia time) on, so a chat older than that cannot tell you whether the agent ticked it.` : "Unknown ticks are not being recorded yet, so a tick could not have been saved.");
  if (rows.some((row) => String(row.status || "").trim().toLowerCase() === "given" && !row.claims.length)) {
    notes.push(claimsSince ? `Status is Given but no bonus claim was recorded for this agent. Claims are only recorded from ${myt(claimsSince)} (Malaysia time) on.` : "Status is Given but no bonus claim was recorded: claims are not being recorded yet.");
  }
  return { verdict, headline, rows, ticks, orphanClaims, note: notes.join(" ") };
}
