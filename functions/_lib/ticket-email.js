import { listRecords, toDisplay, updateRecord, TABLE_AGENT_LOGINS } from "./lark.js";

// Which ticket-system account does a signed-in agent raise tickets as? The ticket system finds the person by EMAIL, and an agent
// who works in both LiveChat accounts has a different email in each (the two never share one), so the LiveChat email is only a
// guess. The Lark table "Livechat App Agent Logins" (one row per LiveChat login) has a text column "Ticket Email": fill it for an
// agent once, on either of their rows, and both of their LiveChat logins raise tickets as that ticket-system account.
//
// Order: this login's own Ticket Email, then the Ticket Email of another login with the same Agent Name, then the LiveChat email.
// An agent whose email finds no ticket-system account is asked for theirs; it is saved here once (rememberTicketEmail) and from then
// on an agent can no longer change it: only an admin edits the column, so nobody raises tickets as someone else by typing their email.
const F = { account: "LiveChat Account", login: "LiveChat Login", name: "Agent Name", ticketEmail: "Ticket Email" };
const clean = (value) => String(value ?? "").trim();
export const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(value));

export function parseTicketEmailRows(items) {
  return (items || []).map((item) => {
    const f = item.fields || {};
    return {
      recordId: item.record_id || item.id || "",
      account: clean(toDisplay(f[F.account])).toLowerCase(),
      login: clean(toDisplay(f[F.login])),
      name: clean(toDisplay(f[F.name])).toLowerCase(),
      ticketEmail: clean(toDisplay(f[F.ticketEmail])).toLowerCase(),
    };
  }).filter((row) => row.account && row.login);
}

function setEmailOf(rows, accountKey, login) {
  const own = rows.find((row) => row.account === accountKey && row.login === login);
  if (own && looksLikeEmail(own.ticketEmail)) return { own, email: own.ticketEmail, via: "ticket-email" };
  const sibling = own?.name ? rows.find((row) => row.name === own.name && looksLikeEmail(row.ticketEmail)) : null;
  if (sibling) return { own, email: sibling.ticketEmail, via: "same-agent" };
  return { own, email: "", via: "" };
}

// { email, via }: via says where the email came from: "ticket-email" (this login), "same-agent" (their other login) or "livechat".
export function pickTicketEmail(rows, accountKey, login, liveChatEmail = "") {
  const set = setEmailOf(rows, accountKey, login);
  return set.email ? { email: set.email, via: set.via } : { email: clean(liveChatEmail).toLowerCase(), via: "livechat" };
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

// The email an agent typed, saved on their row, only if neither of their rows has a Ticket Email yet (the table as it is now decides).
// Returns true when it was saved. Best effort: a missing column or an unreachable table just means they are asked again next time.
export async function rememberTicketEmail(accountKey, login, email) {
  const value = clean(email).toLowerCase();
  if (!TABLE_AGENT_LOGINS || !looksLikeEmail(value)) return false;
  try {
    const rows = parseTicketEmailRows(await listRecords(TABLE_AGENT_LOGINS, 500, { force: true }));
    const set = setEmailOf(rows, accountKey, login);
    if (set.email || !set.own?.recordId) return false;
    await updateRecord(TABLE_AGENT_LOGINS, set.own.recordId, { [F.ticketEmail]: value });
    return true;
  } catch (_) {
    return false;
  }
}
