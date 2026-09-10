// Resolves a LiveChat group ID (all the Agent App SDK gives us — see
// app.js's chatFromProfile) to its real name, e.g. "HOT321 Priority
// Support", via LiveChat's own Configuration API. Brand auto-detection
// then runs that name through the existing deriveBrandFromGroup() parser
// in app.js, same as the old demo data always did.
//
// Auth note: LIVECHAT_PAT must be the "Base64 Encoded Token" shown on the
// token-creation screen (base64(AccountID:Token)), NOT the raw "Token"
// value — LiveChat's console pre-computes it, ready to use as-is. Confirmed
// directly from that screen, not guessed from docs like the earlier attempt.
//
// Tries every configured LiveChat account's PAT in turn (see lib/
// livechat.js) — a groupID only ever exists under the one account it
// belongs to, so this account this app's SDK connection happens to be
// running under isn't necessarily the same one that issued the PAT it's
// checking against, if more than one account's chats reach this widget.
const { LIVECHAT_PATS } = require("./lib/livechat");

const groupsCacheByPat = new Map(); // pat -> { data, expiry }

async function fetchGroups(pat) {
  const now = Date.now();
  const cached = groupsCacheByPat.get(pat);
  if (cached && now < cached.expiry) return cached.data;

  const res = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || "Unexpected response from LiveChat list_groups";
    throw new Error(msg);
  }

  groupsCacheByPat.set(pat, { data, expiry: now + 10 * 60_000 });
  return data;
}

exports.handler = async function (event) {
  try {
    if (!LIVECHAT_PATS.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null }) };
    }
    const { groupID } = JSON.parse(event.body || "{}");
    if (!groupID) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "groupID is required" }) };
    }

    let lastErr = null;
    for (const pat of LIVECHAT_PATS) {
      try {
        const groups = await fetchGroups(pat);
        const match = groups.find((g) => String(g.id) === String(groupID));
        if (match) return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: match.name }) };
      } catch (err) {
        lastErr = err; // keep trying the remaining accounts — surfaced only if none of them find it
      }
    }
    // Not found under any configured account — surface the last real
    // request error (if any account's own call failed), rather than
    // reporting a plain "not found" for what might actually be an auth
    // problem on one of the accounts.
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: lastErr ? lastErr.message : undefined }) };
  } catch (err) {
    // Non-fatal by design (200, not 500) — Brand just stays a manual pick
    // if this fails, same as if no PAT were ever configured at all.
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: err.message }) };
  }
};
