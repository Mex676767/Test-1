import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";

// Did the signed-in agent write to the customer in this chat? Used to decide whether a chat that closed without a Look up
// is theirs to be reminded about (they talked to the customer) or not (they only watched it while supervising).
//
// Only messages count: a note or whisper to other agents (visibility "agents") is not talking to the customer, and the
// customer's own messages are never anyone's. System events are ignored.
const CONVERSATION_EVENTS = new Set(["message", "file", "rich_message"]);
const lower = (value) => String(value ?? "").trim().toLowerCase();

// chat: LiveChat's get_chat reply. identities: every id LiveChat may stamp on this agent's messages.
// authors lists who wrote (everyone except the customer) so a mismatch can be diagnosed from the widget's log.
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

export async function handler(event) {
  try {
    const { accountKey, agentToken, chatId, threadId } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !String(agentToken || "").trim() || !chatId || !threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "accountKey, agentToken, chatId and threadId are required." }) };
    }
    const who = await identifyAgent(event.env, accountKey, agentToken);
    if (!who.ok) return { statusCode: 200, body: JSON.stringify(who) };

    // get_chat with a thread id returns that thread's events (the chat itself may have later threads).
    const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + account.pat },
      body: JSON.stringify({ chat_id: String(chatId), thread_id: String(threadId) }),
    });
    const chat = await res.json();
    if (chat?.error) throw new Error(chat.error.message || JSON.stringify(chat.error));
    const { wrote, authors } = agentWroteIn(chat, who.identities);
    return { statusCode: 200, body: JSON.stringify({ ok: true, wrote, authors, me: who.identities }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
