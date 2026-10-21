import { adapt } from "./_lib/adapt.js";
import { deleteRecord, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { readOwnership, ownedBy } from "./_lib/ca-row.js";

export async function handler(event) {
  try {
    const { recordId, agentName } = JSON.parse(event.body || "{}");
    if (!recordId || !String(agentName || "").trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId and agentName are required" }) };
    }
    const { owner } = await readOwnership(recordId);
    if (!ownedBy(owner, agentName)) {
      return { statusCode: 409, body: JSON.stringify({ ok: false, error: `This record belongs to ${owner} — not removed.` }) };
    }
    await deleteRecord(TABLE_CUSTOMER_APPROACHING, recordId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
