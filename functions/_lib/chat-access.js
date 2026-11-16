import { LIVECHAT_ACCOUNTS } from "./livechat.js";
import { identifyAgent } from "./livechat-identity.js";
import { parseChatLink } from "./ca-row.js";

export function chatAccessFor(chat, identities) {
  const me = new Set(identities.map((id) => String(id).trim().toLowerCase()));
  const agent = (chat?.users || []).find((user) => user.type === "agent" && me.has(String(user.id || "").trim().toLowerCase()));
  // LiveChat agents visible only to other agents are supervising, not handling the customer.
  if (agent?.visibility === "agents") return { readOnly: true, reason: "Supervising this chat — lookup only. Nothing will be recorded." };
  if (agent?.visibility === "all" && (agent.present === true || chat?.thread?.active === false)) return { readOnly: false, reason: "" };
  return { readOnly: true, reason: "Viewing this chat — lookup only. Nothing will be recorded." };
}

export async function lookupChatAccess(env, access, link) {
  const unknown = { readOnly: true, reason: "Your role in this chat could not be confirmed. Results are read-only; look up again to retry." };
  const account = LIVECHAT_ACCOUNTS.find((item) => item.key === access?.accountKey);
  const { chatId, threadId } = parseChatLink(link);
  if (!account || !access?.agentToken || !chatId || !threadId) return unknown;
  let timer;
  const read = async () => {
    const who = await identifyAgent(env, access.accountKey, access.agentToken, { withEmail: true, pat: account.pat });
    if (!who.ok) return unknown;
    const response = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${account.pat}` },
      body: JSON.stringify({ chat_id: chatId, thread_id: threadId }), signal: AbortSignal.timeout(6000),
    });
    const chat = await response.json();
    if (!response.ok || chat?.error || !Array.isArray(chat?.users) || !chat?.thread || chat.thread.id !== threadId) return unknown;
    return chatAccessFor(chat, who.identities);
  };
  try {
    return await Promise.race([
      read().catch(() => unknown),
      new Promise((resolve) => { timer = setTimeout(() => resolve(unknown), 6000); }),
    ]);
  } finally { clearTimeout(timer); }
}
