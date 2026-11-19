import { LIVECHAT_ACCOUNTS } from "./livechat.js";
import { identifyAgent } from "./livechat-identity.js";
import { parseChatLink } from "./ca-row.js";
import { customerWroteIn } from "./chat-events.js";

export function chatAccessFor(chat, identities) {
  const me = new Set(identities.map((id) => String(id).trim().toLowerCase()));
  const agent = (chat?.users || []).find((user) => user.type === "agent" && me.has(String(user.id || "").trim().toLowerCase()));
  // LiveChat agents visible only to other agents are supervising, not handling the customer.
  if (agent?.visibility === "agents") return { readOnly: true, reason: "Supervising this chat — lookup only. Nothing will be recorded." };
  if (!customerWroteIn(chat)) return { readOnly: true, reason: "The customer has not replied in this chat — lookup only. Nothing will be recorded. Look up again after they reply." };
  if (agent?.visibility === "all" && (agent.present === true || chat?.thread?.active === false)) return { readOnly: false, reason: "" };
  return { readOnly: true, reason: "Viewing this chat — lookup only. Nothing will be recorded." };
}

export async function lookupChatAccess(env, access, link) {
  const blocked = (code, reason, loginRequired = false) => ({ readOnly: true, code, reason, loginRequired });
  const unknown = blocked("verification_unavailable", "LiveChat could not verify this chat just now. Results are read-only; look up again to retry.");
  const account = LIVECHAT_ACCOUNTS.find((item) => item.key === access?.accountKey);
  const { chatId, threadId } = parseChatLink(link);
  if (!access?.accountKey || !access?.agentToken) return blocked("login_required", "Reconnect LiveChat to verify your chat role, then look up again.", true);
  if (!account) return blocked("account_unavailable", "This LiveChat workspace is not configured for chat checks. Ask your admin to check its connection.");
  if (!chatId || !threadId) return blocked("chat_link_missing", "The chat link is not ready. Refresh this chat, then look up again.");
  const controller = new AbortController();
  const timeout = blocked("verification_timeout", "LiveChat took too long to verify this chat. Results are read-only; look up again to retry.");
  let timer;
  const read = async () => {
    // Start both reads together so identity/email lookup does not consume the chat-read budget.
    const identityP = identifyAgent(env, access.accountKey, access.agentToken, { withEmail: true, pat: account.pat, signal: controller.signal });
    const chatP = fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${account.pat}` },
        body: JSON.stringify({ chat_id: chatId, thread_id: threadId }), signal: controller.signal,
      }).then(async (response) => ({ response, chat: await response.json() })).catch(() => null);
    const who = await identityP;
    if (!who.ok) return who.loginExpired
      ? blocked("login_required", "Your LiveChat login has expired. Reconnect LiveChat, then look up again.", true)
      : unknown;
    const result = await chatP;
    if (!result) return unknown;
    const { response, chat } = result;
    if (response.status === 401 || response.status === 403) return blocked("chat_access_denied", "The LiveChat connection cannot read this chat. Ask your admin to check its chat permissions.");
    if (!response.ok || chat?.error || !Array.isArray(chat?.users) || !chat?.thread) return unknown;
    if (chat.thread.id !== threadId) return blocked("thread_mismatch", "LiveChat returned a different conversation. Refresh this chat, then look up again.");
    if (!Array.isArray(chat.thread.events)) return blocked("events_unavailable", "LiveChat did not provide this conversation's messages. Look up again to retry the chat check.");
    if (!who.identities.some((id) => id.includes("@")) && !chat.users.some((user) => user.type === "agent" && who.identities.includes(String(user.id || "").trim().toLowerCase()))) {
      return blocked("identity_unavailable", "LiveChat could not identify your agent account. Reconnect LiveChat, then look up again.", true);
    }
    return chatAccessFor(chat, who.identities);
  };
  try {
    return await Promise.race([
      read().catch(() => unknown),
      new Promise((resolve) => { timer = setTimeout(() => { resolve(timeout); controller.abort(); }, 12000); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
