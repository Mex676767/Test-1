import { identifyAgent } from "./livechat-identity.js";

// Per-agent ticket accounts. An agent connects their own ticket-system account once; the widget keeps the token against
// their verified LiveChat login, encrypted with TICKET_TOKEN_SECRET, in a Cloudflare KV namespace bound as
// TICKET_CONNECTIONS. That store is separate from every Lark base on purpose: it holds nothing but "this LiveChat login ->
// sealed ticket token", so it works the same for retention and customer-service agents and none of it sits next to
// player data. After connecting, their tickets and comments are made with THEIR token: they appear under their own name
// and the ticket system notifies them itself.
//
// The browser never says who it is. It sends its LiveChat login token (X-LiveChat-Agent-Token + X-LiveChat-Account) and
// this file asks LiveChat who that is, exactly like /agent-login does.
//
// Nothing here is on unless TICKET_TOKEN_SECRET and the TICKET_CONNECTIONS binding exist: without them every call behaves
// as before (the shared TICKETS_API_KEY).
const clean = (value) => String(value ?? "").trim();

// Swapped by tests; production asks LiveChat.
export const deps = {
  identify: (env, accountKey, agentToken) => identifyAgent(env, accountKey, agentToken),
};

export function connectionAvailable(env) {
  const store = env?.TICKET_CONNECTIONS;
  return Boolean(clean(env?.TICKET_TOKEN_SECRET)) && Boolean(store) && typeof store.get === "function" && typeof store.put === "function";
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

// ---- who is asking -------------------------------------------------------------------------------------------------------
// A LiveChat check per request would be wasteful; a verified login is remembered for five minutes in this isolate.
const identityCache = new Map(); // `${account}:${token}` -> { login, expires }
const IDENTITY_TTL_MS = 5 * 60_000;
export async function verifiedLogin(env, accountKey, agentToken) {
  const key = `${accountKey}:${agentToken}`;
  const cached = identityCache.get(key);
  if (cached && cached.expires > Date.now()) return { ok: true, login: cached.login };
  const who = await deps.identify(env, accountKey, agentToken);
  if (!who.ok) return who;
  if (identityCache.size > 500) identityCache.clear();
  identityCache.set(key, { login: who.login, expires: Date.now() + IDENTITY_TTL_MS });
  return { ok: true, login: who.login };
}

export function agentHeaders(event) {
  const headers = event.headers || {};
  const accountKey = clean(headers["x-livechat-account"]).toLowerCase();
  const agentToken = clean(headers["x-livechat-agent-token"]);
  return /^lc[12]$/.test(accountKey) && agentToken ? { accountKey, agentToken } : null;
}

// One entry per LiveChat login (account + account_id), so the same person on both accounts has two.
const storeKey = (accountKey, login) => `ticket-token:${accountKey}:${login}`;

// What a ticket call should run as.
//   { env, personal: false }          shared key (no LiveChat login sent, feature off, or the agent has not connected)
//   { env, personal: true }           the agent's own token
//   { failure: <response> }           the LiveChat login is bad, or the stored token cannot be opened
export async function ticketAccess(event) {
  const shared = { env: event.env, personal: false };
  const login = agentHeaders(event);
  if (!login || !connectionAvailable(event.env)) return shared;

  const who = await verifiedLogin(event.env, login.accountKey, login.agentToken);
  if (!who.ok) return { failure: { statusCode: 401, body: JSON.stringify({ ok: false, loginExpired: true, error: who.error }) } };

  const sealed = await event.env.TICKET_CONNECTIONS.get(storeKey(login.accountKey, who.login));
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
export async function connectionStatus(event, login) {
  const who = await verifiedLogin(event.env, login.accountKey, login.agentToken);
  if (!who.ok) return { ok: false, loginExpired: true, error: who.error };
  const sealed = await event.env.TICKET_CONNECTIONS.get(storeKey(login.accountKey, who.login));
  return { ok: true, connected: Boolean(sealed) };
}

// ticketToken "" disconnects.
export async function storeToken(event, login, ticketToken) {
  const who = await verifiedLogin(event.env, login.accountKey, login.agentToken);
  if (!who.ok) return { ok: false, loginExpired: true, error: who.error };
  const key = storeKey(login.accountKey, who.login);
  if (ticketToken === "") {
    await event.env.TICKET_CONNECTIONS.delete(key);
    return { ok: true, connected: false };
  }
  await event.env.TICKET_CONNECTIONS.put(key, await sealToken(clean(event.env.TICKET_TOKEN_SECRET), ticketToken));
  return { ok: true, connected: true };
}
