import { listRecords, toDisplay, updateRecord, TABLE_AGENT_LOGINS } from "./lark.js";

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

export async function defaultMarketFor(accountKey, login) {
  if (!TABLE_AGENT_LOGINS) return "";
  try {
    return pickDefaultMarket(parseMarketRows(await listRecords(TABLE_AGENT_LOGINS, 500, { force: true })), accountKey, login);
  } catch (_) {
    return "";
  }
}

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
