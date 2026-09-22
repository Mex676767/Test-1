import { adapt } from "./_lib/adapt.js";
import { searchRecords, getRecord, deleteRecord, toDisplay, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

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
// POST { agentName }                     -> { ok, records: [...] }
// POST { agentName, deleteRecordId }     -> removes that one row, but only
//   after re-checking it on Lark's side: same Agent Name, still no Inquiry
//   and no Status. A row that got filled in meanwhile is never deleted.

const F = { username: "Username", brand: "Brand", agentName: "Agent Name", inquiry: "Inquiry", status: "Status" };

// A row younger than this is most likely a case still being worked on
// (Look Up done, Inquiry/Status not picked yet) -- not stale.
const MIN_AGE_MS = 30 * 60 * 1000;

function isBlank(v) {
  return toDisplay(v).trim() === "";
}

export async function handler(event) {
  try {
    const { agentName, deleteRecordId } = JSON.parse(event.body || "{}");
    const agent = String(agentName || "").trim();
    if (!agent) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "agentName is required" }) };
    }

    if (deleteRecordId) {
      const rec = await getRecord(TABLE_CUSTOMER_APPROACHING, deleteRecordId);
      const f = rec.fields || {};
      if (toDisplay(f[F.agentName]).trim() !== agent) {
        return { statusCode: 403, body: JSON.stringify({ ok: false, error: "This record belongs to a different agent." }) };
      }
      if (!isBlank(f[F.inquiry]) || !isBlank(f[F.status])) {
        return { statusCode: 409, body: JSON.stringify({ ok: false, error: "This record has already been filled in — not removed." }) };
      }
      await deleteRecord(TABLE_CUSTOMER_APPROACHING, deleteRecordId);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    const items = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.agentName, operator: "is", value: [agent] },
      { field_name: F.inquiry, operator: "isEmpty", value: [] },
      { field_name: F.status, operator: "isEmpty", value: [] },
    ], undefined, { pageSize: 500, automaticFields: true });

    const now = Date.now();
    const records = items
      .map((r) => ({
        recordId: r.record_id,
        username: toDisplay(r.fields[F.username]).trim(),
        brand: toDisplay(r.fields[F.brand]).trim(),
        createdAt: Number(r.created_time) || 0,
        // Re-check on our side too, in case Lark's filter ever loosely matches.
        agent: toDisplay(r.fields[F.agentName]).trim(),
        blank: isBlank(r.fields[F.inquiry]) && isBlank(r.fields[F.status]),
      }))
      .filter((r) => r.agent === agent && r.blank && r.username && r.brand
        && r.createdAt && now - r.createdAt >= MIN_AGE_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ agent: _a, blank: _b, ...rest }) => rest);

    return { statusCode: 200, body: JSON.stringify({ ok: true, records }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, records: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
