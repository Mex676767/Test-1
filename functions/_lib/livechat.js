export let LIVECHAT_PATS = [];
export let LIVECHAT_ACCOUNTS = [];

export function initEnv(env) {
  LIVECHAT_ACCOUNTS = [
    { key: "lc1", pat: env.LIVECHAT_PAT },
    { key: "lc2", pat: env.LIVECHAT_PAT_2 },
  ].filter((account) => !!account.pat);
  LIVECHAT_PATS = LIVECHAT_ACCOUNTS.map((account) => account.pat);
}

export function accountKeyForPat(pat) {
  return LIVECHAT_ACCOUNTS.find((account) => account.pat === pat)?.key || "";
}
