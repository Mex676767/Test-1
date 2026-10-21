import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_PATS, accountKeyForPat } from "./_lib/livechat.js";

const groupsCacheByPat = new Map();

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

async function findThreadOwner(threadId, realChatId) {
  for (const pat of LIVECHAT_PATS) {
    try {
      if (realChatId) {
        const chat = await agentAction(pat, "get_chat", { chat_id: realChatId });
        if (chat && chat.thread) return { pat, chatId: realChatId, accountKey: accountKeyForPat(pat) };
        continue;
      }
      const data = await agentAction(pat, "list_chats", { limit: 100, sort_order: "desc" });
      const m = (data.chats_summary || []).find(
        (c) => c.last_thread_summary && String(c.last_thread_summary.id) === String(threadId)
      );
      if (m) return { pat, chatId: m.id, accountKey: accountKeyForPat(pat) };
    } catch (_) { }
  }
  return null;
}

function groupIdsOf(chat) {
  const t = (chat && (chat.thread || chat.last_thread_summary)) || {};
  const ids = (t.access && t.access.group_ids) || (chat && chat.access && chat.access.group_ids) || [];
  return ids.map(String);
}

async function departmentGroupsForSignedInAgent(pat, agentToken, groups) {
  if (!agentToken) return null;
  try {
    const infoRes = await fetch("https://accounts.livechat.com/v2/info", {
      headers: { Authorization: "Bearer " + agentToken },
    });
    const info = await infoRes.json();
    const agentId = String(info?.account_id || "");
    if (!agentId) return null;
    const agentRes = await fetch("https://api.livechatinc.com/v3.6/configuration/action/get_agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + agentToken },
      body: JSON.stringify({ id: agentId, fields: ["groups"] }),
    });
    const agent = await agentRes.json();
    if (agent?.error) throw new Error(agent.error.message || JSON.stringify(agent.error));
    const ids = new Set((agent.groups || []).map((group) => String(group?.id ?? group)));
    return groups.filter((group) => ids.has(String(group.id))).map((group) => group.name);
  } catch (_) {
    return null;
  }
}

export async function handler(event) {
  try {
    if (!LIVECHAT_PATS.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null }) };
    }
    const { groupID, threadId, realChatId, agentTokens = {} } = JSON.parse(event.body || "{}");
    if (!groupID && !threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "groupID or threadId is required" }) };
    }

    if (threadId) {
      const owner = await findThreadOwner(threadId, realChatId);
      if (owner) {
        let ids = [];
        let ownedChat = null;
        try {
          ownedChat = await agentAction(owner.pat, "get_chat", { chat_id: owner.chatId, thread_id: threadId });
          ids = groupIdsOf(ownedChat);
        } catch (_) { }
        if (groupID) ids.push(String(groupID));
        ids = [...new Set(ids)];

        const groups = await fetchGroups(owner.pat);
        const names = ids
          .map((id) => groups.find((g) => String(g.id) === id))
          .filter(Boolean)
          .map((g) => g.name);
        const departmentGroups = await departmentGroupsForSignedInAgent(owner.pat, agentTokens[owner.accountKey], groups);
        const chosen = names.find((n) => PRIORITY_RE.test(n)) || null;
        if (chosen) {
          return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: chosen, groups: names, departmentGroups, accountKey: owner.accountKey, resolvedBy: "chat-owner-account" }) };
        }
        return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, groups: names, departmentGroups, accountKey: owner.accountKey, error: `Chat isn't in a Priority Support group (its groups: ${names.length ? names.join(", ") : "none found"}) — Brand left blank.` }) };
      }
    }

    if (!groupID) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: "Couldn't determine which LiveChat account this chat belongs to." }) };
    }
    const hits = [];
    let lastErr = null;
    for (const pat of LIVECHAT_PATS) {
      try {
        const groups = await fetchGroups(pat);
        const match = groups.find((g) => String(g.id) === String(groupID));
        if (match && PRIORITY_RE.test(match.name)) hits.push({ name: match.name, accountKey: accountKeyForPat(pat) });
      } catch (err) {
        lastErr = err;
      }
    }
    const distinct = [...new Set(hits.map((hit) => hit.name))];
    if (distinct.length === 1) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: distinct[0], groups: distinct, accountKey: hits.length === 1 ? hits[0].accountKey : "", resolvedBy: "unique-group-id" }) };
    }
    if (distinct.length > 1) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: `Group ID ${groupID} exists in more than one LiveChat account (${distinct.join(" / ")}) and this chat's account couldn't be determined — pick Brand manually.` }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: lastErr ? lastErr.message : undefined }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
