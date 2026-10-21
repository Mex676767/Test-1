import { adapt } from "./_lib/adapt.js";
import { checkQaLogin } from "./crosscheck.js";

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
