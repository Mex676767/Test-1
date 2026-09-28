// LiveChat API helpers -- see _lib/lark.js's header note on why this needs
// an initEnv() call at the start of every request rather than reading
// process.env at module top-level.
export let LIVECHAT_PATS = [];
export let LIVECHAT_ACCOUNTS = [];

export function initEnv(env) {
  // Keep a stable anonymous key even if only the second credential is set.
  // The key is safe to return to the browser; the PAT always stays here.
  LIVECHAT_ACCOUNTS = [
    { key: "lc1", pat: env.LIVECHAT_PAT },
    { key: "lc2", pat: env.LIVECHAT_PAT_2 },
  ].filter((account) => !!account.pat);
  LIVECHAT_PATS = LIVECHAT_ACCOUNTS.map((account) => account.pat);
}

export function accountKeyForPat(pat) {
  return LIVECHAT_ACCOUNTS.find((account) => account.pat === pat)?.key || "";
}
