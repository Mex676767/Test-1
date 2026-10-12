import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";

// Retention = the signed-in agent belongs to the LiveChat group "Priority 96" or "Priority TC"; everyone else is Customer Service.
const RTN_GROUP = /^priority\s+(?:96|tc)$/i;

// The group list is the same for every agent and the groups an agent belongs to rarely change, but every widget load asks:
// remember each for a few minutes per isolate (the agent's own answer is kept per LiveChat account + login).
const GROUPS_TTL_MS = 10 * 60_000;
const AGENT_TTL_MS = 5 * 60_000;
const groupListCache = new Map(); // account key -> { at, groups }
const agentGroupCache = new Map(); // `${account key}|${login}` -> { at, ids }
export function resetDepartmentCache() { groupListCache.clear(); agentGroupCache.clear(); }

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.error || `LiveChat request failed (${response.status})`);
  }
  return data;
}

async function listGroups(account) {
  const cached = groupListCache.get(account.key);
  if (cached && Date.now() - cached.at < GROUPS_TTL_MS) return cached.groups;
  const groups = await json("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${account.pat}` }, body: "{}",
  });
  if (Array.isArray(groups)) groupListCache.set(account.key, { at: Date.now(), groups });
  return Array.isArray(groups) ? groups : [];
}

// A Configuration API agent is identified by their email. The account's PAT (agents--all:ro) is asked first; the agent's own login
// (agents--my:ro on the OAuth app) is the fallback, with the email and then the account id.
async function agentGroupIds(account, agentToken, who) {
  const cacheKey = `${account.key}|${who.login}`;
  const cached = agentGroupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AGENT_TTL_MS) return cached.ids;
  const email = who.identities.find((id) => id.includes("@")) || "";
  const attempts = [
    ...(email ? [["PAT", `Basic ${account.pat}`, email], ["own login", `Bearer ${agentToken}`, email]] : []),
    ["own login", `Bearer ${agentToken}`, who.login],
  ];
  const reasons = [];
  for (const [via, authorization, id] of attempts) {
    try {
      const agent = await json("https://api.livechatinc.com/v3.6/configuration/action/get_agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify({ id, fields: ["groups"] }),
      });
      const ids = (agent.groups || []).map((group) => String(group?.id ?? group));
      agentGroupCache.set(cacheKey, { at: Date.now(), ids });
      return ids;
    } catch (error) {
      reasons.push(`${via}: ${error.message}`);
    }
  }
  throw new Error(reasons.join("; "));
}

export async function handler(event) {
  try {
    const { accountKey, agentToken } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !agentToken) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "LiveChat login is required." }) };
    }

    // Who the token belongs to is asked of LiveChat; the browser's own word about who it is is never used.
    const who = await identifyAgent(event.env, accountKey, agentToken, { withEmail: true, pat: account.pat });
    if (!who.ok) return { statusCode: 200, body: JSON.stringify(who) };

    const [ids, groups] = await Promise.all([agentGroupIds(account, agentToken, who), listGroups(account)]);
    const idSet = new Set(ids);
    const names = groups.filter((group) => idSet.has(String(group.id))).map((group) => String(group.name || ""));
    const department = names.some((name) => RTN_GROUP.test(name.trim())) ? "rtn" : "cs";
    return { statusCode: 200, body: JSON.stringify({ ok: true, accountKey, department, groups: names }) };
  } catch (error) {
    const missingScope = /agents--(?:my|all):ro|missing scope/i.test(String(error.message || ""));
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: false,
        error: missingScope
          ? "LiveChat could not read this agent's groups: the account's token needs agents--all:ro (or the login needs agents--my:ro)."
          : error.message,
      }),
    };
  }
}

export const onRequest = adapt(handler);
