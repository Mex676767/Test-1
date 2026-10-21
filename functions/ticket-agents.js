import { adapt } from "./_lib/adapt.js";
import { isOnBehalfRefusal, readingAs, refusalResponse } from "./_lib/ticket-actor.js";
import { json, ticketError, ticketGet, withOnBehalf } from "./_lib/tickets.js";

const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const ROSTER_TTL_MS = 10 * 60_000;

export function collectAgents(tickets) {
  const seen = new Map();
  for (const ticket of tickets || []) {
    for (const person of [ticket?.raisedBy, ...(Array.isArray(ticket?.assignees) ? ticket.assignees : [])]) {
      const id = Number(person?.id);
      const name = String(person?.name || "").trim();
      if (Number.isInteger(id) && id > 0 && name && !seen.has(id)) seen.set(id, name);
    }
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function handler(event) {
  const post = event.httpMethod === "POST";
  if (event.httpMethod !== "GET" && !post) return json(405, { ok: false, error: "Method not allowed" });
  let input = {};
  try { input = post ? JSON.parse(event.body || "{}") : {}; } catch (_) { return json(400, { ok: false, error: "Malformed JSON" }); }
  const fresh = post ? input.fresh === true : event.queryStringParameters?.fresh === "1";
  let reading = { email: "", source: "" };
  try {
    reading = await readingAs(event.env, input.author);
    if (reading.response) return reading.response;
    const tickets = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), sort: "updatedAt:desc", page: String(page) });
      const data = await ticketGet(event.env, withOnBehalf(`/tickets?${params}`, reading.email), { ttlMs: ROSTER_TTL_MS, fresh });
      tickets.push(...(Array.isArray(data.tickets) ? data.tickets : []));
      total = Number(data.total || 0);
      if (!Array.isArray(data.tickets) || data.tickets.length < PAGE_SIZE || tickets.length >= total) break;
    }
    return json(200, { ok: true, agents: collectAgents(tickets), scanned: tickets.length, total });
  } catch (err) {
    if (reading.email && isOnBehalfRefusal(err)) return refusalResponse(err, reading.email, reading.source);
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
