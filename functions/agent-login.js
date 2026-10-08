import { adapt } from "./_lib/adapt.js";
import { identifyAgent, findAgentEmail } from "./_lib/livechat-identity.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { listRecords, createRecord, updateRecord, deleteRecord, listFields, toDisplay, TABLE_AGENT_LOGINS, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

// LiveChat login -> agent name. The first time an agent signs in with LiveChat they pick their agent name once; it is
// stored in the Lark table "Livechat App Agent Logins" and every later sign-in with that LiveChat account gets the same
// name back. Only the table's owner changes it (edit or delete the row in Lark).
//
// A row means "this LiveChat login, on this LiveChat account (lc1/lc2), is this agent name". One agent name may be used
// by two logins, one per LiveChat account, so a name is unique per account, never overall.
//
// Lark has no unique constraint, so a claim is: create the row, read the table again, and keep the earliest row for
// that account + name. A later claimant deletes its own row and is told the name is taken.
// "Livechat Email" (the spelling of the Lark column) is filled in automatically the first time a login is seen after it was
// added: the one-time crosscheck uses it to tell which agent name a LiveChat email belongs to.
const F = { account: "LiveChat Account", login: "LiveChat Login", email: "Livechat Email", name: "Agent Name", lockedAt: "Locked At" };
const ACCOUNT_KEYS = ["lc1", "lc2"];

function reply(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
const clean = (value) => String(value ?? "").trim();

// Blank rows (the table starts with a few) and half-filled ones are ignored.
export function parseBindings(items) {
  return (items || [])
    .map((item) => {
      const f = item.fields || {};
      return {
        recordId: item.record_id || item.id || "",
        account: clean(toDisplay(f[F.account])).toLowerCase(),
        login: clean(toDisplay(f[F.login])),
        email: clean(toDisplay(f[F.email])).toLowerCase(),
        name: clean(toDisplay(f[F.name])),
        lockedAt: Number(f[F.lockedAt]) || 0,
      };
    })
    .filter((row) => row.recordId && row.account && row.login && row.name);
}

// Earliest claim first; the record id breaks a tie so every reader picks the same winner.
export function claimOrder(a, b) {
  return (a.lockedAt - b.lockedAt) || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
}

export function bindingFor(rows, account, login) {
  return rows.filter((row) => row.account === account && row.login === login).sort(claimOrder)[0] || null;
}

// Names nobody on this LiveChat account has taken yet (case-insensitive).
export function availableNames(allNames, rows, account) {
  const taken = new Set(rows.filter((row) => row.account === account).map((row) => row.name.toLowerCase()));
  return allNames.filter((name) => !taken.has(name.toLowerCase()));
}

export function claimWinner(rows, account, name) {
  return rows.filter((row) => row.account === account && row.name.toLowerCase() === name.toLowerCase()).sort(claimOrder)[0] || null;
}

async function readBindings() {
  // force: this is the read that decides who owns a name, so it must never be a cached copy.
  return parseBindings(await listRecords(TABLE_AGENT_LOGINS, 500, { force: true }));
}

// Best effort and never blocks a login: the email is only an extra for the crosscheck.
async function emailFor(accountKey, login, agentToken) {
  try {
    const pat = LIVECHAT_ACCOUNTS.find((account) => account.key === accountKey)?.pat || "";
    return clean((await findAgentEmail(login, agentToken, pat)).email).toLowerCase();
  } catch (_) { return ""; }
}

async function readAgentNames() {
  const fields = await listFields(TABLE_CUSTOMER_APPROACHING, undefined, { force: true });
  const field = fields.find((item) => item.field_name === "Agent Name");
  return (field?.property?.options || []).map((option) => clean(option.name)).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export async function handler(event) {
  try {
    const { accountKey, agentToken, name } = JSON.parse(event.body || "{}");
    if (!ACCOUNT_KEYS.includes(accountKey) || !clean(agentToken)) {
      return reply(400, { ok: false, error: "LiveChat login is required." });
    }
    if (!TABLE_AGENT_LOGINS) {
      return reply(200, { ok: false, notConfigured: true, error: "Agent login is not set up yet (LARK_TABLE_AGENT_LOGINS is missing)." });
    }

    // Who does LiveChat say this token belongs to? The browser's word is never used for the identity.
    const who = await identifyAgent(event.env, accountKey, agentToken);
    if (!who.ok) return reply(200, who);
    const login = who.login;

    let rows = await readBindings();
    const bound = bindingFor(rows, accountKey, login);
    if (bound) {
      // A login seen before the email column existed gets its email filled in once.
      if (!bound.email) {
        const email = await emailFor(accountKey, login, agentToken);
        if (email) { try { await updateRecord(TABLE_AGENT_LOGINS, bound.recordId, { [F.email]: email }); } catch (_) { /* tried again at the next login */ } }
      }
      return reply(200, { ok: true, bound: true, name: bound.name, login });
    }

    const allNames = await readAgentNames();
    const chosen = clean(name);
    if (!chosen) {
      return reply(200, { ok: true, bound: false, available: availableNames(allNames, rows, accountKey), login });
    }

    const exact = allNames.find((candidate) => candidate.toLowerCase() === chosen.toLowerCase());
    if (!exact) return reply(200, { ok: false, error: `"${chosen}" is not an agent name in the list.` });
    if (claimWinner(rows, accountKey, exact)) {
      return reply(200, { ok: false, taken: true, error: `${exact} is already taken on this LiveChat account.`, available: availableNames(allNames, rows, accountKey) });
    }

    const email = await emailFor(accountKey, login, agentToken);
    const created = await createRecord(TABLE_AGENT_LOGINS, {
      [F.account]: accountKey, [F.login]: login, [F.name]: exact, [F.lockedAt]: Date.now(), ...(email ? { [F.email]: email } : {}),
    });
    const myRecordId = created?.record_id || created?.id || "";

    // Someone else may have claimed the same name in the same moment: read again and keep the earliest row.
    rows = await readBindings();
    const winner = claimWinner(rows, accountKey, exact);
    if (winner && winner.recordId !== myRecordId) {
      try { await deleteRecord(TABLE_AGENT_LOGINS, myRecordId); } catch (_) { /* best effort: the winner is still chosen by claimOrder */ }
      // The earlier row is this same login's own (a double click): nothing is lost, the name is theirs.
      if (winner.login === login) return reply(200, { ok: true, bound: true, name: exact, login });
      return reply(200, { ok: false, taken: true, error: `${exact} was just taken by someone else.`, available: availableNames(allNames, rows.filter((row) => row.recordId !== myRecordId), accountKey) });
    }
    return reply(200, { ok: true, bound: true, name: exact, login, justBound: true });
  } catch (err) {
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
