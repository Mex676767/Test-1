import { listRecords, toDisplay, TABLE_AGENT_LOGINS } from "./lark.js";

// Which ticket-system account does a signed-in agent raise tickets as? The ticket system finds the person by EMAIL, and an agent
// who works in both LiveChat accounts has a different email in each (the two never share one), so the LiveChat email is only a
// guess. The Lark table "Livechat App Agent Logins" (one row per LiveChat login) has a text column "Ticket Email": fill it for an
// agent once, on either of their rows, and both of their LiveChat logins raise tickets as that ticket-system account.
//
// Order: this login's own Ticket Email, then the Ticket Email of another login with the same Agent Name, then the LiveChat email.
const F = { account: "LiveChat Account", login: "LiveChat Login", name: "Agent Name", ticketEmail: "Ticket Email" };
const clean = (value) => String(value ?? "").trim();
const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

export function parseTicketEmailRows(items) {
  return (items || []).map((item) => {
    const f = item.fields || {};
    return {
      account: clean(toDisplay(f[F.account])).toLowerCase(),
      login: clean(toDisplay(f[F.login])),
      name: clean(toDisplay(f[F.name])).toLowerCase(),
      ticketEmail: clean(toDisplay(f[F.ticketEmail])).toLowerCase(),
    };
  }).filter((row) => row.account && row.login);
}

// { email, via } where via says where the email came from: "ticket-email" (this login), "same-agent" (their other login) or "livechat".
export function pickTicketEmail(rows, accountKey, login, liveChatEmail = "") {
  const own = rows.find((row) => row.account === accountKey && row.login === login);
  if (own && looksLikeEmail(own.ticketEmail)) return { email: own.ticketEmail, via: "ticket-email" };
  if (own?.name) {
    const sibling = rows.find((row) => row.name === own.name && looksLikeEmail(row.ticketEmail));
    if (sibling) return { email: sibling.ticketEmail, via: "same-agent" };
  }
  return { email: clean(liveChatEmail).toLowerCase(), via: "livechat" };
}

// Best effort: the table being unreachable or without the column leaves the LiveChat email, never blocks a ticket.
export async function ticketEmailFor(accountKey, login, liveChatEmail = "") {
  if (!TABLE_AGENT_LOGINS) return pickTicketEmail([], accountKey, login, liveChatEmail);
  try {
    return pickTicketEmail(parseTicketEmailRows(await listRecords(TABLE_AGENT_LOGINS, 500, { sharedCacheMs: 60_000 })), accountKey, login, liveChatEmail);
  } catch (_) {
    return pickTicketEmail([], accountKey, login, liveChatEmail);
  }
}
