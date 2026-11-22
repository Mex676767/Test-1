import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";

// Read-only: every LiveChat group (id + name) for each license the caller is signed in to.
// The PAT does the listing, but only for a license where the caller sent a valid LiveChat login for that same license.
async function listAllGroups(pat) {
  const response = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${pat}` },
    body: "{}",
  });
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new Error(data?.error?.message || data?.error || `LiveChat list_groups failed (${response.status})`);
  }
  return data
    .map((group) => ({ id: group.id, name: String(group.name ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export async function handler(event) {
  let agentTokens = {};
  try { agentTokens = JSON.parse(event.body || "{}").agentTokens || {}; } catch (_) { }

  const licenses = [];
  for (const account of LIVECHAT_ACCOUNTS) {
    const token = String(agentTokens[account.key] || "").trim();
    if (!token) continue;
    const who = await identifyAgent(event.env, account.key, token);
    if (!who.ok) {
      licenses.push({ accountKey: account.key, ok: false, error: who.error });
      continue;
    }
    try {
      licenses.push({ accountKey: account.key, ok: true, groups: await listAllGroups(account.pat) });
    } catch (error) {
      licenses.push({ accountKey: account.key, ok: false, error: error.message });
    }
  }

  if (!licenses.length) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "Sign in with LiveChat first.", configured: LIVECHAT_ACCOUNTS.map((a) => a.key) }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, licenses }), headers: { "Cache-Control": "no-store" } };
}

export const onRequest = adapt(handler);
