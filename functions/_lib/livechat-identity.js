// Who does LiveChat say a login token belongs to? Shared by every endpoint that acts on behalf of a signed-in agent:
// the browser's own word about who it is is never used.
const clean = (value) => String(value ?? "").trim();

function clientIdFor(env, account) {
  return clean(account === "lc2" ? (env?.LIVECHAT_CLIENT_ID_2 || env?.LIVECHAT_CLIENT_ID2) : env?.LIVECHAT_CLIENT_ID);
}

// LiveChat's login id (account_id) is a UUID, but a chat stamps an agent's messages with their EMAIL, so recognizing "my
// messages" needs the email. Accounts API "get an account": first with the agent's own token (needs the OAuth app's scope
// accounts--my:ro), then with the account's Personal Access Token (needs accounts--all:ro). Remembered per login for an hour.
// Returns { email, via } or { email: "", via: "<why not>" }.
const emailCache = new Map(); // login -> { email, via, expires }
const EMAIL_TTL_MS = 60 * 60_000;
async function lookupEmail(login, agentToken, pat) {
  const cached = emailCache.get(login);
  if (cached && cached.expires > Date.now()) return { email: cached.email, via: cached.via };
  const reasons = [];
  const attempts = [
    ["own token", "https://accounts.livechat.com/v2/accounts/me", `Bearer ${agentToken}`],
    ...(pat ? [["PAT", `https://accounts.livechat.com/v2/accounts/${encodeURIComponent(login)}`, `Basic ${pat}`]] : []),
  ];
  for (const [via, url, authorization] of attempts) {
    try {
      const response = await fetch(url, { headers: { Authorization: authorization } });
      const data = await response.json().catch(() => ({}));
      const email = clean(data?.email);
      if (response.ok && email) {
        emailCache.set(login, { email, via, expires: Date.now() + EMAIL_TTL_MS });
        return { email, via };
      }
      reasons.push(`${via}: ${clean(data?.error?.message || data?.error || response.status)}`);
    } catch (error) {
      reasons.push(`${via}: ${clean(error?.message)}`);
    }
  }
  return { email: "", via: reasons.join("; ") };
}

// ok: login is LiveChat's account_id (the stable key); identities are every id LiveChat may stamp on this agent's
// messages (account_id, plus the email when LiveChat returns one -- with { withEmail: true, pat } it is looked up).
// emailLookup says how the email was found, or why not.
// Not ok: loginExpired with a message the widget shows.
export async function identifyAgent(env, accountKey, agentToken, { withEmail = false, pat = "" } = {}) {
  const response = await fetch("https://accounts.livechat.com/v2/info", { headers: { Authorization: `Bearer ${agentToken}` } });
  const info = await response.json().catch(() => ({}));
  if (!response.ok || info?.error || !info?.account_id) {
    return { ok: false, loginExpired: true, error: "LiveChat login expired or invalid — connect LiveChat again." };
  }
  // The token has to come from the OAuth client of the account the browser says it is, so a login on one account
  // cannot be presented as the other one.
  const expectedClient = clientIdFor(env, accountKey);
  if (expectedClient && info.client_id && clean(info.client_id) !== expectedClient) {
    return { ok: false, loginExpired: true, error: "This LiveChat login belongs to a different account — connect LiveChat again." };
  }
  const login = clean(info.account_id);
  let email = clean(info.email);
  let emailLookup = email ? "token info" : "";
  // A login id that already is an email needs no lookup.
  if (!email && withEmail && !login.includes("@")) ({ email, via: emailLookup } = await lookupEmail(login, agentToken, pat));
  const identities = [...new Set([login, email].filter(Boolean).map((id) => id.toLowerCase()))];
  return { ok: true, login, identities, emailLookup };
}
