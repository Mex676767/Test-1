// Who does LiveChat say a login token belongs to? Shared by every endpoint that acts on behalf of a signed-in agent:
// the browser's own word about who it is is never used.
const clean = (value) => String(value ?? "").trim();

function clientIdFor(env, account) {
  return clean(account === "lc2" ? (env?.LIVECHAT_CLIENT_ID_2 || env?.LIVECHAT_CLIENT_ID2) : env?.LIVECHAT_CLIENT_ID);
}

// ok: login is LiveChat's account_id (the stable key); identities are every id LiveChat may stamp on this agent's
// messages (account_id, plus the email when LiveChat returns one).
// Not ok: loginExpired with a message the widget shows.
export async function identifyAgent(env, accountKey, agentToken) {
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
  const identities = [...new Set([login, clean(info.email)].filter(Boolean).map((id) => id.toLowerCase()))];
  return { ok: true, login, identities };
}
