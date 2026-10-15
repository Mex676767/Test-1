import { LIVECHAT_ACCOUNTS } from "./livechat.js";
import { identifyAgent } from "./livechat-identity.js";
import { looksLikeEmail, ticketEmailFor } from "./ticket-email.js";
import { json } from "./tickets.js";

// Acting in the ticket system AS the signed-in agent (raising a ticket, posting a comment). The ticket API takes the person's email
// (onBehalfOf) and then everything is theirs: raisedBy, their department, the comment's author. It needs the API key's role to hold
// api-keys:act-on-behalf and an active ticket-system account with that email. Switched on with TICKETS_ON_BEHALF_OF=1.
//
// There is deliberately no fallback to the key's owner: a ticket or comment that is not the agent's would be wrong in the ticket
// system's history, so a refusal is shown to the agent instead (needTicketEmail asks for their ticket account email).
export const flag = (value) => ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
export const isOnBehalfRefusal = (error) => [400, 403].includes(Number(error?.statusCode))
  && /on behalf|onBehalfOf|No active account has the email|outranks/i.test(String(error?.message || ""));

export const needTicketEmail = (triedEmail) => json(400, {
  ok: false, needTicketEmail: true, ...(triedEmail ? { triedEmail } : {}),
  error: "Ticket account not found. Please enter your ticket account email.",
});

// Who is signed in (asked of LiveChat with their own token; the browser's word is never used) and which ticket account email that is:
// an email set in Lark wins, else one the agent typed, else their LiveChat email. { response } when they are not signed in.
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

// The ticket system refused to act for this person. 400 = no active account with that email (ask for the right one, or send the agent to
// the admin when the email came from the Ticket Email column, which an agent cannot change); 403 = the key may not act for others.
export function refusalResponse(error, email, source) {
  if (Number(error.statusCode) === 403) {
    return json(403, {
      ok: false, keyNeedsGrant: true, triedEmail: email,
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
