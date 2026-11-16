const CONVERSATION_EVENTS = new Set(["message", "file", "rich_message"]);
const lower = (value) => String(value ?? "").trim().toLowerCase();

// Only customer-authored conversation events in this thread count as a reply.
// Agent/blast messages, internal notes, forms and system events do not count.
export function customerWroteIn(chat) {
  const customers = new Set((chat?.users || []).filter((user) => user.type === "customer").map((user) => lower(user.id)));
  return (chat?.thread?.events || []).some((event) => CONVERSATION_EVENTS.has(event.type) && event.visibility !== "agents" && customers.has(lower(event.author_id)));
}
