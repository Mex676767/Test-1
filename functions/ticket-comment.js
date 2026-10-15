import { adapt } from "./_lib/adapt.js";
import { actingAs, flag, isOnBehalfRefusal, needTicketEmail, refusalResponse } from "./_lib/ticket-actor.js";
import { rememberTicketEmail } from "./_lib/ticket-email.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

// Posts a comment (or a reply) on a ticket, as the signed-in agent when TICKETS_ON_BEHALF_OF is on (see ticket-actor.js). The ticket API
// writes it as that person, with their mentions and notifications as from the dashboard. Reading the thread is ticket-status.js.
const MAX_COMMENT = 5000;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    if (!ticketSettings(event.env).configured) return json(503, { ok: false, error: "Ticket integration is not configured" });
    const input = JSON.parse(event.body || "{}");
    const ref = String(input.ref || "").trim().toUpperCase();
    const text = String(input.body ?? "").trim();
    if (!/^TK\d{10}$/.test(ref)) return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
    if (!text) return json(400, { ok: false, error: "Write a comment first." });
    if (text.length > MAX_COMMENT) return json(400, { ok: false, error: `A comment can be at most ${MAX_COMMENT} characters.` });
    const parentId = input.parentId === undefined || input.parentId === null || input.parentId === "" ? null : Number(input.parentId);
    if (parentId !== null && !(Number.isInteger(parentId) && parentId > 0)) return json(400, { ok: false, error: "That reply is not to a valid comment." });

    const onBehalf = flag(event.env?.TICKETS_ON_BEHALF_OF);
    let acting = null;
    if (onBehalf) {
      acting = await actingAs(event.env, input.author);
      if (acting.response) return acting.response;
      if (!acting.email) return needTicketEmail("");
    }
    const email = onBehalf ? acting.email : "";
    try {
      const data = await ticketRequest(event.env, `/tickets/${encodeURIComponent(ref)}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: text, ...(parentId ? { parentId } : {}), ...(email ? { onBehalfOf: email } : {}) }),
      });
      if (email && acting.source === "entered") {
        const save = rememberTicketEmail(acting.agentLogin.accountKey, acting.agentLogin.login, email);
        if (event.waitUntil) event.waitUntil(save); else await save;
      }
      return json(201, { ok: true, parentId: data.parentId ?? null, comment: data.comment || null, ...(email ? { actedAs: email } : {}) });
    } catch (err) {
      if (email && isOnBehalfRefusal(err)) return refusalResponse(err, email, acting.source);
      throw err;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
