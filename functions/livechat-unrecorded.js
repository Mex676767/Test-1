import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { searchRecords, updateRecord, toDisplay, TABLE_UNRECORDED } from "./_lib/lark.js";
import { UNREC } from "./_lib/unrecorded.js";

// The signed-in agent's own list from the one-time crosscheck (see crosscheck.js): chats since 7 Oct that they wrote in and
// nobody recorded. The agent is identified by LiveChat from their login, never by what the browser says, and only rows
// carrying THEIR email are ever read or changed.
//
//   list     -> { ok, chats: [{ threadId, chatId, date, customer }] }   (rows still "Open", oldest first)
//   resolve  -> marks one chat "Done" (recorded) or "Ignored" (the agent wrote it off)
const THREAD_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const clean = (value) => String(value ?? "").trim();
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

export async function handler(event) {
  try {
    const { accountKey, agentToken, action, threadId, status } = JSON.parse(event.body || "{}");
    const account = LIVECHAT_ACCOUNTS.find((item) => item.key === accountKey);
    if (!account || !clean(agentToken)) return reply(400, { ok: false, error: "LiveChat login is required." });
    if (!TABLE_UNRECORDED) return reply(200, { ok: true, chats: [], notConfigured: true });

    const who = await identifyAgent(event.env, accountKey, agentToken, { withEmail: true, pat: account.pat });
    if (!who.ok) return reply(200, who);
    const email = who.identities.find((id) => id.includes("@"));
    if (!email) return reply(200, { ok: false, error: `Could not read your LiveChat email (${who.emailLookup}).` });

    const mine = [{ field_name: UNREC.email, operator: "is", value: [email] }];
    if (action === "resolve") {
      const thread = clean(threadId);
      const next = status === "Ignored" ? "Ignored" : "Done";
      if (!THREAD_ID_RE.test(thread)) return reply(400, { ok: false, error: "A valid threadId is required." });
      const rows = await searchRecords(TABLE_UNRECORDED, [...mine, { field_name: UNREC.thread, operator: "is", value: [thread] }], undefined, { pageSize: 50 });
      for (const row of rows) await updateRecord(TABLE_UNRECORDED, row.record_id, { [UNREC.status]: next });
      return reply(200, { ok: true, updated: rows.length });
    }

    const rows = await searchRecords(TABLE_UNRECORDED, [...mine, { field_name: UNREC.status, operator: "is", value: ["Open"] }], undefined, { pageSize: 500 });
    const chats = rows
      .map((row) => ({
        threadId: clean(toDisplay(row.fields?.[UNREC.thread])),
        chatId: clean(toDisplay(row.fields?.[UNREC.chat])),
        date: Number(row.fields?.[UNREC.date]) || 0,
        customer: clean(toDisplay(row.fields?.[UNREC.customer])),
      }))
      .filter((chat) => THREAD_ID_RE.test(chat.threadId))
      .sort((a, b) => a.date - b.date);
    return reply(200, { ok: true, chats });
  } catch (err) {
    return reply(200, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
