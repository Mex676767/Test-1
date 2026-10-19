import { listRecords, toDisplay, updateRecord, TABLE_AGENT_LOGINS } from "./lark.js";

// Which ticket market does an agent's claim ticket go under? Each agent has one default market, chosen once. It is stored in the Lark
// table "Livechat App Agent Logins" (one row per LiveChat login), in a text column "Default Market" holding the market code (MYR, IDR...).
// Same rules as Ticket Email (see ticket-email.js): the column is read from this login's own row, then from another login with the same
// Agent Name. The agent is asked once; the answer is saved only while neither of their rows has one, and from then on only an admin
// changes it (edit the cell in Lark; the admin panel will do it later), so an agent cannot switch markets by themselves.
const F = { account: "LiveChat Account", login: "LiveChat Login", name: "Agent Name", market: "Default Market" };
const clean = (value) => String(value ?? "").trim();
export const looksLikeMarketCode = (value) => /^[A-Za-z0-9_-]{2,20}$/.test(clean(value));

export function parseMarketRows(items) {
  return (items || []).map((item) => {
    const f = item.fields || {};
    return {
      recordId: item.record_id || item.id || "",
      account: clean(toDisplay(f[F.account])).toLowerCase(),
      login: clean(toDisplay(f[F.login])),
      name: clean(toDisplay(f[F.name])).toLowerCase(),
      market: clean(toDisplay(f[F.market])).toUpperCase(),
    };
  }).filter((row) => row.account && row.login);
}

function marketOf(rows, accountKey, login) {
  const own = rows.find((row) => row.account === accountKey && row.login === login);
  if (own && looksLikeMarketCode(own.market)) return { own, market: own.market };
  const sibling = own?.name ? rows.find((row) => row.name === own.name && looksLikeMarketCode(row.market)) : null;
  if (sibling) return { own, market: sibling.market };
  return { own, market: "" };
}

export function pickDefaultMarket(rows, accountKey, login) {
  return marketOf(rows, accountKey, login).market;
}

// "" when none is set. Best effort: the table being unreachable or without the column reads as "not set".
export async function defaultMarketFor(accountKey, login) {
  if (!TABLE_AGENT_LOGINS) return "";
  try {
    return pickDefaultMarket(parseMarketRows(await listRecords(TABLE_AGENT_LOGINS, 500, { force: true })), accountKey, login);
  } catch (_) {
    return "";
  }
}

// Saves the market the agent picked, only if neither of their rows has one yet (the table as it is now decides).
// { saved, market }: market is the one that applies afterwards (the existing one when a race or a stale screen tried to change it).
// { saved: false, error } when it could not be stored: the agent is then asked again next time.
export async function rememberDefaultMarket(accountKey, login, market) {
  const value = clean(market).toUpperCase();
  if (!looksLikeMarketCode(value)) return { saved: false, market: "", error: "That is not a market code." };
  if (!TABLE_AGENT_LOGINS) return { saved: false, market: "", error: "Agent login is not set up yet (LARK_TABLE_AGENT_LOGINS is missing)." };
  try {
    const rows = parseMarketRows(await listRecords(TABLE_AGENT_LOGINS, 500, { force: true }));
    const set = marketOf(rows, accountKey, login);
    if (set.market) return { saved: false, market: set.market };
    if (!set.own?.recordId) return { saved: false, market: "", error: "Your LiveChat login has no row in the Agent Logins table yet." };
    await updateRecord(TABLE_AGENT_LOGINS, set.own.recordId, { [F.market]: value });
    return { saved: true, market: value };
  } catch (err) {
    return { saved: false, market: "", error: `The market could not be saved (is the "Default Market" column in the Agent Logins table?): ${err.message}` };
  }
}
