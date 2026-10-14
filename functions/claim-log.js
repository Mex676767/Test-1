import { adapt } from "./_lib/adapt.js";

// Which bonus did the agent click Claim on? The saved case only keeps the inquiry tag and the amount, and the agent can edit both
// afterwards, so QA could not tell whether they match the bonus that was really claimed. The widget now tells this endpoint the moment
// a bonus is claimed (the bonus, the source table's value, and the inquiry and amount that bonus implies) and when the claim is undone;
// the QA tab reads them through /crosscheck (step "chatlog") and compares them with what was logged.
//
// Stored in the same Cloudflare KV namespace as the Unknown ticks (binding UNKNOWN_TICKS), the facts in the key's metadata:
//   claim:<thread id>:<agent>:<program>   (thread not known yet: claim:c-<chat id>:...)   expires after 120 days
//   meta:claims-since                     when the first claim arrived: chats older than that have no claims on record
// Without the binding the endpoint answers { ok: false, notConfigured: true } and the widget carries on.
// No authentication, like the other widget endpoints (see HANDOVER.md); the inputs are checked and capped.

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
      // An unclaim clears every bonus of this agent on this chat, whichever id the claim was stored under.
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
