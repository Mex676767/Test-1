import { adapt } from "./_lib/adapt.js";
import { searchRecords, searchAllRecords, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { CA, CA_SUMMARY_FIELDS, summarizeRow } from "./_lib/ca-row.js";

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
      ], undefined, { pageSize: 500, automaticFields: true, fieldNames: CA_SUMMARY_FIELDS });
    } catch (_) {
      items = await searchAllRecords(TABLE_CUSTOMER_APPROACHING, [byAgent], { maxPages: 6, automaticFields: true, fieldNames: CA_SUMMARY_FIELDS });
    }

    const records = items
      .map(summarizeRow)
      .filter((r) => r.agent === agent && r.threadId === thread)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ agent: _a, ...rest }) => rest);

    return { statusCode: 200, body: JSON.stringify({ ok: true, records }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, records: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
