import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { searchPage, createRecord, toDisplay, TABLE_CUSTOMER_APPROACHING, TABLE_UNRECORDED } from "./_lib/lark.js";
import { CA, linkUrl, parseChatLink } from "./_lib/ca-row.js";
import { agentWroteIn } from "./livechat-agent-wrote.js";
import { UNREC } from "./_lib/unrecorded.js";

// One-time crosscheck, driven by scripts/crosscheck-unrecorded.mjs: which chats since a start date did an agent write in
// but nobody ever recorded? The result goes into the Lark table "Unrecorded Chats" (one row per chat and writer), and each
// agent's widget then lists their own rows. Not authentication for agents: this is an ADMIN endpoint, answered only to a
// caller that sends the key in the SCAN_KEY environment variable (header x-scan-key); with no key set it does not exist.
//
// Each call is one small step so it stays inside a Pages Function's limits and never hogs the shared Lark queue:
//   recorded  one page of Customer Approaching -> the chat (thread) ids of rows created since `fromMs`
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

// LiveChat wants RFC 3339 with microseconds: 2026-10-07T00:00:00.000000+00:00.
export function larkTime(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

// The ended chats of one list_archives page that an agent wrote in. Active chats are skipped (not over yet).
export function chatsWithWriters(archive) {
  const out = [];
  for (const chat of archive?.chats || []) {
    const thread = chat.thread || {};
    if (!thread.id || thread.active !== false) continue;
    const agentIds = new Set((chat.users || []).filter((user) => user.type === "agent").map((user) => clean(user.id).toLowerCase()));
    const { authors } = agentWroteIn(chat, []);
    // A chatbot or integration can also author messages; only people who joined the chat as agents count.
    const writers = authors.filter((author) => !agentIds.size || agentIds.has(author));
    if (!writers.length) continue;
    const customer = (chat.users || []).find((user) => user.type === "customer");
    const when = Date.parse(thread.created_at || (thread.events || [])[0]?.created_at || "") || 0;
    out.push({ chatId: clean(chat.id), threadId: clean(thread.id), date: when, customer: clean(customer?.name), writers });
  }
  return out;
}

async function listArchives(account, { from, to, pageId }) {
  const response = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_archives", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + account.pat },
    body: JSON.stringify({ filters: { from: larkTime(from), to: larkTime(to) }, limit: 100, sort_order: "asc", ...(pageId ? { page_id: pageId } : {}) }),
  });
  const data = await response.json();
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

export async function handler(event) {
  try {
    const expected = clean(event.env?.SCAN_KEY);
    if (!expected) return reply(404, { ok: false, error: "Not found" });
    if (!sameKey(clean(event.headers?.["x-scan-key"]), expected)) return reply(401, { ok: false, error: "Wrong key" });
    const body = JSON.parse(event.body || "{}");

    if (body.step === "recorded") {
      const fromMs = Number(body.fromMs) || 0;
      const page = await searchPage(TABLE_CUSTOMER_APPROACHING, [], { pageSize: 500, pageToken: clean(body.pageToken), automaticFields: true, fieldNames: [CA.link] });
      const threads = new Set();
      for (const item of page.items) {
        if (Number(item.created_time) < fromMs) continue;
        const threadId = parseChatLink(linkUrl(item.fields?.[CA.link])).threadId;
        if (threadId) threads.add(threadId);
      }
      return reply(200, { ok: true, threads: [...threads], next: page.next, rows: page.items.length });
    }

    if (!TABLE_UNRECORDED) return reply(200, { ok: false, error: "LARK_TABLE_UNRECORDED is not set." });

    if (body.step === "existing") {
      const page = await searchPage(TABLE_UNRECORDED, [], { pageSize: 500, pageToken: clean(body.pageToken), fieldNames: [UNREC.thread, UNREC.email] });
      const keys = page.items.map((item) => `${clean(toDisplay(item.fields?.[UNREC.thread]))}|${clean(toDisplay(item.fields?.[UNREC.email])).toLowerCase()}`);
      return reply(200, { ok: true, keys, next: page.next });
    }

    if (body.step === "archives") {
      const account = LIVECHAT_ACCOUNTS.find((item) => item.key === body.account);
      if (!account) return reply(200, { ok: false, error: `LiveChat account ${body.account} is not configured.` });
      const data = await listArchives(account, { from: Number(body.from), to: Number(body.to), pageId: clean(body.pageId) });
      const chats = chatsWithWriters(data);
      // An ended chat whose messages did not come with the page cannot be judged from it: hand it back to be fetched alone.
      const pending = (data.chats || [])
        .filter((chat) => chat.thread?.id && chat.thread.active === false && !Array.isArray(chat.thread.events))
        .map((chat) => ({ chatId: clean(chat.id), threadId: clean(chat.thread.id) }));
      return reply(200, { ok: true, chats, pending, next: clean(data.next_page_id), seen: (data.chats || []).length, found: data.found_chats ?? null });
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
      const [chat = null] = chatsWithWriters({ chats: [{ id: data.id || body.chatId, users: data.users, thread: data.thread }] });
      return reply(200, { ok: true, chat });
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
