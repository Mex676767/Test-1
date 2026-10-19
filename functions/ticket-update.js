import { adapt } from "./_lib/adapt.js";
import { actingAs, flag, isOnBehalfRefusal, needTicketEmail, refusalResponse } from "./_lib/ticket-actor.js";
import { rememberTicketEmail } from "./_lib/ticket-email.js";
import { json, resetTicketReadCache, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";
import { mapTicket } from "./ticket-status.js";

// Changes a ticket as the signed-in agent when TICKETS_ON_BEHALF_OF is on (see ticket-actor.js), through the ticket API's
// PATCH /tickets/<ref>: fields (status and query type included), the department holding it, the market and who is assigned, in ONE
// atomic request. The ticket system applies the agent's own roles, so a field they may only view, or a ticket outside their scope, is
// refused with its own message. Not here: adding or removing files (the widget does not offer it yet).
//
//   POST { ref, author, fields?, toDepartment?, market?, assignees?, expect? }
//     fields      { "<field key or label>": value | null }   null clears a field; a list field takes { add: [...], remove: [...] }
//     toDepartment  a department code, name or id
//     market      a market code (a string) or null to clear it; leave it out to leave the market alone
//     assignees   { add: [email | name | id], remove: [id | email | name] }
//     expect      { "<field key or label>": the value the agent read } -- compare-and-set: if the ticket no longer holds it,
//                 nothing changes and the answer is 412 with `mismatched`.
//   -> 200 { ok, ref, changed: [...], visible, ticket, actedAs? }   (changed [] = nothing needed to change)
const MAX_NAMES = 50;
const MAX_LIST = 100;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isScalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const isListChange = (value) => isPlainObject(value) && Object.keys(value).every((key) => key === "add" || key === "remove")
  && Object.values(value).every((list) => Array.isArray(list) && list.length <= MAX_LIST && list.every((item) => ["string", "number"].includes(typeof item)));

// { body } for the ticket API (without onBehalfOf) or { error } for a request that is malformed or changes nothing.
export function buildUpdate(input) {
  const body = {};
  if (input.fields !== undefined) {
    if (!isPlainObject(input.fields) || Object.keys(input.fields).length > MAX_NAMES) return { error: "The fields to change must be an object of at most 50 fields." };
    if (!Object.values(input.fields).every((value) => isScalar(value) || isListChange(value))) return { error: "A field's new value must be text, a number, true/false, null, or { add, remove } for a list." };
    if (Object.keys(input.fields).length) body.fields = input.fields;
  }
  if (input.toDepartment !== undefined && input.toDepartment !== null && input.toDepartment !== "") {
    if (!["string", "number"].includes(typeof input.toDepartment) || !String(input.toDepartment).trim()) return { error: "Choose a department to move the ticket to." };
    body.toDepartment = typeof input.toDepartment === "string" ? input.toDepartment.trim() : input.toDepartment;
  }
  if (input.market !== undefined) {
    if (input.market !== null && (typeof input.market !== "string" || !input.market.trim())) return { error: "The market must be a market code, or null to clear it." };
    body.market = input.market === null ? null : input.market.trim();
  }
  if (input.assignees !== undefined) {
    if (!isListChange(input.assignees)) return { error: "Assignees must be { add: [...], remove: [...] } with people by id, email or name." };
    if ((input.assignees.add || []).length || (input.assignees.remove || []).length) body.assignees = input.assignees;
  }
  if (input.expect !== undefined) {
    if (!isPlainObject(input.expect) || Object.keys(input.expect).length > MAX_NAMES || !Object.values(input.expect).every(isScalar)) return { error: "expect must be an object of the values the agent read." };
    if (Object.keys(input.expect).length) body.expect = input.expect;
  }
  if (!body.fields && body.toDepartment === undefined && body.market === undefined && !body.assignees) return { error: "There is nothing to change." };
  return { body };
}

export async function handler(event) {
  if (event.httpMethod !== "POST" && event.httpMethod !== "PATCH") return json(405, { ok: false, error: "Method not allowed" });
  try {
    if (!ticketSettings(event.env).configured) return json(503, { ok: false, error: "Ticket integration is not configured" });
    const input = JSON.parse(event.body || "{}");
    const ref = String(input.ref || "").trim().toUpperCase();
    if (!/^TK\d{10}$/.test(ref)) return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
    const built = buildUpdate(input);
    if (built.error) return json(400, { ok: false, error: built.error });

    const onBehalf = flag(event.env?.TICKETS_ON_BEHALF_OF);
    let acting = null;
    if (onBehalf) {
      acting = await actingAs(event.env, input.author);
      if (acting.response) return acting.response;
      if (!acting.email) return needTicketEmail("");
    }
    const email = onBehalf ? acting.email : "";

    try {
      const data = await ticketRequest(event.env, `/tickets/${encodeURIComponent(ref)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...built.body, ...(email ? { onBehalfOf: email } : {}) }),
      });
      resetTicketReadCache(); // a read made a moment ago would show the old values
      if (email && acting.source === "entered") {
        const save = rememberTicketEmail(acting.agentLogin.accountKey, acting.agentLogin.login, email);
        if (event.waitUntil) event.waitUntil(save); else await save;
      }
      const visible = data.visible !== false && Boolean(data.ticket);
      return json(200, {
        ok: true, ref: data.ref || ref, changed: Array.isArray(data.changed) ? data.changed : [], visible,
        ...(visible ? { ticket: mapTicket(data.ticket) } : {}),
        ...(email ? { actedAs: email } : {}),
      });
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
