import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import {
  MAX_RANGE_DAYS, TRANSFER_LICENSES, WINDOW_BUFFER_MS, addThread, buildDirectory, classifyThread, klDay, klDayStartMs,
  newTotals, rfc3339,
} from "./_lib/transfer-count.js";

// Admin-only report: how many chats were transferred between groups. Read-only toward LiveChat (list_archives and the
// configuration list calls). One call handles one archive page; the admin page loops and adds the pages up.

const API = "https://api.livechatinc.com/v3.6";
const headers = { "Cache-Control": "no-store" };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const clean = (value) => String(value ?? "").trim();
const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function post(pat, path, payload) {
  const response = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (data?.error) throw new Error(clean(data.error.message) || JSON.stringify(data.error));
  if (!response.ok) throw new Error(`LiveChat answered HTTP ${response.status}`);
  return data;
}

const CACHE_MS = 10 * 60_000;
const directoryCache = new Map();
export function resetTransferDirectoryCache() { directoryCache.clear(); }

async function directoryFor(account) {
  const cached = directoryCache.get(account.pat);
  if (cached && cached.expires > Date.now()) return cached.value;
  const groups = await post(account.pat, "configuration/action/list_groups", {});
  if (!Array.isArray(groups)) throw new Error("Unexpected answer from LiveChat list_groups");
  let agents = [];
  let agentsError = "";
  try {
    const list = await post(account.pat, "configuration/action/list_agents", {});
    if (Array.isArray(list)) agents = list;
  } catch (err) { agentsError = err.message; }
  const value = { dir: buildDirectory(groups, agents), agentsError };
  directoryCache.set(account.pat, { value, expires: Date.now() + CACHE_MS });
  return value;
}

function groupNames(dir) {
  return Object.fromEntries(dir.names);
}

export async function handler(event) {
  try {
    const adminKey = clean(event.env?.SCAN_KEY);
    if (!adminKey) return reply(404, { ok: false, error: "Not found" });
    if (!sameKey(clean(event.headers?.["x-scan-key"]), adminKey)) return reply(401, { ok: false, error: "Wrong or missing admin key." });
    if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });

    const body = JSON.parse(event.body || "{}");
    const accountKey = clean(body.accountKey);
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    const license = TRANSFER_LICENSES[accountKey];
    if (!account || !license) return reply(400, { ok: false, error: "Pick a configured LiveChat license." });

    const isProbe = body.step === "probe";
    const chatId = clean(body.chatId);
    const fromMs = klDayStartMs(body.from);
    const toMs = klDayStartMs(body.to);
    if (isProbe) {
      if (!CHAT_ID_RE.test(chatId)) return reply(400, { ok: false, error: "A valid chat ID is required." });
    } else {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return reply(400, { ok: false, error: "Give a start date and a later end date (YYYY-MM-DD, Kuala Lumpur time)." });
      if ((toMs - fromMs) / 86_400_000 > MAX_RANGE_DAYS) return reply(400, { ok: false, error: `Choose at most ${MAX_RANGE_DAYS} days at a time.` });
    }

    const { dir, agentsError } = await directoryFor(account);
    const trackedMissing = license.tracked.filter((id) => !dir.names.has(String(id)));

    if (isProbe) {
      const data = await post(account.pat, "agent/action/list_archives", { filters: { chat_ids: [chatId] }, limit: 100 });
      const threads = (data?.chats || []).flatMap((chat) => {
        const thread = chat.thread || {};
        const { transfers, mismatch, finalGroups } = classifyThread(thread, license, dir);
        const raw = (thread.events || []).filter((item) => item?.type === "system_message" && /transfer/i.test(`${item.system_message_type} ${item.text}`));
        return [{
          chatId: clean(chat.id), threadId: clean(thread.id), createdAt: clean(thread.created_at), currentGroupIds: finalGroups, mismatch,
          rawTransferEvents: raw.map((item) => ({ created_at: item.created_at, system_message_type: item.system_message_type, text: item.text, text_vars: item.text_vars })),
          transfers: transfers.map((item) => ({
            at: Number.isFinite(item.at) ? new Date(item.at).toISOString() : "", day: Number.isFinite(item.at) ? klDay(item.at) : "",
            status: item.status, reason: item.reason || "", sourceId: item.sourceId, destId: item.destId, destinationParsed: item.targets,
          })),
        }];
      });
      return reply(200, { ok: true, accountKey, license: license.label, found: threads.length, threads, groups: groupNames(dir), trackedMissing, agentsError });
    }

    const pageId = clean(body.pageId);
    const payload = pageId
      ? { page_id: pageId }
      : { filters: { from: rfc3339(fromMs - WINDOW_BUFFER_MS), to: rfc3339(toMs + WINDOW_BUFFER_MS) }, limit: 100, sort_order: "asc" };
    const data = await post(account.pat, "agent/action/list_archives", payload);
    const totals = newTotals();
    const range = { fromMs, toMs };
    for (const chat of data?.chats || []) addThread(totals, chat, license, dir, range);
    return reply(200, {
      ok: true, accountKey, license: license.label, totals, nextPageId: clean(data?.next_page_id), found: data?.found_chats ?? null,
      groups: groupNames(dir), trackedMissing, agentsError,
    });
  } catch (err) {
    return reply(200, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
