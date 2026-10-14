import { adapt } from "./_lib/adapt.js";
import { checkQaLogin } from "./crosscheck.js";

// Is this signed-in LiveChat login marked QA in the Agent Logins table (Role = QA)? Asked by the installed widget right after an agent
// signs in: a QA person gets the QA view (QA, Tickets and Knowledge tabs only). The token is checked with LiveChat, never the browser's
// word; the decision itself is checkQaLogin (shared with the QA page's /crosscheck access). Read-only.
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

export async function handler(event) {
  try {
    const { accountKey, agentToken } = JSON.parse(event.body || "{}");
    const token = String(agentToken ?? "").trim();
    if (!["lc1", "lc2"].includes(accountKey) || !token) return reply(400, { ok: false, error: "LiveChat login is required." });
    const check = await checkQaLogin(event.env, accountKey, token);
    if (!check.ok) return reply(200, { ok: false, loginExpired: true, error: check.error });
    return reply(200, { ok: true, qa: check.qa });
  } catch (err) {
    return reply(200, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
