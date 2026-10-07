// Shared helpers for reading Customer Approaching rows back out of Lark --
// used by lark-stale-records.js (Needs Attention) and lark-chat-records.js
// (rebuilding a chat's card from Lark when the browser has no saved copy).
import { toDisplay, getRecord, searchRecords, larkClientStats, noteCounter, TABLE_CUSTOMER_APPROACHING } from "./lark.js";

export const CA = {
  username: "Username", brand: "Brand", agentName: "Agent Name", inquiry: "Inquiry", status: "Status",
  link: "link", amount: "Released amount", claimSecret: "Claim Secret", dob: "Player D.O.B", telegram: "Telegram",
  vs96FeedbackQuery1: "Query 1 Feedback (VS96 Feedback)",
  vs96FeedbackQuery2: "Query 2 Feedback (VS96 Feedback)",
};

// Every Customer Approaching column summarizeRow() reads. Searches that feed summarizeRow ask Lark for
// exactly these (plus automatic_fields), not the table's full row with all its lookup/formula columns.
// A test records the fields summarizeRow touches, so this list cannot silently fall behind it.
export const CA_SUMMARY_FIELDS = [
  CA.username, CA.brand, CA.agentName, CA.inquiry, CA.status, CA.link, CA.amount, CA.claimSecret,
  CA.dob, CA.telegram, CA.vs96FeedbackQuery1, CA.vs96FeedbackQuery2,
];

// "link" is a Lark Link field -- {link, text}, sometimes wrapped in an array.
export function linkUrl(v) {
  if (!v) return "";
  if (Array.isArray(v)) return linkUrl(v[0]);
  if (typeof v === "object") return String(v.link || v.text || "");
  return String(v);
}

// LiveChat links: /chats/{chat_id}/{thread_id} while live, /archives/{thread_id}
// once ended. The thread id (second id) is what every card is keyed by.
export function parseChatLink(url) {
  const s = String(url || "");
  const live = s.match(/\/chats\/([^/?#]+)\/([^/?#]+)/);
  if (live) return { chatId: live[1], threadId: live[2] };
  const archived = s.match(/\/archives\/([^/?#]+)/);
  if (archived) return { chatId: "", threadId: archived[1] };
  return { chatId: "", threadId: "" };
}

export function archiveUrl(threadId) {
  return threadId ? `https://my.livechatinc.com/archives/${threadId}` : "";
}

export function isBlank(v) {
  return toDisplay(v).trim() === "";
}

function toList(v) {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => toDisplay(x).trim()).filter(Boolean);
  return toDisplay(v).split(",").map((x) => x.trim()).filter(Boolean);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? toDisplay(v) : v);
  return Number.isFinite(n) ? n : null;
}

// Everything the widget needs to rebuild one case on a card.
export function summarizeRow(r) {
  const f = r.fields || {};
  const link = linkUrl(f[CA.link]).trim();
  return {
    recordId: r.record_id,
    username: toDisplay(f[CA.username]).trim(),
    brand: toDisplay(f[CA.brand]).trim(),
    agent: toDisplay(f[CA.agentName]).trim(),
    inquiry: toList(f[CA.inquiry]),
    status: toDisplay(f[CA.status]).trim(),
    amount: toNumberOrNull(f[CA.amount]),
    claimSecret: f[CA.claimSecret] === true,
    telegram: f[CA.telegram] === true,
    dob: typeof f[CA.dob] === "number" ? f[CA.dob] : null,
    vs96FeedbackQuery1: toDisplay(f[CA.vs96FeedbackQuery1]).trim(),
    vs96FeedbackQuery2: toDisplay(f[CA.vs96FeedbackQuery2]).trim(),
    link,
    threadId: parseChatLink(link).threadId,
    createdAt: Number(r.created_time) || 0,
  };
}

// Who a Customer Approaching row belongs to. When a chat gets transferred
// (agent's PC crashed / lost connection), each agent keeps their OWN row --
// so nothing may ever delete or overwrite a row stamped with a different
// Agent Name. A row with no Agent Name (older data) belongs to nobody yet.
export async function readOwnership(recordId) {
  const rec = await getRecord(TABLE_CUSTOMER_APPROACHING, recordId);
  const f = (rec && rec.fields) || {};
  return {
    owner: toDisplay(f[CA.agentName]).trim(),
    blank: isBlank(f[CA.inquiry]) && isBlank(f[CA.status]),
  };
}

// Who owns this row, WITHOUT a single-record GET in the common case: one search by Username (columns Agent Name / Inquiry / Status
// only). The queue merges concurrent searches for different usernames into one Lark query, so many submits at once cost a few
// calls instead of one GET each. The row is found by record_id in the answer.
//
// The search may only ALLOW a write, and only when it says the row's owner is exactly THIS agent. Anything else -- the row is not in
// the result (index lag, the agent changed the username, an old widget that sends no username), the owner is blank, the owner is
// someone else, the search failed -- is decided by the ordinary single-record GET, i.e. by Lark's current truth. Each fallback is
// counted by reason (larkClientStats.ownershipFallbackReasons, and reported to the queue's stats).
export async function readOwnershipMerged(recordId, username, agentName) {
  const name = String(username || "").trim().toLowerCase();
  const me = String(agentName || "").trim();
  let reason = !name ? "noUsername" : !me ? "noAgent" : "";
  if (!reason) {
    try {
      const rows = await searchRecords(TABLE_CUSTOMER_APPROACHING, [{ field_name: CA.username, operator: "is", value: [name] }], undefined,
        { fieldNames: [CA.agentName, CA.inquiry, CA.status], pageSize: 500, timeoutMs: 15_000 });
      const row = rows.find((r) => r.record_id === recordId);
      if (!row) reason = "missing";
      else {
        const f = row.fields || {};
        const owner = toDisplay(f[CA.agentName]).trim();
        if (owner && owner === me) return { owner, blank: isBlank(f[CA.inquiry]) && isBlank(f[CA.status]), via: "search" };
        reason = owner ? "otherOwner" : "blankOwner";
      }
    } catch (_) { reason = "searchError"; }
  }
  larkClientStats.ownershipFallbacks++;
  larkClientStats.ownershipFallbackReasons[reason] = (larkClientStats.ownershipFallbackReasons[reason] || 0) + 1;
  noteCounter(`ownershipFallback:${reason}`);
  return { ...(await readOwnership(recordId)), via: "get" };
}

export function ownedBy(owner, agent) {
  return !owner || owner === String(agent || "").trim();
}
