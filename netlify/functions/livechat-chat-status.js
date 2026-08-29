// Reuses the same LIVECHAT_PAT as livechat-group-name.js, but against
// LiveChat's Agent Chat API (get_chat) instead of the Configuration API —
// this is where per-chat data lives, not group data. Same Basic-auth
// pattern already confirmed working for Groups; get_chat sits in the same
// agent/action/* namespace as list_archives, which LiveChat's own docs
// confirm accepts PAT/Basic auth the same way.
//
// May need an additional PAT scope beyond groups--all:ro (something like
// chats--all:ro) — if this 401s where Brand detection succeeds, that's the
// first thing to check.
//
// Field paths (thread.active, customer.omnichannel) are best-effort from
// LiveChat's documented data structures, NOT yet verified against a real
// response — always returns the raw payload alongside the parsed result so
// app.js can log it to Diagnostics if detection looks wrong, the same
// iterate-from-real-data approach used to fix the Brand auth format.
const LIVECHAT_PAT = process.env.LIVECHAT_PAT;

exports.handler = async function (event) {
  try {
    if (!LIVECHAT_PAT) {
      // Distinct from a real API response with unrecognized fields — a
      // missing PAT should never look like "field paths need adjusting".
      return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, notConfigured: true }) };
    }
    const { chatId } = JSON.parse(event.body || "{}");
    if (!chatId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "chatId is required" }) };
    }

    const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + LIVECHAT_PAT },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const data = await res.json();
    if (data && data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    const thread = data.thread || {};
    const customer = (data.users || []).find((u) => u.type === "customer") || {};
    const omnichannel = customer.omnichannel || {};

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        isActive: typeof thread.active === "boolean" ? thread.active : null,
        isTelegram: Object.prototype.hasOwnProperty.call(omnichannel, "telegram"),
        raw: data, // small payload — kept so app.js can surface it for diagnosis if the above looks wrong
      }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, error: err.message }) };
  }
};
