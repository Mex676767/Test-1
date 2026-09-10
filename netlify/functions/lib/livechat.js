// Multiple LiveChat "PAT"s — one per LiveChat account/license this app
// needs to look chats up against. Added 2026-09-10: a second brand's chats
// route through an entirely separate LiveChat account, which needs its own
// PAT — a PAT only ever authenticates against the one account it was
// issued under, so with a single PAT configured, that account's chats and
// groups were never found no matter how many results got paged through
// (looked identical to "not found" — no auth error, since list_chats/
// list_groups just don't include another account's data at all). Add more
// here (LIVECHAT_PAT_3, ...) the same way if a third account ever shows up.
const LIVECHAT_PATS = [process.env.LIVECHAT_PAT, process.env.LIVECHAT_PAT_2].filter(Boolean);

module.exports = { LIVECHAT_PATS };
