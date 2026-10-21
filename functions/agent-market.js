import { adapt } from "./_lib/adapt.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { defaultMarketFor, rememberDefaultMarket } from "./_lib/default-market.js";

function reply(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }

export async function handler(event) {
  if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });
  try {
    const { author, market } = JSON.parse(event.body || "{}");
    const accountKey = String(author?.accountKey || "");
    const agentToken = String(author?.agentToken || "").trim();
    if (!/^lc[12]$/.test(accountKey) || !agentToken) return reply(400, { ok: false, error: "LiveChat login is required." });

    const who = await identifyAgent(event.env, accountKey, agentToken);
    if (!who.ok) return reply(200, who);

    if (market === undefined || market === null || market === "") {
      return reply(200, { ok: true, market: await defaultMarketFor(accountKey, who.login) });
    }
    const result = await rememberDefaultMarket(accountKey, who.login, market);
    if (result.error) return reply(200, { ok: false, error: result.error });
    return reply(200, { ok: true, market: result.market, saved: result.saved });
  } catch (err) {
    if (err instanceof SyntaxError) return reply(400, { ok: false, error: "Malformed JSON" });
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
