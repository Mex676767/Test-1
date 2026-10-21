import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { listRecords, TABLE_AGENT_LOGINS } from "./_lib/lark.js";
import { parseBindings } from "./agent-login.js";

const headers = { "Cache-Control": "no-store" };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const clean = (value) => String(value ?? "").trim();

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function listAgents(account) {
  const response = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_agents", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${account.pat}` },
    body: "{}",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data)) {
    throw new Error(clean(data?.error?.message || data?.error) || `LiveChat answered HTTP ${response.status}`);
  }
  return data;
}

export async function handler(event) {
  const key = event.env?.LIVECHAT_AGENTS_KEY;
  if (!key) return reply(404, { ok: false, error: "Not found" });
  if (event.httpMethod !== "GET") return reply(405, { ok: false, error: "Method not allowed" });
  if (!sameSecret(String(event.headers?.["x-agents-key"] || ""), String(key))) return reply(401, { ok: false, error: "Unauthorized" });
  if (!LIVECHAT_ACCOUNTS.length) return reply(503, { ok: false, error: "No LiveChat account is configured" });

  let bindings = [];
  let bindingsError = "";
  if (TABLE_AGENT_LOGINS) {
    try { bindings = parseBindings(await listRecords(TABLE_AGENT_LOGINS, 500, { sharedCacheMs: 60_000 })); }
    catch (error) { bindingsError = clean(error?.message).slice(0, 200) || "unavailable"; }
  }

  const agents = [];
  const errors = {};
  for (const account of LIVECHAT_ACCOUNTS) {
    try {
      for (const agent of await listAgents(account)) {
        const email = clean(agent.id).toLowerCase();
        const bound = bindings.find((row) => row.account === account.key && row.email === email);
        agents.push({
          account: account.key,
          email,
          name: clean(agent.name),
          role: clean(agent.role),
          signedIn: Boolean(bound),
          login: bound?.login || "",
          agentName: bound?.name || "",
        });
      }
    } catch (error) {
      errors[account.key] = clean(error?.message).slice(0, 200);
    }
  }
  agents.sort((a, b) => a.account.localeCompare(b.account) || a.email.localeCompare(b.email));

  if (!agents.length && Object.keys(errors).length) return reply(502, { ok: false, error: "LiveChat did not return the agents", errors });
  return reply(200, {
    ok: true,
    at: new Date().toISOString(),
    count: agents.length,
    agents,
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(bindingsError ? { signInTableError: bindingsError } : {}),
  });
}

export const onRequest = adapt(handler);
