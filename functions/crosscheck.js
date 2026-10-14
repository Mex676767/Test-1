import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { searchPage, createRecord, toDisplay, TABLE_CUSTOMER_APPROACHING, TABLE_UNRECORDED, TABLE_AGENT_LOGINS } from "./_lib/lark.js";
import { CA, CA_SUMMARY_FIELDS, linkUrl, parseChatLink, summarizeRow } from "./_lib/ca-row.js";
import { agentWroteIn } from "./livechat-agent-wrote.js";
import { findLastUsername } from "./lark-last-username.js";
import { UNREC } from "./_lib/unrecorded.js";

// One-time crosscheck, driven by scripts/crosscheck-unrecorded.mjs: which chats since a start date did an agent write in
// but nobody ever recorded? The result goes into the Lark table "Unrecorded Chats" (one row per chat and writer), and each
// agent's widget then lists their own rows. Not authentication for agents: this is an ADMIN endpoint, answered only to a
// caller that sends the key in the SCAN_KEY environment variable (header x-scan-key); with no key set it does not exist.
// The QA page (qa/index.html) gets in with a LiveChat sign-in instead, read-only (see checkQaLogin).
//
// Each call is one small step so it stays inside a Pages Function's limits and never hogs the shared Lark queue:
//   recorded  one page of Customer Approaching -> the chat (thread) ids of rows created since `fromMs`, and "thread|agent name"
//             pairs, so a chat can be judged per agent when the agent is known
//   logged    one page of Customer Approaching -> what agents logged (agent, player, brand, inquiry, status, amount, chat link) for
//             rows created in a time window: the QA page shows it beside the chat
//   lastusername  the player this chat's customer was last recorded under, if any (the widget's "Last username recorded")
//   ticks     one page of the "Unknown player" ticks agents made (KV, see unknown-tick.js) and when tracking began
//   agents    the Agent Logins table -> which LiveChat email belongs to which agent name (only logins whose email is filled in)
//   existing  one page of the Unrecorded Chats table -> "thread|email" keys already written (so a re-run adds no twins)
//   archives  one page of LiveChat's archive for one account and time window -> ended chats with who wrote in them, plus the
//             ended chats that came WITHOUT their messages (`pending`)
//   chat      one such pending chat, fetched on its own -> who wrote in it (so nothing is left unjudged)
//   write     up to 25 rows into the Unrecorded Chats table

const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const clean = (value) => String(value ?? "").trim();

function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Who is QA? Rows of the Agent Logins table whose "Role" column says QA, matched on the LiveChat email or the LiveChat login
// (the id LiveChat gives the signed-in person). The admin types the email of each QA person into a row of that table; the
// person needs no agent name there. This is the one place that decides: a later "group" rule only has to change this function.
const ROLE_QA = /(^|[\s,;/|])qa($|[\s,;/|])/i;
const QA_CACHE_MS = 60_000;
const qaCache = new Map(); // "account:token" -> { result, expires }: a long scan sends hundreds of steps, the token is checked once a minute
export function resetQaCache() { qaCache.clear(); }

export async function checkQaLogin(env, accountKey, token) {
  const cacheKey = `${accountKey}:${token}`;
  const cached = qaCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;
  let result;
  if (!["lc1", "lc2"].includes(accountKey)) {
    result = { ok: false, error: "LiveChat account is required." };
  } else {
    const pat = LIVECHAT_ACCOUNTS.find((account) => account.key === accountKey)?.pat || "";
    const who = await identifyAgent(env, accountKey, token, { withEmail: true, pat });
    if (!who.ok) {
      result = { ok: false, error: who.error };
    } else {
      const identities = new Set(who.identities);
      let qa = false;
      let pageToken = "";
      do {
        const page = await searchPage(TABLE_AGENT_LOGINS, [], { pageSize: 500, pageToken });
        for (const item of page.items) {
          const fields = item.fields || {};
          if (!ROLE_QA.test(clean(toDisplay(fields["Role"])))) continue;
          if (identities.has(clean(toDisplay(fields["Livechat Email"])).toLowerCase()) || identities.has(clean(toDisplay(fields["LiveChat Login"])).toLowerCase())) qa = true;
        }
        pageToken = page.next;
      } while (pageToken && !qa);
      result = { ok: true, qa };
    }
  }
  if (qaCache.size > 200) qaCache.clear();
  qaCache.set(cacheKey, { result, expires: Date.now() + QA_CACHE_MS });
  return result;
}

// LiveChat wants RFC 3339 with microseconds: 2026-10-07T00:00:00.000000+00:00.
export function larkTime(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

// A message, file or rich message the customer sent to the agents (not a note between agents).
const CONVERSATION = new Set(["message", "file", "rich_message"]);
// How many customer-facing messages each non-customer author and the customer wrote in the thread.
function messageCounts(chat) {
  const customers = new Set((chat.users || []).filter((user) => user.type === "customer").map((user) => clean(user.id).toLowerCase()));
  const perAuthor = {};
  let customer = 0;
  for (const event of chat.thread?.events || []) {
    if (!CONVERSATION.has(event.type) || event.visibility === "agents") continue;
    const author = clean(event.author_id).toLowerCase();
    if (customers.has(author)) customer += 1;
    else perAuthor[author] = (perAuthor[author] || 0) + 1;
  }
  return { perAuthor, customer };
}

// The ended chats of one list_archives page that an agent wrote in. Active chats are skipped (not over yet), and so is a
// thread where the customer never wrote: that is the agent reaching out (a Blast reopens old chats just to send one
// message), not a conversation with something to record. stats.outreach counts those, so the run can say how many.
export function chatsWithWriters(archive, stats = {}) {
  const out = [];
  for (const chat of archive?.chats || []) {
    const thread = chat.thread || {};
    if (!thread.id || thread.active !== false) continue;
    const agentIds = new Set((chat.users || []).filter((user) => user.type === "agent").map((user) => clean(user.id).toLowerCase()));
    const { authors } = agentWroteIn(chat, []);
    // A chatbot or integration can also author messages; only people who joined the chat as agents count.
    const writers = authors.filter((author) => !agentIds.size || agentIds.has(author));
    if (!writers.length) continue;
    const { perAuthor, customer: customerMessages } = messageCounts(chat);
    if (!customerMessages) { stats.outreach = (stats.outreach || 0) + 1; continue; }
    const customer = (chat.users || []).find((user) => user.type === "customer");
    const when = Date.parse(thread.created_at || (thread.events || [])[0]?.created_at || "") || 0;
    out.push({
      chatId: clean(chat.id), threadId: clean(thread.id), date: when, customer: clean(customer?.name), writers,
      counts: Object.fromEntries(writers.map((writer) => [writer, perAuthor[writer] || 0])), customerMessages,
    });
  }
  return out;
}

async function listArchives(account, { from, to, pageId }) {
  const response = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_archives", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + account.pat },
    // LiveChat refuses filters, limit and sort_order together with page_id: a later page is asked for by its id alone.
    body: JSON.stringify(pageId ? { page_id: pageId } : { filters: { from: larkTime(from), to: larkTime(to) }, limit: 100, sort_order: "asc" }),
  });
  const data = await response.json();
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

export async function handler(event) {
  try {
    // Two ways in. SCAN_KEY (the admin: every step, including the ones that write the Unrecorded Chats table), or a LiveChat
    // sign-in (headers x-livechat-account + x-livechat-token) of someone marked QA in the Agent Logins table: only the steps
    // that read, so QA gets the list without the means to write.
    const adminKey = clean(event.env?.SCAN_KEY);
    if (!adminKey && !TABLE_AGENT_LOGINS) return reply(404, { ok: false, error: "Not found" });
    const isAdmin = sameKey(clean(event.headers?.["x-scan-key"]), adminKey);
    if (!isAdmin) {
      const token = clean(event.headers?.["x-livechat-token"]);
      if (!token) return reply(401, { ok: false, error: "Sign in with LiveChat (or send the scan key)." });
      const check = await checkQaLogin(event.env, clean(event.headers?.["x-livechat-account"]).toLowerCase(), token);
      if (!check.ok) return reply(401, { ok: false, loginExpired: true, error: check.error });
      if (!check.qa) return reply(403, { ok: false, error: "This LiveChat login is not marked QA in the tracker." });
    }
    const body = JSON.parse(event.body || "{}");
    if (!isAdmin && (body.step === "existing" || body.step === "write")) return reply(403, { ok: false, error: "QA can only read." });

    if (body.step === "recorded") {
      const fromMs = Number(body.fromMs) || 0;
      const page = await searchPage(TABLE_CUSTOMER_APPROACHING, [], { pageSize: 500, pageToken: clean(body.pageToken), automaticFields: true, fieldNames: [CA.link, CA.agentName] });
      const threads = new Set();
      const pairs = new Set();
      for (const item of page.items) {
        if (Number(item.created_time) < fromMs) continue;
        const threadId = parseChatLink(linkUrl(item.fields?.[CA.link])).threadId;
        if (!threadId) continue;
        threads.add(threadId);
        const agent = clean(toDisplay(item.fields?.[CA.agentName])).toLowerCase();
        if (agent) pairs.add(`${threadId}|${agent}`);
      }
      return reply(200, { ok: true, threads: [...threads], pairs: [...pairs], next: page.next, rows: page.items.length });
    }

    if (body.step === "logged") {
      // What the agents logged: one page of Customer Approaching rows created in [fromMs, toMs), for QA to compare with the chat. The
      // player's date of birth and claim secret are never sent.
      const fromMs = Number(body.fromMs) || 0;
      const toMs = Number(body.toMs) || Infinity;
      const page = await searchPage(TABLE_CUSTOMER_APPROACHING, [], { pageSize: 500, pageToken: clean(body.pageToken), automaticFields: true, fieldNames: CA_SUMMARY_FIELDS });
      const rows = page.items
        .filter((item) => Number(item.created_time) >= fromMs && Number(item.created_time) < toMs)
        .map((item) => {
          const row = summarizeRow(item);
          return {
            recordId: row.recordId, createdAt: row.createdAt, agent: row.agent, username: row.username, brand: row.brand, inquiry: row.inquiry,
            status: row.status, amount: row.amount, telegram: row.telegram, link: row.link, threadId: row.threadId,
          };
        });
      return reply(200, { ok: true, rows, next: page.next, scanned: page.items.length });
    }

    if (body.step === "lastusername") {
      // Did this customer's chat already have a player username on file (the widget's "Last username recorded")? Any brand.
      const chatId = clean(body.chatId);
      if (!chatId || chatId.length > 80) return reply(400, { ok: false, error: "chatId is required." });
      try {
        const match = await findLastUsername(chatId);
        return reply(200, { ok: true, found: Boolean(match), username: match?.username || "", brand: match?.brand || "" });
      } catch (error) {
        return reply(200, { ok: false, error: error.message });
      }
    }

    if (body.step === "ticks") {
      // The "Unknown player" ticks agents made (see unknown-tick.js), one page of the KV list at a time, and when tracking began.
      const kv = event.env?.UNKNOWN_TICKS;
      if (!kv) return reply(200, { ok: true, configured: false, ticks: [], next: "", since: 0 });
      const listed = await kv.list({ prefix: "t:", limit: 1000, ...(clean(body.cursor) ? { cursor: clean(body.cursor) } : {}) });
      const ticks = listed.keys.map((key) => key.metadata).filter((meta) => meta && meta.agent);
      const since = Number(await kv.get("meta:since")) || 0;
      return reply(200, { ok: true, configured: true, ticks, next: listed.list_complete ? "" : clean(listed.cursor), since });
    }

    if (body.step === "agents") {
      if (!TABLE_AGENT_LOGINS) return reply(200, { ok: true, agents: [] });
      const agents = [];
      let pageToken = "";
      do {
        const page = await searchPage(TABLE_AGENT_LOGINS, [], { pageSize: 500, pageToken });
        for (const item of page.items) {
          const email = clean(toDisplay(item.fields?.["Livechat Email"])).toLowerCase();
          const name = clean(toDisplay(item.fields?.["Agent Name"]));
          if (email && name) agents.push({ email, name, account: clean(toDisplay(item.fields?.["LiveChat Account"])).toLowerCase() });
        }
        pageToken = page.next;
      } while (pageToken);
      return reply(200, { ok: true, agents });
    }

    // Only the steps that use the Unrecorded Chats table need it: scanning the archives works without it.
    if (!TABLE_UNRECORDED && (body.step === "existing" || body.step === "write")) return reply(200, { ok: false, error: "LARK_TABLE_UNRECORDED is not set." });

    if (body.step === "existing") {
      const page = await searchPage(TABLE_UNRECORDED, [], { pageSize: 500, pageToken: clean(body.pageToken), fieldNames: [UNREC.thread, UNREC.email] });
      const keys = page.items.map((item) => `${clean(toDisplay(item.fields?.[UNREC.thread]))}|${clean(toDisplay(item.fields?.[UNREC.email])).toLowerCase()}`);
      return reply(200, { ok: true, keys, next: page.next });
    }

    if (body.step === "archives") {
      const account = LIVECHAT_ACCOUNTS.find((item) => item.key === body.account);
      if (!account) return reply(200, { ok: false, error: `LiveChat account ${body.account} is not configured.` });
      const data = await listArchives(account, { from: Number(body.from), to: Number(body.to), pageId: clean(body.pageId) });
      const stats = {};
      const chats = chatsWithWriters(data, stats);
      // An ended chat whose messages did not come with the page cannot be judged from it: hand it back to be fetched alone.
      const pending = (data.chats || [])
        .filter((chat) => chat.thread?.id && chat.thread.active === false && !Array.isArray(chat.thread.events))
        .map((chat) => ({ chatId: clean(chat.id), threadId: clean(chat.thread.id) }));
      return reply(200, { ok: true, chats, pending, outreach: stats.outreach || 0, next: clean(data.next_page_id), seen: (data.chats || []).length, found: data.found_chats ?? null });
    }

    if (body.step === "chat") {
      const account = LIVECHAT_ACCOUNTS.find((item) => item.key === body.account);
      if (!account || !clean(body.chatId) || !clean(body.threadId)) return reply(400, { ok: false, error: "account, chatId and threadId are required." });
      const response = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + account.pat },
        body: JSON.stringify({ chat_id: clean(body.chatId), thread_id: clean(body.threadId) }),
      });
      const data = await response.json();
      if (data?.error) return reply(200, { ok: false, error: data.error.message || JSON.stringify(data.error) });
      const stats = {};
      const [chat = null] = chatsWithWriters({ chats: [{ id: data.id || body.chatId, users: data.users, thread: data.thread }] }, stats);
      return reply(200, { ok: true, chat, outreach: stats.outreach || 0 });
    }

    if (body.step === "write") {
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 25) : [];
      let created = 0;
      const failed = [];
      for (const entry of entries) {
        const email = clean(entry.email).toLowerCase();
        if (!clean(entry.threadId) || !email) { failed.push({ threadId: entry.threadId, error: "threadId and email are required" }); continue; }
        try {
          await createRecord(TABLE_UNRECORDED, {
            [UNREC.thread]: clean(entry.threadId), [UNREC.chat]: clean(entry.chatId), [UNREC.account]: clean(entry.account), [UNREC.email]: email,
            [UNREC.date]: Number(entry.date) || undefined, [UNREC.customer]: clean(entry.customer), [UNREC.status]: "Open",
          });
          created += 1;
        } catch (error) {
          failed.push({ threadId: entry.threadId, error: error.message });
        }
      }
      return reply(200, { ok: true, created, failed });
    }

    return reply(400, { ok: false, error: "Unknown step" });
  } catch (err) {
    return reply(200, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
