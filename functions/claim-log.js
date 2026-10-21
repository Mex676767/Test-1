import { adapt } from "./_lib/adapt.js";

export const CLAIM_TTL_SECONDS = 120 * 24 * 3600;
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const clean = (value) => String(value ?? "").trim();
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const PROGRAM = /^[A-Za-z0-9_-]{1,40}$/;

export const claimPrefix = (threadId, chatId, agent) => `claim:${threadId || `c-${chatId}`}:${agent.toLowerCase()}:`;

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

    if (body.remove === true) {
      const prefixes = [threadId && claimPrefix(threadId, "", agent), chatId && claimPrefix("", chatId, agent)].filter(Boolean);
      for (const prefix of prefixes) {
        const listed = await kv.list({ prefix, limit: 100 });
        await Promise.all(listed.keys.map((key) => kv.delete(key.name)));
      }
      return reply(200, { ok: true, removed: true });
    }

    const claim = body.claim || {};
    const program = clean(claim.program);
    if (!PROGRAM.test(program)) return reply(400, { ok: false, error: "claim.program is required." });
    const at = Date.now();
    const metadata = {
      threadId, chatId, agent, program, at,
      label: clean(claim.label).slice(0, 80),
      source: clean(claim.source).slice(0, 160),
      inquiry: clean(claim.inquiry).slice(0, 80),
      amount: clean(claim.amount).slice(0, 60),
    };
    await kv.put(`${claimPrefix(threadId, chatId, agent)}${program}`, "1", { expirationTtl: CLAIM_TTL_SECONDS, metadata });
    if (!(await kv.get("meta:claims-since"))) await kv.put("meta:claims-since", String(at));
    return reply(200, { ok: true });
  } catch (err) {
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
