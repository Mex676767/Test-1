import { listRecords, toDisplay, updateRecord, TABLE_AGENT_LOGINS } from "./lark.js";

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

export function pickTicketEmail(rows, accountKey, login, liveChatEmail = "") {
  const set = setEmailOf(rows, accountKey, login);
  return set.email ? { email: set.email, via: set.via } : { email: clean(liveChatEmail).toLowerCase(), via: "livechat" };
}

export async function ticketEmailFor(accountKey, login, liveChatEmail = "") {
  if (!TABLE_AGENT_LOGINS) return pickTicketEmail([], accountKey, login, liveChatEmail);
  try {
    return pickTicketEmail(parseTicketEmailRows(await listRecords(TABLE_AGENT_LOGINS, 500, { sharedCacheMs: 60_000 })), accountKey, login, liveChatEmail);
  } catch (_) {
    return pickTicketEmail([], accountKey, login, liveChatEmail);
  }
}

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
