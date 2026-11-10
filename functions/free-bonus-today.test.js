import test from "node:test";
import assert from "node:assert/strict";
import { claimsTodayFrom } from "./lark-search.js";

const MY = (iso) => Date.parse(iso + "+08:00");
const row = (id, created, fields) => ({ record_id: id, created_time: created, fields });

test("today's Given claims for this brand are listed; other days, brands and statuses are not", () => {
  const rows = [
    row("a", MY("2026-11-10T00:05:00"), { Brand: "EZ", Status: "Given", Inquiry: ["TOP P&L"] }),
    row("b", MY("2026-11-09T23:59:00"), { Brand: "EZ", Status: "Given", Inquiry: ["TOP LTV"] }),
    row("c", MY("2026-11-10T10:00:00"), { Brand: "PP", Status: "Given", Inquiry: ["Moon Bonus"] }),
    row("d", MY("2026-11-10T11:00:00"), { Brand: "EZ", Status: "Rejected", Inquiry: ["Moon Bonus"] }),
    row("e", MY("2026-11-10T12:00:00"), { Brand: "ez", Status: "given", Inquiry: "Telegram RM28" }),
    row("f", MY("2026-11-10T12:00:00"), { Brand: "EZ" }),
  ];
  assert.deepEqual(claimsTodayFrom(rows, "EZ", "2026-11-10"), [
    { recordId: "a", inquiry: ["TOP P&L"] },
    { recordId: "e", inquiry: ["Telegram RM28"] },
  ]);
});
