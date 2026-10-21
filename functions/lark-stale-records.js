import { adapt } from "./_lib/adapt.js";
import { searchRecords, getRecord, deleteRecord, toDisplay, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { LIVECHAT_PATS, accountKeyForPat } from "./_lib/livechat.js";
import { CA, CA_SUMMARY_FIELDS, summarizeRow, parseChatLink, archiveUrl, isBlank } from "./_lib/ca-row.js";

const MIN_AGE_NO_LINK_MS = 30 * 60 * 1000;
const MIN_AGE_ENDED_MS = 3 * 60 * 1000;
async function removeCompletedTwinDuplicate(row) {
  const exactLink = String(row.link || "").trim().replace(/\/$/, "");
  if (!exactLink) return false;
  const related = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
    { field_name: CA.agentName, operator: "is", value: [row.agent] },
    { field_name: CA.username, operator: "is", value: [row.username] },
    { field_name: CA.brand, operator: "is", value: [row.brand] },
  ], undefined, { pageSize: 100, automaticFields: true, fieldNames: CA_SUMMARY_FIELDS });
  const completedTwin = related.map(summarizeRow).some((candidate) =>
    candidate.recordId !== row.recordId
    && String(candidate.link || "").trim().replace(/\/$/, "") === exactLink
    && candidate.inquiry.length > 0
  );
  if (!completedTwin) return false;
  await deleteRecord(TABLE_CUSTOMER_APPROACHING, row.recordId);
  return true;
}

async function inspectThread(chatId, threadId, preferredAccountKey) {
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
        if (!data || data.error || !data.thread) continue;
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
    } catch (_) { }
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
    ], undefined, { pageSize: 500, automaticFields: true, fieldNames: CA_SUMMARY_FIELDS });

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
      if (accountKey && inspected.accountKey && inspected.accountKey !== accountKey) return null;
      if (active === true) return null;
      if (active === null && now - r.createdAt < MIN_AGE_NO_LINK_MS) return null;
      if (active === false) {
        try {
          if (await removeCompletedTwinDuplicate(r)) return null;
        } catch (_) { }
      }
      return {
        recordId: r.recordId,
        username: r.username,
        brand: r.brand,
        createdAt: r.createdAt,
        threadId,
        chatEnded: active === false,
        accountKey: inspected.accountKey,
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
