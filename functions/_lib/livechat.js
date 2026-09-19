// LiveChat API helpers -- see _lib/lark.js's header note on why this needs
// an initEnv() call at the start of every request rather than reading
// process.env at module top-level.
export let LIVECHAT_PATS = [];

export function initEnv(env) {
  LIVECHAT_PATS = [env.LIVECHAT_PAT, env.LIVECHAT_PAT_2].filter(Boolean);
}
