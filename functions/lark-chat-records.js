import { adapt } from "./_lib/adapt.js";
import { searchRecords, searchAllRecords, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { CA, summarizeRow } from "./_lib/ca-row.js";

// Finds every Customer Approaching row THIS agent logged for one chat, so
// the widget can rebuild the card when the browser has no saved copy of it
// (agents run LiveChat in incognito -- closing the window wipes
// localStorage). Matched on the thread id (the SECOND id): the link is
// saved as /chats/{chat_id}/{thread_id} at Look Up, and once the chat ends
// LiveChat only shows /archives/{thread_id} -- the thread id is the one
// thing both have in common. Never matched on chat_id, which is shared by
// every past session of the same customer.
//
// POST { agentName, threadId } -> { ok, records: [...] } oldest first.

const THREAD_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export async function handler(event) {
  try {
    const { agentName, threadId } = JSON.parse(event.body || "{}");
    const agent = String(agentName || "").trim();
    const thread = String(threadId || "").trim();
    if (!agent || !THREAD_ID_RE.test(thread)) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "agentName and a valid threadId are required" }) };
    }

    const byAgent = { field_name: CA.agentName, operator: "is", value: [agent] };
    let items;
    try {
      items = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
        byAgent,
        { field_name: CA.link, operator: "contains", value: [thread] },
      ], undefined, { pageSize: 500, automaticFields: true });
    } catch (_) {
      // If Lark won't filter on the Link field, scan this agent's rows instead.
      items = await searchAllRecords(TABLE_CUSTOMER_APPROACHING, [byAgent], { maxPages: 6, automaticFields: true });
    }

    const records = items
      .map(summarizeRow)
      // Exact thread match on our side -- "contains" is a substring match.
      .filter((r) => r.agent === agent && r.threadId === thread)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ agent: _a, ...rest }) => rest);

    return { statusCode: 200, body: JSON.stringify({ ok: true, records }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, records: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
