import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_PATS } from "./_lib/livechat.js";

// Resolves the LiveChat group(s) a chat belongs to into a real group name,
// e.g. "NOW32 Priority Support", via LiveChat's own APIs. Brand
// auto-detection then runs that name through deriveBrandFromGroup() in
// app.js.
//
// Auth note: each LIVECHAT_PAT must be the "Base64 Encoded Token" shown on
// the token-creation screen (base64(AccountID:Token)), NOT the raw "Token".
//
// WHY THIS NOW CHECKS THE CHAT'S OWNER ACCOUNT FIRST (2026-09-21): a group
// ID is only unique WITHIN one LiveChat account. With two accounts' chats
// reaching this widget, the same number can mean "SPIN GENERAL" in one
// account and a NOW32 group in the other. The old version tried each
// account's group list in order and returned the first hit -- so a NOW32
// chat whose group ID happened to exist in the first account came back as
// "SPIN GENERAL" and Brand auto-filled as SPIN. Now: find which account
// actually owns this chat's thread, read the chat's own group list from
// THAT account, and resolve the names only against that account's groups.
//
// ONLY a "<BRAND> Priority Support" group is ever used for Brand. Every
// other group (General, "X GENERAL", "Priority 96", "Priority TC", a bare
// brand group...) is ignored -- if the chat has no Priority Support group,
// Brand is left blank for a manual pick rather than guessed.
const groupsCacheByPat = new Map(); // pat -> { data, expiry }

// Tolerant on purpose: also matches a typo'd "Priorty Support".
const PRIORITY_RE = /prior\w*\s+support/i;

async function fetchGroups(pat) {
  const now = Date.now();
  const cached = groupsCacheByPat.get(pat);
  if (cached && now < cached.expiry) return cached.data;

  const res = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || "Unexpected response from LiveChat list_groups";
    throw new Error(msg);
  }

  groupsCacheByPat.set(pat, { data, expiry: now + 10 * 60_000 });
  return data;
}

async function agentAction(pat, action, payload) {
  const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

// Which configured account owns this thread? (A thread only ever exists
// under one account.) Same thread-id matching livechat-chat-status.js uses.
async function findThreadOwner(threadId, realChatId) {
  for (const pat of LIVECHAT_PATS) {
    try {
      if (realChatId) {
        const chat = await agentAction(pat, "get_chat", { chat_id: realChatId });
        if (chat && chat.thread) return { pat, chatId: realChatId };
        continue;
      }
      const data = await agentAction(pat, "list_chats", { limit: 100, sort_order: "desc" });
      const m = (data.chats_summary || []).find(
        (c) => c.last_thread_summary && String(c.last_thread_summary.id) === String(threadId)
      );
      if (m) return { pat, chatId: m.id };
    } catch (_) { /* this account can't see it -- try the next */ }
  }
  return null;
}

function groupIdsOf(chat) {
  const t = (chat && (chat.thread || chat.last_thread_summary)) || {};
  const ids = (t.access && t.access.group_ids) || (chat && chat.access && chat.access.group_ids) || [];
  return ids.map(String);
}

export async function handler(event) {
  try {
    if (!LIVECHAT_PATS.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null }) };
    }
    const { groupID, threadId, realChatId } = JSON.parse(event.body || "{}");
    if (!groupID && !threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "groupID or threadId is required" }) };
    }

    // 1) Preferred: resolve inside the account that owns this chat.
    if (threadId) {
      const owner = await findThreadOwner(threadId, realChatId);
      if (owner) {
        let ids = [];
        try {
          const chat = await agentAction(owner.pat, "get_chat", { chat_id: owner.chatId, thread_id: threadId });
          ids = groupIdsOf(chat);
        } catch (_) { /* fall back to just the SDK's own group id below */ }
        if (groupID) ids.push(String(groupID)); // meaningful here: it's scoped to the right account now
        ids = [...new Set(ids)];

        const groups = await fetchGroups(owner.pat);
        const names = ids
          .map((id) => groups.find((g) => String(g.id) === id))
          .filter(Boolean)
          .map((g) => g.name);
        const chosen = names.find((n) => PRIORITY_RE.test(n)) || null;
        if (chosen) {
          return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: chosen, groups: names, resolvedBy: "chat-owner-account" }) };
        }
        // The owning account IS known, so don't fall through to the
        // cross-account guess below -- just report there's no Priority
        // Support group and leave Brand for a manual pick.
        return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, groups: names, error: `Chat isn't in a Priority Support group (its groups: ${names.length ? names.join(", ") : "none found"}) — Brand left blank.` }) };
      }
    }

    // 2) Fallback -- couldn't determine the chat's account. Only trust a
    // group ID if it means ONE thing across every account; if it exists in
    // several accounts under different names, guessing is what caused the
    // wrong-brand bug, so leave Brand blank for a manual pick instead.
    if (!groupID) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: "Couldn't determine which LiveChat account this chat belongs to." }) };
    }
    const hits = [];
    let lastErr = null;
    for (const pat of LIVECHAT_PATS) {
      try {
        const groups = await fetchGroups(pat);
        const match = groups.find((g) => String(g.id) === String(groupID));
        if (match && PRIORITY_RE.test(match.name)) hits.push(match.name); // non-Priority-Support groups never count
      } catch (err) {
        lastErr = err;
      }
    }
    const distinct = [...new Set(hits)];
    if (distinct.length === 1) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: distinct[0], groups: distinct, resolvedBy: "unique-group-id" }) };
    }
    if (distinct.length > 1) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: `Group ID ${groupID} exists in more than one LiveChat account (${distinct.join(" / ")}) and this chat's account couldn't be determined — pick Brand manually.` }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: lastErr ? lastErr.message : undefined }) };
  } catch (err) {
    // Non-fatal by design (200, not 500) — Brand just stays a manual pick.
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
