import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";

const RTN_GROUP = /^priority\s+(?:96|tc)$/i;

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.error || `LiveChat request failed (${response.status})`);
  }
  return data;
}

export async function handler(event) {
  try {
    const { accountKey, agentToken } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !agentToken) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "LiveChat login is required." }) };
    }

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
    return { statusCode: 200, body: JSON.stringify({ ok: true, accountKey, department, groups: names }) };
  } catch (error) {
    const missingAgentScope = /agents--my:ro|missing scope/i.test(String(error.message || ""));
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: false,
        error: missingAgentScope
          ? "LiveChat login needs the Read my agent profile permission (agents--my:ro). Add it to this OAuth client, then reconnect."
          : error.message,
      }),
    };
  }
}

export const onRequest = adapt(handler);
