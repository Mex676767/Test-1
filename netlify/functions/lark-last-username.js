const { searchRecords, toDisplay, TABLE_PNL } = require("./lib/lark");

// Called once per chat, as soon as both Brand and the resolved (real, stable)
// chat_id are known -- NOT the thread_id, which is unique to every single
// chat session and would never match a past one. The stable chat_id is the
// SAME across every reopen of a given customer's conversation (confirmed via
// the livechat-chat-status.js investigation), so it's the only thing that
// can ever actually find a "this customer chatted before" match.
//
// Field name confirmed from a real screenshot: "Live Chat link" on the P&L
// table. It's a Lookup (pulling Customer Approaching's own "link" field via
// a Username+Brand+Telegram match), not a plain stored value -- there is no
// plain text/URL field to fall back to. Whether Lark's search API can even
// filter records by a Lookup field's resolved value is unverified; if this
// never finds a match even for an obvious repeat chat, `error` in the
// response (surfaced to Diagnostics by app.js) is the first thing to check
// -- it'll say directly if Lark rejected filtering on this field at all.
//
// (2026-09-10) "Live Chat link" only ever matches a non-Telegram record —
// a separate "Telegram" Lookup field was added on P&L, same shape (Username
// + Brand + Telegram=true match, latest Telegram record's link), for
// telegram-sourced repeat chats. Lark's search API only supports "and"
// across conditions (see searchRecords), so this can't be one query with an
// OR — check both fields in parallel and treat either match as found.
const F = { username: "Username", brand: "Brand", lastLink: "Live Chat link", lastTelegramLink: "Telegram" };

exports.handler = async function (event) {
  try {
    const { chatId, brand } = JSON.parse(event.body || "{}");
    if (!chatId || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "chatId and brand are required" }) };
    }
    if (!TABLE_PNL) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, found: false }) };
    }

    const [liveChatMatches, telegramMatches] = await Promise.all([
      searchRecords(TABLE_PNL, [
        { field_name: F.brand, operator: "is", value: [brand] },
        { field_name: F.lastLink, operator: "contains", value: [chatId] },
      ]),
      searchRecords(TABLE_PNL, [
        { field_name: F.brand, operator: "is", value: [brand] },
        { field_name: F.lastTelegramLink, operator: "contains", value: [chatId] },
      ]).catch(() => []), // non-fatal — e.g. if the Telegram field ever gets renamed, Live Chat link still works
    ]);
    const match = liveChatMatches[0] || telegramMatches[0];
    if (!match) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, found: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, found: true, username: toDisplay(match.fields[F.username]) }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, found: false, error: err.message }) };
  }
};
