// Resolves a LiveChat group ID (all the Agent App SDK gives us — see
// app.js's chatFromProfile) to its real name, e.g. "HOT321 Priority
// Support", via LiveChat's own Configuration API. Brand auto-detection
// then runs that name through the existing deriveBrandFromGroup() parser
// in app.js, same as the old demo data always did.
//
// Auth note: LiveChat Personal Access Tokens use HTTP Basic auth, but NOT
// the standard "base64(user:pass)" shape — per LiveChat's own docs and
// examples, it's "Basic " + base64(token) alone. Untested against a real
// account as of writing; if this 401s, that's the first thing to check.
const LIVECHAT_PAT = process.env.LIVECHAT_PAT;

let groupsCache = null;
let groupsCacheExpiry = 0;

async function fetchGroups() {
  const now = Date.now();
  if (groupsCache && now < groupsCacheExpiry) return groupsCache;

  const token = Buffer.from(LIVECHAT_PAT).toString("base64");
  const res = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + token },
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
