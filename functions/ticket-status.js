import { adapt } from "./_lib/adapt.js";
import { isOnBehalfRefusal, readingAs, refusalResponse } from "./_lib/ticket-actor.js";
import { json, ticketError, ticketGet, withOnBehalf } from "./_lib/tickets.js";

// A ticket read up to this old is shared by every agent on the isolate (see ticketGet); ?fresh=1 skips it.
const STATUS_TTL_MS = 4_000;

const mapComment = (comment) => ({
  id: comment.id,
  author: { id: comment.author?.id ?? null, name: String(comment.author?.name || "") },
  body: comment.deleted ? "" : String(comment.body ?? ""),
  deleted: Boolean(comment.deleted),
  createdAt: comment.createdAt || null,
  mentions: Array.isArray(comment.mentions) ? comment.mentions.map((m) => ({ userId: m.userId, name: m.name })) : [],
  attachments: Array.isArray(comment.attachments) ? comment.attachments.map((a) => ({ name: a.originalName || a.name || "File", mime: a.mimeType || a.mime || "", size: Number(a.sizeBytes ?? a.size) || 0, path: String(a.path || "") })) : [],
  ...(Array.isArray(comment.replies) ? { replies: comment.replies.map(mapComment) } : {}),
});

// A ticket record from the ticket API as the widget gets it (ticket-update.js answers with the same shape, without the thread).
export function mapTicket(record) {
  const recordFields = record.fields && !Array.isArray(record.fields) ? record.fields : {};
  return {
    ref: record.ref,
    fields: recordFields,
    currentDepartment: record.currentDepartment || null,
    raisedByDepartment: record.raisedByDepartment || null,
    market: record.market || null,
    raisedBy: record.raisedBy ? { id: record.raisedBy.id, name: record.raisedBy.name, email: record.raisedBy.email } : null,
    assignees: Array.isArray(record.assignees)
      ? record.assignees.map(({ id, name, email }) => ({ id, name, email }))
      : [],
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    commentCount: Number(record.commentCount || 0),
    attachmentCount: Number(record.attachmentCount || 0),
    comments: Array.isArray(record.comments) ? record.comments.map(mapComment) : [],
  };
}

export async function handler(event) {
  const post = event.httpMethod === "POST";
  if (event.httpMethod !== "GET" && !post) return json(405, { ok: false, error: "Method not allowed" });
  let input = {};
  try { input = post ? JSON.parse(event.body || "{}") : {}; } catch (_) { return json(400, { ok: false, error: "Malformed JSON" }); }
  const ref = String((post ? input.ref : event.queryStringParameters?.ref) || "").trim().toUpperCase();
  const fresh = post ? input.fresh === true : event.queryStringParameters?.fresh === "1";
  if (!/^TK\d{10}$/.test(ref)) {
    return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
  }

  let reading = { email: "", source: "" };
  try {
    reading = await readingAs(event.env, input.author);
    if (reading.response) return reading.response;
    const data = await ticketGet(event.env, withOnBehalf(`/tickets/${encodeURIComponent(ref)}`, reading.email), { ttlMs: STATUS_TTL_MS, fresh });
    // The current API wraps a single record as { ticket, fields }, where
    // top-level fields is the field catalog. Older deployments returned the
    // ticket directly. Support both shapes and never mistake the catalog
    // array for the ticket's field-value object.
    const record = data.ticket || data.record || data;
    return json(200, { ok: true, ticket: mapTicket(record) });
  } catch (err) {
    if (reading.email && isOnBehalfRefusal(err)) return refusalResponse(err, reading.email, reading.source);
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
