import { adapt } from "./_lib/adapt.js";

export const TICK_TTL_SECONDS = 120 * 24 * 3600;
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const clean = (value) => String(value ?? "").trim();
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

export const tickKey = (threadId, chatId, agent) => `t:${threadId || `c-${chatId}`}:${agent.toLowerCase()}`;

export async function handler(event) {
  try {
    const kv = event.env?.UNKNOWN_TICKS;
    if (!kv) return reply(200, { ok: false, notConfigured: true, error: "UNKNOWN_TICKS (a KV binding) is not set." });
    const body = JSON.parse(event.body || "{}");
    const threadId = clean(body.threadId);
    const chatId = clean(body.chatId);
    const agent = clean(body.agentName).replace(/\s+/g, " ");
    if (!agent || agent.length > 120) return reply(400, { ok: false, error: "agentName is required." });
    if (!threadId && !chatId) return reply(400, { ok: false, error: "threadId or chatId is required." });
    if ((threadId && !ID.test(threadId)) || (chatId && !ID.test(chatId))) return reply(400, { ok: false, error: "Invalid chat id." });

    if (body.ticked === false) {
      const keys = [threadId && tickKey(threadId, "", agent), chatId && tickKey("", chatId, agent)].filter(Boolean);
      await Promise.all(keys.map((key) => kv.delete(key)));
      return reply(200, { ok: true, ticked: false });
    }

    const at = Date.now();
    const source = body.source === "auto" ? "auto" : "manual";
    await kv.put(tickKey(threadId, chatId, agent), "1", { expirationTtl: TICK_TTL_SECONDS, metadata: { threadId, chatId, agent, source, at } });
    if (!(await kv.get("meta:since"))) await kv.put("meta:since", String(at));
    return reply(200, { ok: true, ticked: true });
  } catch (err) {
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
