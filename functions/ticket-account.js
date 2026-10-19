import { adapt } from "./_lib/adapt.js";
import { actingAs, flag, isOnBehalfRefusal } from "./_lib/ticket-actor.js";
import { rememberTicketEmail } from "./_lib/ticket-email.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

// "Is the signed-in agent known to the ticket system?" The ticket API has no users call, but every read accepts onBehalfOf and refuses
// an email no active account has, so one small read (the market list) as that person answers it without creating anything.
//   found              the ticket system acts as them: tickets and comments will be theirs
//   notFound           no active account with that email (ask for the right one)
//   adminEmailInvalid  the Ticket Email an admin saved has no account (an agent cannot change it)
//   keyNeedsGrant      the API key's role lacks api-keys:act-on-behalf
//   outranks           their account is senior to the key's owner
//   noEmail            LiveChat gave no email and none is saved or typed
// The ticket system's answer depends only on the email, so it is remembered for a minute per email (the API allows 120 calls a minute).
const TTL_MS = 60_000;
const MAX_CACHED = 200;
const cache = new Map(); // email -> { at, raw: "found" | "noAccount" | "keyNeedsGrant" | "outranks", detail }
export function resetTicketAccountCache() { cache.clear(); }

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    if (!ticketSettings(event.env).configured) return json(503, { ok: false, error: "Ticket integration is not configured" });
    if (!flag(event.env?.TICKETS_ON_BEHALF_OF)) return json(200, { ok: true, enabled: false });
    const input = JSON.parse(event.body || "{}");
    const acting = await actingAs(event.env, input.author);
    if (acting.response) return acting.response;
    const { email, source } = acting;
    if (!email) return json(200, { ok: true, enabled: true, status: "noEmail", email: "", source });

    let entry = cache.get(email);
    if (!entry || Date.now() - entry.at > TTL_MS) {
      let raw = "found";
      let detail = "";
      try {
        await ticketRequest(event.env, `/markets?onBehalfOf=${encodeURIComponent(email)}`, { reads: true }); // a read: on the reads key, so checking an account never takes a write's calls
      } catch (err) {
        if (Number(err.statusCode) === 401) {
          // "Not signed in.": the ticket system does not recognise the API key itself (revoked, replaced or mistyped), whoever the agent is.
          entry = { at: Date.now(), raw: "keyRejected", detail: String(err.message || "").slice(0, 300) };
          cache.set(email, entry);
          return json(200, { ok: true, enabled: true, status: "keyRejected", email, source, detail: entry.detail });
        }
        if (!isOnBehalfRefusal(err)) throw err;
        detail = String(err.message || "").slice(0, 300);
        raw = Number(err.statusCode) === 403 ? (/outranks/i.test(String(err.message)) ? "outranks" : "keyNeedsGrant") : "noAccount";
      }
      entry = { at: Date.now(), raw, detail };
      cache.set(email, entry);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    }
    const adminSet = source === "ticket-email" || source === "same-agent";
    const status = entry.raw === "noAccount" ? (adminSet ? "adminEmailInvalid" : "notFound") : entry.raw;
    // An email the agent typed that the ticket system knows is saved on their row at once (once; an admin-set one is never replaced).
    if (status === "found" && source === "entered") {
      const save = rememberTicketEmail(acting.agentLogin.accountKey, acting.agentLogin.login, email);
      if (event.waitUntil) event.waitUntil(save); else await save;
    }
    return json(200, { ok: true, enabled: true, status, email, source, ...(status !== "found" && entry.detail ? { detail: entry.detail } : {}) });
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
