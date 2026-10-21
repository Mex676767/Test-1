import { adapt } from "./_lib/adapt.js";
import { isOnBehalfRefusal, readingAs, refusalResponse } from "./_lib/ticket-actor.js";
import { json, ticketError, ticketGet, withOnBehalf } from "./_lib/tickets.js";

const LIST_TTL_MS = 8_000;

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
  const mine = post ? input.mine === true : event.queryStringParameters?.mine === "1";
  const agentInput = String((post ? input.agent : event.queryStringParameters?.agent) ?? "").trim();
  if (agentInput && !/^\d{1,12}$/.test(agentInput)) return json(400, { ok: false, error: "That is not an agent id." });
  const who = agentInput || (mine ? "me" : "");
  const pick = (name) => String((post ? input[name] : event.queryStringParameters?.[name]) ?? "").trim();
  const status = pick("status");
  const department = pick("department");
  const market = pick("market");
  if (status && !/^[A-Za-z0-9_.-]{1,80}$/.test(status)) return json(400, { ok: false, error: "That is not a status." });
  if ((department && !/^\d{1,9}$/.test(department)) || (market && !/^\d{1,9}$/.test(market))) return json(400, { ok: false, error: "That is not a department or market id." });
  const narrowing = [
    ...(status ? [`f:status|is|${status}`] : []),
    ...(department ? [`dept|is|${department}`] : []),
    ...(market ? [`market|is|${market}`] : []),
  ];
  let reading = { email: "", source: "" };
  try {
    reading = await readingAs(event.env, input.author);
    if (reading.response) return reading.response;
    const size = pick("size") === "250" ? 250 : 100;
    const orderKey = pick("sort") === "created" ? "createdAt" : "updatedAt";
    const params = new URLSearchParams({ pageSize: String(size), sort: pick("sort") === "created" ? "createdAt:desc" : "updatedAt:desc" });
    if (q) params.set("q", q);
    let data;
    const read = (conditions, match = "all") => {
      const query = new URLSearchParams(params);
      for (const condition of conditions) query.append("c", condition);
      if (conditions.length > 1) query.set("match", match);
      return ticketGet(event.env, withOnBehalf(`/tickets?${query}`, reading.email), { ttlMs: LIST_TTL_MS, fresh });
    };
    if (who && (narrowing.length || q)) {
      const raised = await read([`createdBy|is|${who}`, ...narrowing]);
      let assigned = null;
      try {
        assigned = await read([`assignee|is|${who}`, ...narrowing]);
      } catch (err) {
        if (Number(err.statusCode) !== 400 || isOnBehalfRefusal(err)) throw err;
      }
      const byRef = new Map();
      for (const ticket of [...(raised.tickets || []), ...(assigned?.tickets || [])]) if (!byRef.has(ticket.ref)) byRef.set(ticket.ref, ticket);
      const merged = [...byRef.values()].sort((a, b) => String(b[orderKey] || "").localeCompare(String(a[orderKey] || ""))).slice(0, size);
      data = { total: Math.max(Number(raised.total || 0), Number(assigned?.total || 0), merged.length), tickets: merged };
    } else if (who) {
      const raisedOrAssigned = new URLSearchParams(params);
      raisedOrAssigned.append("c", `createdBy|is|${who}`);
      raisedOrAssigned.append("c", `assignee|is|${who}`);
      raisedOrAssigned.set("match", "any");
      try {
        data = await ticketGet(event.env, withOnBehalf(`/tickets?${raisedOrAssigned}`, reading.email), { ttlMs: LIST_TTL_MS, fresh });
      } catch (err) {
        if (Number(err.statusCode) !== 400 || isOnBehalfRefusal(err)) throw err;
        const raisedOnly = new URLSearchParams(params);
        raisedOnly.append("c", `createdBy|is|${who}`);
        data = await ticketGet(event.env, withOnBehalf(`/tickets?${raisedOnly}`, reading.email), { ttlMs: LIST_TTL_MS, fresh });
      }
    } else {
      data = await read(narrowing);
    }
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
