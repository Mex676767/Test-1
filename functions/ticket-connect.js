import { adapt } from "./_lib/adapt.js";
import { agentHeaders, connectionAvailable, connectionStatus, storeToken } from "./_lib/ticket-connection.js";
import { json, ticketRequest } from "./_lib/tickets.js";

// POST /ticket-connect  { action: "status" | "save" | "disconnect", ticketToken? }  with the agent's LiveChat login in
// X-LiveChat-Account / X-LiveChat-Agent-Token. "save" checks the ticket token with the ticket service before keeping it,
// and nothing here ever returns a ticket token.
const TOKEN_SHAPE = /^tmk_[A-Za-z0-9]{16,200}$/;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const login = agentHeaders(event);
    if (!login) return json(400, { ok: false, error: "LiveChat login is required." });
    if (!connectionAvailable(event.env)) {
      return json(200, { ok: true, available: false, connected: false, error: "Per-agent ticket sign-in is not set up on this site yet." });
    }

    let input;
    try { input = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { ok: false, error: "Malformed JSON" }); }
    const action = String(input.action || "status");

    if (action === "status") return json(200, { available: true, ...(await connectionStatus(event, login)) });

    if (action === "disconnect") return json(200, { available: true, ...(await storeToken(event, login, "")) });

    if (action === "save") {
      const ticketToken = String(input.ticketToken || "").trim();
      if (!TOKEN_SHAPE.test(ticketToken)) return json(400, { ok: false, error: "That does not look like a ticket sign-in token." });
      // A token the ticket service refuses is never stored.
      try {
        await ticketRequest({ ...event.env, TICKETS_API_KEY: ticketToken }, `/tickets?${new URLSearchParams({ pageSize: "100", c: "createdBy|is|me" })}`);
      } catch (err) {
        if (Number(err.statusCode) === 401) return json(200, { ok: false, error: "The ticket system did not accept that sign-in — try connecting again." });
        // 403 only means this role cannot read tickets: the token itself is valid, so keep it.
        if (Number(err.statusCode) !== 403) return json(200, { ok: false, error: "Could not check the sign-in with the ticket system: " + err.message });
      }
      return json(200, { available: true, ...(await storeToken(event, login, ticketToken)) });
    }

    return json(400, { ok: false, error: "Unknown action." });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
