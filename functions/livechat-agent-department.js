import { adapt } from "./_lib/adapt.js";
import { isMissingAgentScope, lookupAgentDepartment } from "./_lib/livechat-department.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";

export async function handler(event) {
  try {
    const { accountKey, agentToken } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !agentToken) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "LiveChat login is required." }) };
    }

    const { department, groups } = await lookupAgentDepartment(accountKey, agentToken);
    return { statusCode: 200, body: JSON.stringify({ ok: true, accountKey, department, groups }) };
  } catch (error) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: false,
        error: isMissingAgentScope(error)
          ? "LiveChat login needs the Read my agent profile permission (agents--my:ro). Add it to this OAuth client, then reconnect."
          : error.message,
      }),
    };
  }
}

export const onRequest = adapt(handler);
