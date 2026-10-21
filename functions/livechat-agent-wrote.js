import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";

const CONVERSATION_EVENTS = new Set(["message", "file", "rich_message"]);
const lower = (value) => String(value ?? "").trim().toLowerCase();

export function agentWroteIn(chat, identities) {
  const customers = new Set((chat?.users || []).filter((user) => user.type === "customer").map((user) => lower(user.id)));
  const me = new Set(identities.map(lower));
  const authors = new Set();
  let wrote = false;
  for (const event of chat?.thread?.events || []) {
    if (!CONVERSATION_EVENTS.has(event.type) || event.visibility === "agents") continue;
    const author = lower(event.author_id);
    if (!author || customers.has(author)) continue;
    authors.add(author);
    if (me.has(author)) wrote = true;
  }
  return { wrote, authors: [...authors] };
}

export function customerWroteIn(chat) {
  const customers = new Set((chat?.users || []).filter((user) => user.type === "customer").map((user) => lower(user.id)));
  return (chat?.thread?.events || []).some((event) => CONVERSATION_EVENTS.has(event.type) && event.visibility !== "agents" && customers.has(lower(event.author_id)));
}

export async function handler(event) {
  try {
    const { accountKey, agentToken, chatId, threadId } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !String(agentToken || "").trim() || !chatId || !threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "accountKey, agentToken, chatId and threadId are required." }) };
    }
    const who = await identifyAgent(event.env, accountKey, agentToken, { withEmail: true, pat: account.pat });
    if (!who.ok) return { statusCode: 200, body: JSON.stringify(who) };

    const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + account.pat },
      body: JSON.stringify({ chat_id: String(chatId), thread_id: String(threadId) }),
    });
    const chat = await res.json();
    if (chat?.error) throw new Error(chat.error.message || JSON.stringify(chat.error));
    const { wrote, authors } = agentWroteIn(chat, who.identities);
    if (!who.identities.some((id) => id.includes("@"))) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, wrote: null, authors, me: who.identities, error: `Could not read your LiveChat email (${who.emailLookup}).` }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, wrote, customerWrote: customerWroteIn(chat), authors, me: who.identities, ...(who.emailLookup ? { emailLookup: who.emailLookup } : {}) }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
