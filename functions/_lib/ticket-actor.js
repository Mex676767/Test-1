import { LIVECHAT_ACCOUNTS } from "./livechat.js";
import { identifyAgent } from "./livechat-identity.js";
import { looksLikeEmail, ticketEmailFor } from "./ticket-email.js";
import { json } from "./tickets.js";

export const flag = (value) => ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
export const isOnBehalfRefusal = (error) => [400, 403].includes(Number(error?.statusCode))
  && /on behalf|onBehalfOf|No active account has the email|is not an account this API key can act for|nothing can be done on their behalf|is a service account|outranks/i.test(String(error?.message || ""));

export const needTicketEmail = (triedEmail) => json(400, {
  ok: false, needTicketEmail: true, ...(triedEmail ? { triedEmail } : {}),
  error: "Ticket account not found. Please enter your ticket account email.",
});

export async function actingAs(env, author, { resolveEmail = true } = {}) {
  const account = LIVECHAT_ACCOUNTS.find((item) => item.key === author?.accountKey);
  if (!account || !String(author?.agentToken || "").trim()) {
    return { response: json(401, { ok: false, loginExpired: true, error: "Connect LiveChat first: a ticket has to say which agent raised it." }) };
  }
  const who = await identifyAgent(env, account.key, author.agentToken, { withEmail: true, pat: account.pat });
  if (!who.ok) return { response: json(401, { ok: false, loginExpired: true, error: who.error }) };
  const agentEmail = who.identities.find((id) => id.includes("@")) || "";
  const out = { account, who, agentEmail, email: "", source: "", agentLogin: { accountKey: account.key, login: who.login } };
  if (!resolveEmail) return out;
  const picked = await ticketEmailFor(account.key, who.login, agentEmail);
  const entered = String(author.ticketEmail || "").trim().toLowerCase();
  if (picked.via !== "livechat") { out.email = picked.email; out.source = picked.via; }
  else if (looksLikeEmail(entered)) { out.email = entered; out.source = "entered"; }
  else { out.email = picked.email; out.source = "livechat"; }
  return out;
}

export async function readingAs(env, author) {
  if (!flag(env?.TICKETS_ON_BEHALF_OF)) return { email: "", source: "" };
  const acting = await actingAs(env, author);
  if (acting.response) return acting;
  if (!acting.email) return { response: needTicketEmail("") };
  return acting;
}

export function refusalResponse(error, email, source) {
  if (Number(error.statusCode) === 403) {
    return json(403, {
      ok: false, keyNeedsGrant: true, triedEmail: email, detail: String(error.message || "").slice(0, 300),
      error: /outranks/i.test(String(error.message))
        ? `Your ticket account (${email}) is senior to the account the integration key belongs to, so nothing can be done as you. Nothing was created. Ask the ticket team.`
        : "The ticket system's API key may not act on behalf of other people yet (its role needs the api-keys:act-on-behalf permission). Nothing was created. Ask the ticket team.",
    });
  }
  if (source === "ticket-email" || source === "same-agent") {
    return json(400, { ok: false, triedEmail: email, error: `The Ticket Email saved for you (${email}) has no active ticket account. Ask your admin to correct it.` });
  }
  return needTicketEmail(email);
}
