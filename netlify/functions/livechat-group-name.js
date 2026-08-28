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
const LIVECHAT_PAT = process.env.LIVECHAT_PAT;

let groupsCache = null;
let groupsCacheExpiry = 0;

async function fetchGroups() {
  const now = Date.now();
  if (groupsCache && now < groupsCacheExpiry) return groupsCache;

  const res = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + LIVECHAT_PAT },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || "Unexpected response from LiveChat list_groups";
    throw new Error(msg);
  }

  groupsCache = data;
  groupsCacheExpiry = now + 10 * 60_000;
  return groupsCache;
}

exports.handler = async function (event) {
  try {
    if (!LIVECHAT_PAT) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null }) };
    }
    const { groupID } = JSON.parse(event.body || "{}");
    if (!groupID) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "groupID is required" }) };
    }

    const groups = await fetchGroups();
    const match = groups.find((g) => String(g.id) === String(groupID));
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: match ? match.name : null }) };
  } catch (err) {
    // Non-fatal by design (200, not 500) — Brand just stays a manual pick
    // if this fails, same as if the PAT were never configured at all.
    return { statusCode: 200, body: JSON.stringify({ ok: true, groupName: null, error: err.message }) };
  }
};
