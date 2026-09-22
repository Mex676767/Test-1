import { adapt } from "./_lib/adapt.js";
import { deleteRecord, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { readOwnership, ownedBy } from "./_lib/ca-row.js";

// Used when CS ticks "Unknown" on a chat that already has a placeholder
// Customer Approaching row (lark-search.js creates one on every Look Up,
// even before Inquiry/Status/etc. are filled in) -- e.g. a guessed/wrong
// username was tried before realizing the customer never gave a real one.
// Removes that row so an Unknown-marked chat truly records nothing, since
// unknown players aren't counted toward chat data (see app.js's
// isUnknown handling). Only ever called for a record that hasn't been
// logged yet -- app.js guards that on its side.
export async function handler(event) {
  try {
    const { recordId, agentName } = JSON.parse(event.body || "{}");
    if (!recordId || !String(agentName || "").trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId and agentName are required" }) };
    }
    // Never another agent's row -- after a chat transfer each agent keeps
    // their own record.
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
