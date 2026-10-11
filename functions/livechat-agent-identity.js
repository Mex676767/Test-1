import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";

// Who is the signed-in agent, as a chat knows them? LiveChat's login id (account_id) is a UUID, but a chat lists an agent by
// their EMAIL, and Blast needs that to add the agent to an open chat (add_user_to_chat answers "`user_id` not found" for the
// UUID). The browser's own word about who it is is never used: LiveChat is asked with the agent's token.
export async function handler(event) {
  try {
    const { accountKey, agentToken } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !String(agentToken || "").trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "accountKey and agentToken are required." }) };
    }
    const who = await identifyAgent(event.env, accountKey, agentToken, { withEmail: true, pat: account.pat });
    if (!who.ok) return { statusCode: 200, body: JSON.stringify(who) };
    const email = who.identities.find((id) => id.includes("@")) || "";
    return { statusCode: 200, body: JSON.stringify({ ok: true, login: who.login, email, ...(who.emailLookup ? { emailLookup: who.emailLookup } : {}) }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
