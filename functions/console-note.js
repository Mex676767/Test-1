import { adapt } from "./_lib/adapt.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { TABLE_AGENT_LOGINS } from "./_lib/lark.js";
import { bindingFor, readBindings } from "./agent-login.js";

// Notes from the widget to the VIP Retention Console ("Relationship notes" of a player).
//
// The browser sends the player, the brand, the note and the agent's LiveChat login. This function asks LiveChat who that login
// is and which Agent Name the "Livechat App Agent Logins" table bound to it, and sends THAT name to the console as the author.
// A name typed or sent by the browser is never used, and a login that cannot be verified or has no bound name is refused.
//
// Env (Cloudflare Pages, encrypted): CONSOLE_API_URL (e.g. https://console.example.workers.dev) and CONSOLE_NOTE_TOKEN (the console's
// WIDGET_API_KEY). Neither is ever sent to the browser or logged.
//
// The console is reached with a time limit and every failure is turned into a short message. This file never touches the lookup,
// the case rows, the shared Lark queue or the Durable Object, except one cached read of the agent-logins table (the same read a
// sign-in makes, shared for 60 seconds).
const ACCOUNT_KEYS = ["lc1", "lc2"];
const NOTE_MAX = 2000;
const CONSOLE_TIMEOUT_MS = 8_000;
const VERIFY_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 10;
const PER_MINUTE = 20;

const clean = (value) => String(value ?? "").trim();
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

// A few notes a minute per signed-in agent: a stuck button or a script cannot flood the console. Per server instance, so it is a
// brake, not an exact count (the console has its own flood guard across all agents).
const recent = new Map(); // login -> timestamps (ms)
function tooMany(login, now = Date.now()) {
  const list = (recent.get(login) || []).filter((at) => now - at < 60_000);
  if (list.length >= PER_MINUTE) { recent.set(login, list); return true; }
  list.push(now);
  recent.set(login, list);
  return false;
}
export function resetNoteLimits() { recent.clear(); }

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Where the console is, or "" when it is not set up. Plain http is allowed only for a machine's own address (local testing).
export function consoleBase(env) {
  const raw = clean(env?.CONSOLE_API_URL).replace(/\/+$/, "");
  if (!raw || !clean(env?.CONSOLE_NOTE_TOKEN)) return "";
  let url;
  try { url = new URL(raw); } catch (_) { return ""; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
  return raw;
}

// The agent the browser's LiveChat login belongs to: { name, login } or { response } to send back.
async function verifiedAgent(env, accountKey, agentToken) {
  if (!ACCOUNT_KEYS.includes(accountKey) || !clean(agentToken)) {
    return { response: reply(401, { ok: false, loginExpired: true, error: "Connect LiveChat first: a note has to say which agent wrote it." }) };
  }
  if (!TABLE_AGENT_LOGINS) {
    return { response: reply(200, { ok: false, error: "Agent login is not set up yet, so notes cannot be saved." }) };
  }
  const who = await withTimeout(identifyAgent(env, accountKey, agentToken), VERIFY_TIMEOUT_MS, "LiveChat did not answer in time.");
  if (!who.ok) return { response: reply(401, { ok: false, loginExpired: true, error: who.error }) };
  let bound = bindingFor(await withTimeout(readBindings({ cached: true }), VERIFY_TIMEOUT_MS, "The agent list did not answer in time."), accountKey, who.login);
  // A name bound a moment ago may not be in the shared copy yet: the table as it is now decides.
  if (!bound) bound = bindingFor(await withTimeout(readBindings(), VERIFY_TIMEOUT_MS, "The agent list did not answer in time."), accountKey, who.login);
  if (!bound) {
    return { response: reply(403, { ok: false, error: "Your LiveChat login has no Agent Name yet. Sign in to the widget again and pick your name first." }) };
  }
  return { name: bound.name, login: who.login };
}

// What the console said, in words an agent can act on. The console's own text is shown only for a rejected input (400).
function consoleProblem(status, text) {
  if (status === 404) return "This player is not in the console, so the note was not saved.";
  if (status === 429) return "Too many notes right now. Wait a minute and try again.";
  if (status === 400 && text) return `The console did not accept the note: ${text.slice(0, 120)}`;
  if (status === 401) return "The widget is not connected to the console correctly. Tell your admin; the note was not saved.";
  return "The console could not save the note. Try again in a moment.";
}

async function callConsole(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS) });
  } catch (_) {
    // A timeout or a network error: whether the console got the request is unknown.
    return { unknown: true };
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

export async function handler(event) {
  try {
    let input;
    try { input = JSON.parse(event.body || "{}"); } catch (_) { input = null; }
    if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400, { ok: false, error: "Bad request." });
    const username = clean(input.username).toLowerCase();
    const brand = clean(input.brand);
    if (!username || !brand || brand.length > 60) return reply(400, { ok: false, error: "A player username and brand are needed to add a note." });
    const list = input.list === true;
    const note = clean(input.note);
    if (!list) {
      if (!note) return reply(400, { ok: false, error: "Write the note first." });
      if (note.length > NOTE_MAX) return reply(400, { ok: false, error: `The note is too long (${note.length} of ${NOTE_MAX} characters).` });
    }

    const base = consoleBase(event.env);
    if (!base) return reply(200, { ok: false, notConfigured: true, error: "Notes are not set up yet. Tell your admin." });

    let agent;
    try { agent = await verifiedAgent(event.env, clean(input.accountKey), input.agentToken); }
    catch (_) { return reply(200, { ok: false, error: "Could not check your LiveChat login just now. Try again." }); }
    if (agent.response) return agent.response;

    const headers = { "x-widget-token": clean(event.env.CONSOLE_NOTE_TOKEN) };
    if (list) {
      const result = await callConsole(`${base}/api/ext/notes?${new URLSearchParams({ player_key: username, brand })}`, { method: "GET", headers });
      if (result.unknown) return reply(200, { ok: false, error: "The console did not answer. Notes are not shown right now." });
      if (result.status !== 200) return reply(200, { ok: false, notFound: result.status === 404, error: consoleProblem(result.status, "") });
      const notes = (Array.isArray(result.data?.notes) ? result.data.notes : []).slice(0, LIST_LIMIT)
        .map((item) => ({ note: String(item?.note ?? "").slice(0, NOTE_MAX), by: String(item?.created_by ?? "").slice(0, 80), at: String(item?.created_at ?? "").slice(0, 40) }));
      return reply(200, { ok: true, notes });
    }

    if (tooMany(agent.login)) return reply(429, { ok: false, error: "Too many notes in a minute. Wait a little and try again." });
    // The author is the Agent Name exactly as the widget has it; the console shortens it itself.
    const result = await callConsole(`${base}/api/ext/note`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ player_key: username, brand, note, author: agent.name }),
    });
    if (result.unknown) {
      return reply(200, { ok: false, unsure: true, error: "The console did not answer, so the note may or may not have been saved. Check the player's notes before sending it again." });
    }
    if (result.status === 200 && result.data?.saved === true) return reply(200, { ok: true, saved: true });
    return reply(200, { ok: false, error: consoleProblem(result.status, clean(result.data?.error)) });
  } catch (err) {
    console.warn("Console note failed", String(err?.message || err).slice(0, 160));
    return reply(200, { ok: false, error: "The note could not be saved. Try again in a moment." });
  }
}

export const onRequest = adapt(handler);
