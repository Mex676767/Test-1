// Sample chats for the admin preview of the QA tab: made-up data shaped like the server's chatlog answer, shown through the very same
// code as a real chat (describeChatLog and the card), so what the preview shows is what QA will see. Nothing here is real or saved.
export function buildExamples(now = Date.now()) {
  const HOUR = 3_600_000;
  const tracking = { configured: true, since: now - 48 * HOUR, claimsSince: now - 24 * HOUR };
  const row = (extra = {}) => ({
    recordId: "example", createdAt: now - 3 * HOUR, agent: "96 Alice", username: "player_demo01", brand: "VS96", inquiry: ["TOP P&L"], status: "Given", amount: 18,
    claimSecret: true, telegram: false, link: "https://my.livechatinc.com/archives/EXAMPLE", threadId: "EXAMPLE", ...extra,
  });
  const claim = (extra = {}) => ({ agent: "96 Alice", program: "topPnl", label: "Top 10 P&L", source: "Pass RM18", inquiry: "TOP P&L", amount: "18", at: now - 3 * HOUR, ...extra });
  return [
    { id: "logged", label: "Logged correctly", data: { rows: [row()], ticks: [], claims: [claim()], tracking } },
    { id: "mismatch", label: "Wrong inquiry and amount", data: { rows: [row({ inquiry: ["Others"], amount: 20 })], ticks: [], claims: [claim()], tracking } },
    { id: "missing", label: "Something missing", data: { rows: [row({ agent: "96 Bob", username: "", inquiry: [], status: "", amount: null, claimSecret: false })], ticks: [], claims: [], tracking } },
    { id: "ticked", label: "Ticked Unknown player", data: { rows: [], ticks: [{ threadId: "EXAMPLE", agent: "96 Carl", source: "manual", at: now - 2 * HOUR }], claims: [], tracking } },
    { id: "claimed", label: "Claimed, nothing logged", data: { rows: [], ticks: [], claims: [claim({ agent: "96 Cara", program: "redeemCode", label: "Redeem Code", source: "Active", inquiry: "Redeem Code", amount: "" })], tracking } },
    { id: "nothing", label: "Nothing logged", data: { rows: [], ticks: [], claims: [], tracking } },
  ];
}
