import { LIVECHAT_ACCOUNTS } from "./livechat.js";

// Which team is a LiveChat agent on? The agent's LiveChat groups decide it: "Priority 96" / "Priority TC" is retention (rtn),
// everyone else is customer service (cs). Shared by /livechat-agent-department and the per-team ticket connections, so
// both always agree. Needs the agent's own login with the agents--my:ro scope (get_agent) and the account's PAT (list_groups).
export const RTN_GROUP = /^priority\s+(?:96|tc)$/i;

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.error || `LiveChat request failed (${response.status})`);
  }
  return data;
}

export function isMissingAgentScope(error) {
  return /agents--my:ro|missing scope/i.test(String(error?.message || ""));
}

// { accountId, department: "rtn" | "cs", groups: [names] }; throws when LiveChat refuses (see isMissingAgentScope).
export async function lookupAgentDepartment(accountKey, agentToken) {
  const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
  if (!account || !agentToken) throw new Error("LiveChat login is required.");

  const info = await json("https://accounts.livechat.com/v2/info", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  if (!info.account_id) throw new Error("LiveChat did not return the signed-in agent ID.");

  const headers = { "Content-Type": "application/json", Authorization: `Basic ${account.pat}` };
  const [agent, groups] = await Promise.all([
    json("https://api.livechatinc.com/v3.6/configuration/action/get_agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ id: info.account_id, fields: ["groups"] }),
    }),
    json("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
      method: "POST", headers, body: "{}",
    }),
  ]);
  const ids = new Set((agent.groups || []).map((group) => String(group?.id ?? group)));
  const names = (Array.isArray(groups) ? groups : [])
    .filter((group) => ids.has(String(group.id)))
    .map((group) => String(group.name || ""));
  const department = names.some((name) => RTN_GROUP.test(name.trim())) ? "rtn" : "cs";
  return { accountId: String(info.account_id), department, groups: names };
}
