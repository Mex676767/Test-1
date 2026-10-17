import { adapt } from "./_lib/adapt.js";
import { isOnBehalfRefusal, readingAs, refusalResponse } from "./_lib/ticket-actor.js";
import { json, ticketError, ticketGet, withOnBehalf } from "./_lib/tickets.js";

// An inbox read up to this old is shared by every agent on the isolate (see ticketGet); ?fresh=1 skips it.
const LIST_TTL_MS = 15_000;

function cleanTicket(ticket) {
  return {
    ref: ticket.ref,
    fields: ticket.fields || {},
    currentDepartment: ticket.currentDepartment || null,
    raisedByDepartment: ticket.raisedByDepartment || null,
    market: ticket.market || null,
    raisedBy: ticket.raisedBy ? { id: ticket.raisedBy.id, name: ticket.raisedBy.name, email: ticket.raisedBy.email } : null,
    assignees: Array.isArray(ticket.assignees)
      ? ticket.assignees.map(({ id, name, email }) => ({ id, name, email }))
      : [],
    createdAt: ticket.createdAt || null,
    updatedAt: ticket.updatedAt || null,
    commentCount: Number(ticket.commentCount || 0),
    attachmentCount: Number(ticket.attachmentCount || 0),
  };
}

export async function handler(event) {
  const post = event.httpMethod === "POST";
  if (event.httpMethod !== "GET" && !post) return json(405, { ok: false, error: "Method not allowed" });
  let input = {};
  try { input = post ? JSON.parse(event.body || "{}") : {}; } catch (_) { return json(400, { ok: false, error: "Malformed JSON" }); }
  const q = String((post ? input.q : event.queryStringParameters?.q) || "").trim();
  if (q.length > 200) return json(400, { ok: false, error: "Search is too long" });
  const fresh = post ? input.fresh === true : event.queryStringParameters?.fresh === "1";
  let reading = { email: "", source: "" };
  try {
    reading = await readingAs(event.env, input.author);
    if (reading.response) return reading.response;
    const params = new URLSearchParams({ pageSize: "100", sort: "updatedAt:desc" });
    if (q) params.set("q", q);
    const data = await ticketGet(event.env, withOnBehalf(`/tickets?${params}`, reading.email), { ttlMs: LIST_TTL_MS, fresh });
    return json(200, {
      ok: true,
      total: Number(data.total || 0),
      tickets: (Array.isArray(data.tickets) ? data.tickets : []).map(cleanTicket),
    });
  } catch (err) {
    if (reading.email && isOnBehalfRefusal(err)) return refusalResponse(err, reading.email, reading.source);
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
