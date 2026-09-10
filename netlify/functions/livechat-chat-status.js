// Reuses the same LiveChat PAT(s) as livechat-group-name.js, against
// LiveChat's Agent Chat API — this is where per-chat data lives, not group
// data.
//
// CONFIRMED (2026-08-29, from a real chat URL the agent shared: two separate
// "open chat" sessions for the same customer produced
// https://my.livechatinc.com/chats/TK2IWC00SW/TK2IWE9R94 and
// https://my.livechatinc.com/chats/TK2IWC00SW/TK2IWE9UNT — same first
// segment, different second segment):
//   - LiveChat's URL scheme is /chats/{chat_id}/{thread_id}.
//   - The Agent App SDK's `profile.chat.id` (what app.js has been sending
//     here as `chatId`) is actually the THREAD id, not the chat id — it's
//     the second, changing segment. A chat is the stable conversation; each
//     time it's reopened, a new thread starts within it.
//   - get_chat's `chat_id` parameter wants the first, stable segment, which
//     the SDK never exposes. Sending the thread id there always produced
//     "Chat not found" — not an auth/scope/region problem after all.
//
// Fix: resolve the real chat_id ourselves via list_chats (same PAT/scope,
// same agent/action/* namespace), matching on the thread id we do have.
// list_chats conveniently already includes each chat's last thread's
// active status and the customer's channel info, so once matched we don't
// need a second get_chat call at all.
//
// Tries every configured LiveChat account's PAT in turn (see lib/
// livechat.js) — a thread only ever exists under the one account it
// belongs to; with a second account's chats now reaching this widget too,
// checking only the first configured PAT would report every one of that
// second account's chats as "not found" (looked exactly like a busy-queue
// paging miss, not an auth/account mismatch — see the 2026-09-10 note
// there for how that actually got diagnosed).
const { LIVECHAT_PATS } = require("./lib/livechat");

async function listChatsFor(pat) {
  const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_chats", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({ limit: 100, sort_order: "desc" }), // no active filter — we want both open and just-closed chats
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}

exports.handler = async function (event) {
  let threadId;
  try {
    if (!LIVECHAT_PATS.length) {
      // Distinct from a real API response with unrecognized fields — a
      // missing PAT should never look like "field paths need adjusting".
      return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, notConfigured: true }) };
    }
    const body = JSON.parse(event.body || "{}");
    threadId = body.chatId; // wire name kept as chatId for app.js compat; it's actually the thread id — see header note
    if (!threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "chatId is required" }) };
    }

    let match = null;
    let lastData = null;
    let lastErr = null;
    let totalSearched = 0;
    for (const pat of LIVECHAT_PATS) {
      try {
        const data = await listChatsFor(pat);
        lastData = data;
        const chats = data.chats_summary || [];
        totalSearched += chats.length;
        match = chats.find((c) => c.last_thread_summary && String(c.last_thread_summary.id) === String(threadId));
        if (match) break;
      } catch (err) {
        lastErr = err; // keep trying the remaining accounts
      }
    }

    if (!match) {
      if (lastErr && !lastData) throw lastErr; // every account's own request failed outright — surface it, not a false "not found"
      // Not necessarily "closed" — could just be off the first 100 results
      // for a very busy agent (on whichever account it's actually under).
      // Surfaced distinctly so this doesn't get misread as a confirmed
      // close and trigger a false auto-record.
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          isActive: null,
          isTelegram: null,
          notFound: true,
          threadId,
          raw: { found_chats: lastData?.found_chats ?? null, searched: totalSearched, accountsChecked: LIVECHAT_PATS.length },
        }),
      };
    }

    const realChatId = match.id;
    const thread = match.last_thread_summary || {};
    const customer = (match.users || []).find((u) => u.type === "customer") || {};
    const chatUrl = `https://my.livechatinc.com/chats/${realChatId}/${threadId}`;

    // CORRECTED (2026-09-10) — a real Telegram chat's customer object here
    // has no "omnichannel" key at all (confirmed from a live chat: 03908b38-
    // ...customer object had no such field, so the old omnichannel.telegram
    // check always silently read false). What Telegram customers actually
    // carry is a "Telegram ID" entry inside session_fields (an array of
    // single-key objects, e.g. [{"First Name":"Mexha"}, {"Telegram ID":
    // "628101177"}, {"Bot ID":"8729168475"}, ...]) — match any key
    // containing "telegram" case-insensitively with a non-empty value, so a
    // rename on LiveChat's side (e.g. "Telegram Id") doesn't silently break
    // this again.
    const sessionFields = customer.session_fields || [];
    const isTelegram = sessionFields.some((f) =>
      Object.entries(f).some(([k, v]) => /telegram/i.test(k) && !!v)
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        isActive: typeof thread.active === "boolean" ? thread.active : null,
        isTelegram,
        chatId: realChatId,
        threadId,
        chatUrl,
        raw: { id: match.id, last_thread_summary: thread, users: match.users }, // small, targeted — kept for app.js to surface if detection still looks wrong
      }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, threadId, error: err.message }) };
  }
};
