// Cloudflare Pages Functions port of netlify/functions/lib/livechat.js --
// see _lib/lark.js's header note on process.env in this environment.
export const LIVECHAT_PATS = [process.env.LIVECHAT_PAT, process.env.LIVECHAT_PAT_2].filter(Boolean);
