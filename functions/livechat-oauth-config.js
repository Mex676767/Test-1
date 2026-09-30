import { adapt } from "./_lib/adapt.js";

export async function handler(event) {
  const redirectUri = String(
    event.env?.LIVECHAT_REDIRECT_URI || "https://test-1-7wpp.pages.dev/blast/oauth.html"
  ).trim();
  const clients = [
    { key: "lc1", label: "LiveChat Account 1", clientId: String(event.env?.LIVECHAT_CLIENT_ID || "").trim() },
    // Accept the unseparated name as a compatibility alias, but document the
    // same `_2` convention already used by LIVECHAT_PAT_2.
    { key: "lc2", label: "LiveChat Account 2", clientId: String(event.env?.LIVECHAT_CLIENT_ID_2 || event.env?.LIVECHAT_CLIENT_ID2 || "").trim() },
  ].filter((client) => client.clientId);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      configured: clients.length > 0,
      clients,
      redirectUri,
      // Kept for one-account deployments and older cached frontend code.
      clientId: clients[0]?.clientId || "",
    }),
    headers: { "Cache-Control": "no-store" },
  };
}

export const onRequest = adapt(handler);
