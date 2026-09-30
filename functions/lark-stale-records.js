import { adapt } from "./_lib/adapt.js";
import { searchRecords, getRecord, deleteRecord, toDisplay, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { LIVECHAT_PATS, accountKeyForPat } from "./_lib/livechat.js";
import { CA, summarizeRow, parseChatLink, archiveUrl, isBlank } from "./_lib/ca-row.js";

// Server-side half of Needs Attention. The browser-side list (app.js's
// getIncompleteChats) only knows about chats THIS browser remembers in
// localStorage -- an incognito window closing, cleared site data, a
// different PC, etc. and an unfinished case silently drops out of view,
// leaving a stray Customer Approaching row with just Username/Brand/Agent
// Name that nobody's list ever shows (confirmed live: several such rows
// with no Needs Attention card on anyone's widget). Lark itself is the
// source of truth here instead: every row lark-search.js created on Look Up
// for this agent that still has no Inquiry AND no Status.
//
// Scoped to one Agent Name -- each agent only sees rows stamped with the
// name they picked in Settings, never another agent's.
//
// When a row has its chat link (saved at Look Up since e0bfcb0), LiveChat
// is asked whether that exact thread has actually ended: still going ->
// not listed (the agent is mid-case); ended -> listed. Rows without a link
// (older ones) fall back to an age rule.
//
// POST { agentName, localRecordIds? }    -> { ok, records, resolvedIds }
//   resolvedIds: which of the browser's own locally-flagged record ids are
//   no longer blank in Lark (recorded from another browser/tab, or
//   removed) -- the widget drops those from its local list.
// POST { agentName, deleteRecordId }     -> removes that one row, but only
//   after re-checking it on Lark's side: same Agent Name, still no Inquiry
//   and no Status. A row that got filled in meanwhile is never deleted.

// No chat link to check: a row younger than this is most likely a case
// still being worked on.
const MIN_AGE_NO_LINK_MS = 30 * 60 * 1000;
// Chat known to have ended: short grace so the widget's own auto-record
// on close gets a chance to fill the row first.
const MIN_AGE_ENDED_MS = 3 * 60 * 1000;
async function removeCompletedTwinDuplicate(row) {
  const exactLink = String(row.link || "").trim().replace(/\/$/, "");
  if (!exactLink) return false;
  const related = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
    { field_name: CA.agentName, operator: "is", value: [row.agent] },
    { field_name: CA.username, operator: "is", value: [row.username] },
    { field_name: CA.brand, operator: "is", value: [row.brand] },
  ], undefined, { pageSize: 100, automaticFields: true });
  const completedTwin = related.map(summarizeRow).some((candidate) =>
    candidate.recordId !== row.recordId
    && String(candidate.link || "").trim().replace(/\/$/, "") === exactLink
    && candidate.inquiry.length > 0
  );
  if (!completedTwin) return false;
  await deleteRecord(TABLE_CUSTOMER_APPROACHING, row.recordId);
  return true;
}

// Resolves both status and the owning LiveChat account without exposing its
// credential. A direct chat id is reliable even after the thread drops out
// of list_chats' recent window; the list fallback covers archive-only links.
async function inspectThread(chatId, threadId, preferredAccountKey) {
  // Check the sidebar's own account first. Account 2 no longer pays for a
  // guaranteed failed Account 1 request on every Needs Attention refresh.
  const orderedPats = [...LIVECHAT_PATS].sort((a, b) =>
    Number(accountKeyForPat(b) === preferredAccountKey) - Number(accountKeyForPat(a) === preferredAccountKey)
  );
  for (const pat of orderedPats) {
    try {
      if (chatId) {
        const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
          body: JSON.stringify({ chat_id: chatId, thread_id: threadId }),
        });
        const data = await res.json();
        if (!data || data.error || !data.thread) continue; // not this account's chat -- try the next
        return {
          active: typeof data.thread.active === "boolean" ? data.thread.active : null,
          accountKey: accountKeyForPat(pat),
        };
      }

      const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_chats", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
        body: JSON.stringify({ limit: 100, sort_order: "desc" }),
      });
      const data = await res.json();
      const match = (data?.chats_summary || []).find(
        (chat) => chat.last_thread_summary && String(chat.last_thread_summary.id) === String(threadId)
      );
      if (match) {
        return {
          active: typeof match.last_thread_summary.active === "boolean" ? match.last_thread_summary.active : null,
          accountKey: accountKeyForPat(pat),
        };
      }
    } catch (_) { /* try the next account */ }
  }
  return { active: null, accountKey: "" };
}

export async function handler(event) {
  try {
    const { agentName, accountKey, deleteRecordId, localRecordIds } = JSON.parse(event.body || "{}");
    const agent = String(agentName || "").trim();
    if (!agent) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "agentName is required" }) };
    }

    if (deleteRecordId) {
      const rec = await getRecord(TABLE_CUSTOMER_APPROACHING, deleteRecordId);
      const f = rec.fields || {};
      if (toDisplay(f[CA.agentName]).trim() !== agent) {
        return { statusCode: 403, body: JSON.stringify({ ok: false, error: "This record belongs to a different agent." }) };
      }
      if (!isBlank(f[CA.inquiry]) || !isBlank(f[CA.status])) {
        return { statusCode: 409, body: JSON.stringify({ ok: false, error: "This record has already been filled in — not removed." }) };
      }
      await deleteRecord(TABLE_CUSTOMER_APPROACHING, deleteRecordId);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    const items = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: CA.agentName, operator: "is", value: [agent] },
      { field_name: CA.inquiry, operator: "isEmpty", value: [] },
      { field_name: CA.status, operator: "isEmpty", value: [] },
    ], undefined, { pageSize: 500, automaticFields: true });

    // Re-check on our side too, in case Lark's filter ever loosely matches.
    const blank = items
      .map(summarizeRow)
      .filter((r) => r.agent === agent && !r.inquiry.length && !r.status);
    const blankIds = new Set(blank.map((r) => r.recordId));

    const now = Date.now();
    const candidates = blank.filter((r) => r.username && r.brand && r.createdAt
      && now - r.createdAt >= MIN_AGE_ENDED_MS);

    const checked = await Promise.all(candidates.map(async (r) => {
      const { chatId, threadId } = parseChatLink(r.link);
      const inspected = threadId && LIVECHAT_PATS.length
        ? await inspectThread(chatId, threadId, accountKey)
        : { active: null, accountKey: "" };
      const { active } = inspected;
      // When the row's account can be established, never leak it into the
      // other account's sidebar. Unidentifiable legacy rows remain visible
      // with an "account unknown" marker so they are not silently lost.
      if (accountKey && inspected.accountKey && inspected.accountKey !== accountKey) return null;
      if (active === true) return null; // chat still going -- agent is mid-case
      if (active === null && now - r.createdAt < MIN_AGE_NO_LINK_MS) return null;
      // Once the chat has ended, remove only an empty row whose exact saved
      // link also belongs to a completed row. All rows containing Inquiry
      // remain untouched, allowing several legitimate cases in one chat.
      if (active === false) {
        try {
          if (await removeCompletedTwinDuplicate(r)) return null;
        } catch (_) { /* keep it visible on any uncertainty */ }
      }
      return {
        recordId: r.recordId,
        username: r.username,
        brand: r.brand,
        createdAt: r.createdAt,
        threadId,
        chatEnded: active === false,
        accountKey: inspected.accountKey,
        // Ended chats only open under /archives/{thread_id}.
        openUrl: active === false ? archiveUrl(threadId) : (r.link || archiveUrl(threadId)),
      };
    }));

    const records = checked.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    const resolvedIds = (Array.isArray(localRecordIds) ? localRecordIds : [])
      .filter((id) => typeof id === "string" && id && !blankIds.has(id));

    return { statusCode: 200, body: JSON.stringify({ ok: true, records, resolvedIds }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, records: [], resolvedIds: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
