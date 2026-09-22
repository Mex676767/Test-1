// Shared helpers for reading Customer Approaching rows back out of Lark --
// used by lark-stale-records.js (Needs Attention) and lark-chat-records.js
// (rebuilding a chat's card from Lark when the browser has no saved copy).
import { toDisplay } from "./lark.js";

export const CA = {
  username: "Username", brand: "Brand", agentName: "Agent Name", inquiry: "Inquiry", status: "Status",
  link: "link", amount: "Released amount", claimSecret: "Claim Secret", dob: "Player D.O.B", telegram: "Telegram",
};

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
    link,
    threadId: parseChatLink(link).threadId,
    createdAt: Number(r.created_time) || 0,
  };
}
