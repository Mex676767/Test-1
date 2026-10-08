import { identifyAgent } from "./livechat-identity.js";
import { isMissingAgentScope, lookupAgentDepartment } from "./livechat-department.js";

// Per-agent ticket accounts. An agent connects their own ticket-system account once; the widget keeps the token against
// their verified LiveChat login, encrypted with TICKET_TOKEN_SECRET, in a Cloudflare KV namespace. There is one namespace
// per team (retention and customer service are different teams): TICKET_CONNECTIONS_RTN and TICKET_CONNECTIONS_CS. Which one
// an agent's token lives in is decided here from their LiveChat groups, never from anything the browser says. Neither
// namespace is a Lark base, and neither holds anything but "this LiveChat login -> sealed ticket token". After connecting,
// their tickets and comments are made with THEIR token: they appear under their own name and the ticket system notifies
// them itself.
//
// The browser never says who it is. It sends its LiveChat login token (X-LiveChat-Agent-Token + X-LiveChat-Account) and
// this file asks LiveChat who that is and which team they are on.
//
// Nothing here is on unless TICKET_TOKEN_SECRET and both bindings exist: without them every call behaves as before (the
// shared TICKETS_API_KEY). If an agent's team cannot be read (LiveChat's agents--my:ro scope is missing, or LiveChat is
// unreachable) nothing is guessed: no token is stored or read for them.
const clean = (value) => String(value ?? "").trim();

// Swapped by tests; production asks LiveChat.
export const deps = {
  identify: (env, accountKey, agentToken) => identifyAgent(env, accountKey, agentToken),
  department: (_env, accountKey, agentToken) => lookupAgentDepartment(accountKey, agentToken),
};

const usable = (store) => Boolean(store) && typeof store.get === "function" && typeof store.put === "function";

export function connectionAvailable(env) {
  return Boolean(clean(env?.TICKET_TOKEN_SECRET)) && usable(env?.TICKET_CONNECTIONS_RTN) && usable(env?.TICKET_CONNECTIONS_CS);
}

// ---- encryption at rest (AES-GCM, key = SHA-256 of the secret) --------------------------------------------------------
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealToken(secret, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(plain));
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(data))}`;
}

// "" when the value is not ours, was made with another secret, or has been tampered with.
export async function openToken(secret, sealed) {
  try {
    const [version, iv, data] = clean(sealed).split(".");
    if (version !== "v1" || !iv || !data) return "";
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(secret), fromB64(data));
    return new TextDecoder().decode(plain);
  } catch (_) { return ""; }
}

// ---- who is asking, and on which team -------------------------------------------------------------------------------------
// A LiveChat check per request would be wasteful; a verified agent is remembered for five minutes in this isolate.
const agentCache = new Map(); // `${account}:${token}` -> { login, department, expires }
const AGENT_TTL_MS = 5 * 60_000;

// { ok: true, login, department }
// { ok: false, loginExpired, error }                       the LiveChat login is no good
// { ok: false, teamUnknown: true, scopeMissing, error }    logged in, but the team could not be read
export async function verifiedAgent(env, accountKey, agentToken) {
  const key = `${accountKey}:${agentToken}`;
  const cached = agentCache.get(key);
  if (cached && cached.expires > Date.now()) return { ok: true, login: cached.login, department: cached.department };

  const who = await deps.identify(env, accountKey, agentToken);
  if (!who.ok) return who;

  let team;
  try {
    team = await deps.department(env, accountKey, agentToken);
  } catch (err) {
    const scopeMissing = isMissingAgentScope(err);
    return {
      ok: false, teamUnknown: true, scopeMissing,
      error: scopeMissing
        ? "Per-agent ticket sign-in needs LiveChat's \"Read my agent profile\" permission (agents--my:ro) on the app, then a fresh LiveChat login."
        : "Could not check your team with LiveChat — try again.",
    };
  }
  const department = team?.department === "rtn" ? "rtn" : team?.department === "cs" ? "cs" : "";
  if (!department) return { ok: false, teamUnknown: true, scopeMissing: false, error: "Could not check your team with LiveChat — try again." };

  if (agentCache.size > 500) agentCache.clear();
  agentCache.set(key, { login: who.login, department, expires: Date.now() + AGENT_TTL_MS });
  return { ok: true, login: who.login, department };
}

export function agentHeaders(event) {
  const headers = event.headers || {};
  const accountKey = clean(headers["x-livechat-account"]).toLowerCase();
  const agentToken = clean(headers["x-livechat-agent-token"]);
  return /^lc[12]$/.test(accountKey) && agentToken ? { accountKey, agentToken } : null;
}

// One entry per LiveChat login (account + account_id), in that team's own namespace.
const storeKey = (accountKey, login) => `ticket-token:${accountKey}:${login}`;
const storeFor = (env, department) => (department === "rtn" ? env.TICKET_CONNECTIONS_RTN : env.TICKET_CONNECTIONS_CS);

// What a ticket call should run as.
//   { env, personal: false }          shared key (no LiveChat login sent, feature off, team unreadable for good, or not connected)
//   { env, personal: true }           the agent's own token
//   { failure: <response> }           the LiveChat login is bad, the team could not be read right now, or the stored token cannot be opened
export async function ticketAccess(event) {
  const shared = { env: event.env, personal: false };
  const login = agentHeaders(event);
  if (!login || !connectionAvailable(event.env)) return shared;

  const agent = await verifiedAgent(event.env, login.accountKey, login.agentToken);
  if (!agent.ok && agent.loginExpired) return { failure: { statusCode: 401, body: JSON.stringify({ ok: false, loginExpired: true, error: agent.error }) } };
  // The permission is missing for everyone until it is added: nobody can be connected, so the shared account stays in use.
  if (!agent.ok && agent.scopeMissing) return shared;
  if (!agent.ok) return { failure: { statusCode: 503, body: JSON.stringify({ ok: false, error: agent.error }) } };

  const sealed = await storeFor(event.env, agent.department).get(storeKey(login.accountKey, agent.login));
  if (!sealed) return shared;

  const token = await openToken(clean(event.env.TICKET_TOKEN_SECRET), sealed);
  if (!token) {
    return { failure: { statusCode: 401, body: JSON.stringify({ ok: false, ticketReconnect: true, error: "Your ticket connection could not be used — connect your ticket account again." }) } };
  }
  return { env: { ...event.env, TICKETS_API_KEY: token }, personal: true };
}

// A refusal from the ticket service for a PERSONAL token means that token is no good any more (removed, expired, account
// deactivated): say so, so the widget can offer Connect again, instead of an unexplained "Not signed in.".
export function personalFailure(access, err) {
  if (!access.personal || Number(err?.statusCode) !== 401) return null;
  return { statusCode: 401, body: JSON.stringify({ ok: false, ticketReconnect: true, error: "Your ticket login expired or was removed — connect your ticket account again." }) };
}

// ---- connect / disconnect (used by /ticket-connect) -----------------------------------------------------------------
// A response the widget can show as is: not connected and why, or a LiveChat login to renew.
function unreadable(agent) {
  if (agent.loginExpired) return { ok: false, loginExpired: true, error: agent.error };
  // Without the permission nobody can connect yet; say so instead of showing a Connect button that cannot work.
  if (agent.scopeMissing) return { ok: true, available: false, connected: false, error: agent.error };
  return { ok: false, error: agent.error };
}

export async function connectionStatus(event, login) {
  const agent = await verifiedAgent(event.env, login.accountKey, login.agentToken);
  if (!agent.ok) return unreadable(agent);
  const sealed = await storeFor(event.env, agent.department).get(storeKey(login.accountKey, agent.login));
  return { ok: true, connected: Boolean(sealed), department: agent.department };
}

// ticketToken "" disconnects.
export async function storeToken(event, login, ticketToken) {
  const agent = await verifiedAgent(event.env, login.accountKey, login.agentToken);
  if (!agent.ok) return unreadable(agent);
  const store = storeFor(event.env, agent.department);
  const key = storeKey(login.accountKey, agent.login);
  if (ticketToken === "") {
    await store.delete(key);
    return { ok: true, connected: false };
  }
  await store.put(key, await sealToken(clean(event.env.TICKET_TOKEN_SECRET), ticketToken));
  return { ok: true, connected: true };
}
