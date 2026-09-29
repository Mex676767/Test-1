import { adapt } from "./_lib/adapt.js";
import { json, ticketError, ticketRequest } from "./_lib/tickets.js";

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
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  const q = String(event.queryStringParameters?.q || "").trim();
  if (q.length > 200) return json(400, { ok: false, error: "Search is too long" });
  try {
    const params = new URLSearchParams({ pageSize: "100", sort: "updatedAt:desc" });
    if (q) params.set("q", q);
    const data = await ticketRequest(event.env, `/tickets?${params}`);
    return json(200, {
      ok: true,
      total: Number(data.total || 0),
      tickets: (Array.isArray(data.tickets) ? data.tickets : []).map(cleanTicket),
    });
  } catch (err) {
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
