import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN, DAY1_TABLE, F, brandKey, checkFields, day1Bonus, dayNumber, halloweenStatus, malaysiaToday,
  normalizeTier, planClaim, planUnclaim, readTopups, shapeFields, testDateFor, topupLine,
} from "./_lib/halloween.js";
import { initEnv } from "./_lib/lark.js";
import { handler as claimHandler } from "./halloween-claim.js";
import { handler as searchHandler } from "./lark-search.js";

// ---- fixtures -------------------------------------------------------------------------------
const textField = (name) => ({ field_name: name, type: 1 });
const numberField = (name) => ({ field_name: name, type: 2 });
const dateField = (name) => ({ field_name: name, type: 5 });
const selectField = (name, options) => ({ field_name: name, type: 3, property: { options: options.map((option) => ({ id: `opt_${option}`, name: option })) } });

function goodCatalog() {
  return [
    textField(F.uid),
    selectField(F.brand, Object.keys(CAMPAIGN)),
    selectField(F.tier, ["Tier 3", "Tier V"]),
    selectField(F.choice, ["TRICK", "TREAT"]),
    numberField(F.day1Deposit), numberField(F.day1Bonus),
    selectField(F.track, ["Below RM300", "RM300+"]),
    dateField(F.day1Claimed), textField(F.day1Topups),
    numberField(F.day2Base), numberField(F.day2Share), dateField(F.day2Claimed),
    numberField(F.day3Base), numberField(F.day3Share), dateField(F.day3Claimed),
    selectField(F.shareMethod, ["Social post", "5 friends"]),
    textField(F.postLink), textField(F.agent), textField(F.chatLink),
  ];
}

const row = (fields, id = "rec1") => ({ record_id: id, created_time: 1, fields });
const day1Row = (extra = {}) => row({
  [F.uid]: "zzali", [F.brand]: "NOW", [F.tier]: "Tier V", [F.choice]: "TRICK",
  [F.day1Deposit]: 350, [F.day1Bonus]: 120, [F.track]: "RM300+", [F.day1Claimed]: 1, ...extra,
});
const lowRow = () => day1Row({ [F.choice]: "TREAT", [F.day1Deposit]: 200, [F.day1Bonus]: 30, [F.track]: "Below RM300" });

// ---- pure rules -----------------------------------------------------------------------------
test("19 Zyra brands, in 6 staggered groups, each stored without digits", () => {
  assert.equal(Object.keys(CAMPAIGN).length, 19);
  const starts = {};
  for (const [key, value] of Object.entries(CAMPAIGN)) {
    assert.equal(brandKey(value.full), key, `${value.full} should strip to ${key}`);
    (starts[value.start] ||= []).push(key);
  }
  assert.deepEqual(Object.keys(starts).sort(), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
  assert.deepEqual(starts["2026-10-26"], ["OG", "NOW", "JUS"]);
  assert.deepEqual(starts["2026-10-30"], ["EZ", "SK", "HOT"]);
  assert.deepEqual(starts["2026-10-31"], ["RM", "BM", "SA", "JK"]);
});

test("a brand's window is its send date plus two days, Malaysia time", () => {
  assert.equal(dayNumber("NOW", "2026-10-25"), 0);
  assert.equal(dayNumber("NOW", "2026-10-26"), 1);
  assert.equal(dayNumber("NOW", "2026-10-27"), 2);
  assert.equal(dayNumber("NOW", "2026-10-28"), 3);
  assert.equal(dayNumber("NOW", "2026-10-29"), 0);
  assert.equal(dayNumber("RM", "2026-11-02"), 3);
  assert.equal(dayNumber("RM", "2026-11-03"), 0);
  assert.equal(dayNumber("NOW32", "2026-10-26"), 1, "a full brand name still resolves");
  assert.equal(dayNumber("PP", "2026-10-27"), 0, "a brand outside the campaign never opens");
  assert.equal(dayNumber("OG", "2026-10-26"), 1, "OG321 is in Group 1");
  assert.equal(dayNumber("EZ", "2026-10-26"), 0, "EZ96 moved to Group 5");
  assert.equal(dayNumber("EZ96", "2026-10-30"), 1);
  assert.equal(dayNumber("EZ", "2026-11-01"), 3);
  assert.equal(dayNumber("EZ", "2026-11-02"), 0);
  assert.equal(malaysiaToday(Date.parse("2026-10-25T15:59:00Z")), "2026-10-25");
  assert.equal(malaysiaToday(Date.parse("2026-10-25T16:00:00Z")), "2026-10-26");
  assert.equal(malaysiaToday(Date.now(), "2026-10-27"), "2026-10-27");
});

test("only Tier 3 and Tier V are accepted", () => {
  for (const text of ["Tier 3", "tier 3", "Tier-3", "T3", "3"]) assert.equal(normalizeTier(text), "Tier 3", text);
  for (const text of ["Tier V", "tier v", "TV", "V"]) assert.equal(normalizeTier(text), "Tier V", text);
  for (const text of ["Tier 2", "Tier 4", "Tier 5", "", "Tier VI", undefined]) assert.equal(normalizeTier(text), "", String(text));
});

test("Day 1 bonus pays the highest table row reached, and the track follows the deposit", () => {
  assert.deepEqual(DAY1_TABLE.map((item) => [item.min, item.trick, item.treat]), [[500, 200, 150], [300, 120, 90], [100, 40, 30], [50, 18, 15]]);
  const cases = [
    [50, "TRICK", 18, "Below RM300"], [50, "TREAT", 15, "Below RM300"], [99, "TRICK", 18, "Below RM300"],
    [100, "TREAT", 30, "Below RM300"], [200, "TRICK", 40, "Below RM300"], [299, "TREAT", 30, "Below RM300"],
    [300, "TRICK", 120, "RM300+"], [450, "TREAT", 90, "RM300+"], [500, "TRICK", 200, "RM300+"], [900, "TREAT", 150, "RM300+"],
  ];
  for (const [deposit, choice, amount, track] of cases) {
    const bonus = day1Bonus(deposit, choice);
    assert.equal(bonus.amount, amount, `${choice} RM${deposit}`);
    assert.equal(bonus.track, track, `${choice} RM${deposit}`);
  }
  assert.equal(day1Bonus(49, "TRICK"), null);
  assert.equal(day1Bonus("", "TRICK"), null);
  assert.equal(day1Bonus(100, "MAYBE"), null);
  assert.equal(day1Bonus("1,000", "trick").amount, 200);
});

test("the card state follows the day, the track and what was claimed", () => {
  const status = (today, r, tierText = "Tier V", brand = "NOW") => halloweenStatus({ brand, tierText, row: r, today });
  assert.equal(status("2026-10-25", null), null, "before the send date nothing shows");
  assert.equal(status("2026-10-29", day1Row()), null, "after Day 3 nothing shows");
  assert.equal(halloweenStatus({ brand: "PP", tierText: "Tier V", row: null, today: "2026-10-26" }), null);
  assert.equal(status("2026-10-26", null).state, "day1");
  assert.equal(status("2026-10-26", day1Row()).state, "topup", "claimed earlier on Day 1: the card offers a top-up");
  assert.equal(status("2026-10-26", day1Row({ [F.day1Deposit]: 500, [F.day1Bonus]: 200 })).state, "done", "already at the top row: nothing more to top up");
  assert.equal(status("2026-10-26", null, "Tier 2").state, "closed");
  assert.match(status("2026-10-26", null, "Tier 2").message, /Tier 2/);
  assert.equal(status("2026-10-27", null).state, "closed");
  assert.equal(status("2026-10-27", lowRow()).state, "closed");
  assert.match(status("2026-10-27", lowRow()).message, /below RM300/);
  const day2 = status("2026-10-27", day1Row());
  assert.equal(day2.state, "day2");
  assert.equal(day2.redPacket, 28);
  assert.equal(status("2026-10-27", day1Row(), "Tier 3").redPacket, 28, "Day 2 pays the tier saved on Day 1 (Tier V), not today's");
  assert.equal(status("2026-10-27", day1Row({ [F.tier]: "Tier 3" }), "Tier V").redPacket, 18, "an upgrade after Day 1 does not raise the reward");
  assert.equal(status("2026-10-27", day1Row(), "Tier 2").state, "day2", "a drop to Tier 2 after Day 1 does not block Day 2");
  assert.equal(status("2026-10-27", day1Row(), "Tier 2").tier, "Tier V");
  assert.equal(status("2026-10-26", null, "Tier 2").state, "closed", "Day 1 still needs Tier 3 or Tier V on the day");
  assert.equal(status("2026-10-27", day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28 })).state, "done");
  assert.equal(status("2026-10-28", day1Row()).state, "closed", "Day 3 needs Day 2");
  const day3Shared = status("2026-10-28", day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28, [F.day2Share]: 28, [F.shareMethod]: "Social post" }));
  assert.equal(day3Shared.state, "day3");
  assert.equal(day3Shared.canShare, true);
  assert.equal(day3Shared.shareMethod, "Social post");
  const day3Plain = status("2026-10-28", day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28 }));
  assert.equal(day3Plain.canShare, false);
  assert.equal(status("2026-10-28", day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28, [F.day3Claimed]: 6, [F.day3Base]: 28 })).state, "done");
});

const claim = (over) => planClaim({ brand: "NOW", tierText: "Tier V", row: null, today: "2026-10-26", nowMs: 1000, agent: "Aina", chatLink: "https://chat/1", ...over });

test("Day 1 claim: choice and deposit decide the amount, the browser's amount is never used", () => {
  const plan = claim({ input: { day: 1, choice: "TRICK", deposit: "350", amount: 99999 } });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, "create");
  assert.equal(plan.amount, 120);
  assert.deepEqual(plan.fields, {
    [F.tier]: "Tier V", [F.choice]: "TRICK", [F.day1Deposit]: 350, [F.day1Bonus]: 120, [F.track]: "RM300+",
    [F.day1Claimed]: 1000, [F.agent]: "Aina", [F.chatLink]: "https://chat/1",
  });
  assert.equal(claim({ input: { day: 1, choice: "TREAT", deposit: 200 } }).fields[F.track], "Below RM300");
  assert.equal(claim({ input: { day: 1, choice: "TREAT", deposit: 49 } }).ok, false);
  assert.equal(claim({ input: { day: 1, deposit: 300 } }).ok, false, "a choice is required");
  assert.equal(claim({ row: day1Row(), input: { day: 1, choice: "TREAT", deposit: 300 } }).ok, false, "TRICK or TREAT only once");
});

test("claims are refused outside the rules: wrong tier, TC brand, closed window, wrong day", () => {
  const input = { day: 1, choice: "TRICK", deposit: 300 };
  assert.match(claim({ tierText: "Tier 2", input }).error, /Tier 3 and Tier V/);
  assert.match(claim({ brand: "PP", input }).error, /not part of the Halloween promotion/);
  assert.match(claim({ today: "2026-10-25", input }).error, /not open/);
  assert.match(claim({ today: "2026-10-29", input }).error, /not open/);
  assert.match(claim({ today: "2026-10-27", input }).error, /Day 2 now, not Day 1/);
});

test("Day 2: below RM300 gets nothing; RM300+ gets the red packet, plus RM28 only when shared", () => {
  const day2 = (over) => claim({ today: "2026-10-27", row: day1Row(), ...over });
  assert.match(day2({ row: lowRow(), input: { day: 2 } }).error, /below RM300/);
  assert.match(day2({ row: null, input: { day: 2 } }).error, /Day 1 was not claimed/);

  const plain = day2({ input: { day: 2, shared: false } });
  assert.equal(plain.amount, 28);
  assert.deepEqual(plain.fields, { [F.day2Base]: 28, [F.day2Claimed]: 1000, [F.agent]: "Aina", [F.chatLink]: "https://chat/1" });
  assert.equal(day2({ row: day1Row({ [F.tier]: "Tier 3" }), tierText: "Tier V", input: { day: 2 } }).amount, 18, "the Day 1 tier pays");
  assert.equal(day2({ tierText: "Tier 2", input: { day: 2 } }).amount, 28, "a drop to Tier 2 after Day 1 neither blocks nor changes Day 2");
  assert.equal(day2({ row: day1Row({ [F.tier]: "" }), tierText: "Tier 3", input: { day: 2 } }).amount, 18, "today's tier only if the saved one is missing");

  const shared = day2({ input: { day: 2, shared: true, shareMethod: "Social post", postLink: "https://fb.com/p/1" } });
  assert.equal(shared.amount, 56);
  assert.equal(shared.fields[F.day2Share], 28);
  assert.equal(shared.fields[F.shareMethod], "Social post");
  assert.equal(shared.fields[F.postLink], "https://fb.com/p/1");
  assert.equal(day2({ row: day1Row({ [F.tier]: "Tier 3" }), input: { day: 2, shared: true, shareMethod: "5 friends" } }).amount, 46);
  assert.equal(day2({ input: { day: 2, shared: true, shareMethod: "5 friends" } }).fields[F.postLink], undefined);

  assert.match(day2({ input: { day: 2, shared: true } }).error, /how the player shared/);
  assert.match(day2({ input: { day: 2, shared: true, shareMethod: "Social post" } }).error, /link/);
  assert.match(day2({ row: day1Row({ [F.day2Claimed]: 5 }), input: { day: 2 } }).error, /already claimed/);
});

test("Day 3 needs Day 2; the share extra needs a Day 2 share; sharing uses the Day 2 method", () => {
  const day3 = (rowFields, input) => claim({ today: "2026-10-28", row: day1Row(rowFields), input: { day: 3, ...input } });
  assert.match(day3({}, {}).error, /Day 2 was not claimed/);
  const afterPlainDay2 = { [F.day2Claimed]: 5, [F.day2Base]: 28 };
  assert.equal(day3(afterPlainDay2, {}).amount, 28);
  assert.match(day3(afterPlainDay2, { shared: true }).error, /did not share on Day 2/);
  const afterSharedDay2 = { ...afterPlainDay2, [F.day2Share]: 28, [F.shareMethod]: "5 friends" };
  const shared = day3(afterSharedDay2, { shared: true });
  assert.equal(shared.amount, 56);
  assert.equal(shared.fields[F.day3Share], 28);
  assert.equal(shared.fields[F.shareMethod], undefined, "Day 3 never changes the Day 2 method");
  assert.match(day3({ ...afterPlainDay2, [F.day3Claimed]: 6 }, {}).error, /already claimed/);
  assert.equal(claim({ today: "2026-10-28", row: lowRow(), input: { day: 3 } }).ok, false);
});

test("unclaim: Day 3 and Day 2 clear their own columns, Day 1 removes the row, a retry is harmless", () => {
  const withDay2 = day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28 });
  const withDay3 = day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28, [F.day3Claimed]: 6, [F.day3Base]: 28 });
  assert.equal(planUnclaim({ day: 1, row: day1Row() }).kind, "delete");
  assert.match(planUnclaim({ day: 1, row: withDay2 }).error, /Undo Day 2 first/);
  assert.deepEqual(planUnclaim({ day: 2, row: withDay2 }).clear, [F.day2Base, F.day2Share, F.day2Claimed, F.shareMethod, F.postLink]);
  assert.match(planUnclaim({ day: 2, row: withDay3 }).error, /Undo Day 3 first/);
  assert.deepEqual(planUnclaim({ day: 3, row: withDay3 }).clear, [F.day3Base, F.day3Share, F.day3Claimed]);
  assert.equal(planUnclaim({ day: 3, row: withDay2 }).kind, "none");
  assert.equal(planUnclaim({ day: 1, row: null }).kind, "none");
});

test("the table check reports missing fields, wrong types and missing options", () => {
  assert.equal(checkFields(goodCatalog()).ok, true);
  const broken = goodCatalog().filter((field) => field.field_name !== F.day3Share);
  broken.find((field) => field.field_name === F.day1Deposit).type = 1;
  broken.find((field) => field.field_name === F.track).property.options.pop();
  broken.find((field) => field.field_name === F.brand).property.options.splice(0, 2);
  const report = checkFields(broken);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [F.day3Share]);
  assert.deepEqual(report.wrongType.map((item) => item.field), [F.day1Deposit]);
  assert.deepEqual(report.missingOptions.filter((item) => item.field === F.track).map((item) => item.option), ["RM300+"]);
  assert.deepEqual(report.missingOptions.filter((item) => item.field === F.brand).map((item) => item.option), ["OG", "NOW"]);
});

test("values are shaped for each Lark field type, and an unknown field is an error", () => {
  const catalog = goodCatalog();
  catalog.find((field) => field.field_name === F.chatLink).type = 15;
  const shaped = shapeFields({ [F.chatLink]: "https://chat/1", [F.day1Bonus]: "120", [F.day1Claimed]: 5, [F.agent]: "Aina", [F.postLink]: "" }, catalog);
  assert.deepEqual(shaped, { [F.chatLink]: { link: "https://chat/1", text: "https://chat/1" }, [F.day1Bonus]: 120, [F.day1Claimed]: 5, [F.agent]: "Aina" });
  assert.throws(() => shapeFields({ Nope: "x" }, catalog), /no field called "Nope"/);
});

// ---- endpoint, against a fake Lark ------------------------------------------------------------
let tableCounter = 0;

function startFakeLark({ catalog = goodCatalog(), tier = "Tier V", rows = [], lagMs = 0, latencyMs = 0 } = {}) {
  const hw = `hw-table-${++tableCounter}`;
  const pnl = `pnl-table-${tableCounter}`;
  initEnv({
    LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base",
    LARK_TABLE_HALLOWEEN: hw, LARK_TABLE_PNL: pnl,
    LARK_TABLE_CUSTOMER_APPROACHING: `ca-${tableCounter}`,
  });
  const store = { rows: rows.map((item) => structuredClone(item)), writes: [], nextId: 100 };
  const original = globalThis.fetch;
  const ok = (data) => ({ json: async () => ({ code: 0, data }) });
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "token", expire: 3600 }) };
    const method = options.method || "GET";
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, Math.random() * latencyMs));
    if (href.includes(`/tables/${hw}/fields`)) return ok({ items: catalog });
    if (href.includes(`/tables/${pnl}/fields`)) return ok({ items: [{ field_name: "Tier", type: 3, property: { options: [] } }] });
    if (href.includes(`/tables/${pnl}/records/search`)) {
      return ok({ items: tier === null ? [] : [{ record_id: "p1", fields: { Username: "zzali", Brand: "NOW", Tier: tier } }], has_more: false });
    }
    if (href.includes(`/tables/${hw}/records/search`)) {
      const conditions = JSON.parse(options.body).filter.conditions;
      const items = store.rows.filter((item) => (item.visibleAt || 0) <= Date.now() && conditions.every((c) => String(item.fields[c.field_name]).toLowerCase() === String(c.value[0]).toLowerCase()));
      return ok({ items, has_more: false });
    }
    if (href.includes(`/tables/${hw}/records`) && method === "POST") {
      const record = { record_id: `rec${store.nextId++}`, created_time: store.nextId, visibleAt: Date.now() + lagMs, fields: JSON.parse(options.body).fields };
      store.rows.push(record);
      store.writes.push(["create", record.record_id, record.fields]);
      return ok({ record });
    }
    const recordMatch = href.match(new RegExp(`/tables/${hw}/records/([^/?]+)`));
    if (recordMatch && method === "PUT") {
      const target = store.rows.find((item) => item.record_id === recordMatch[1]);
      if (!target) return { json: async () => ({ code: 1254043, msg: "RecordIdNotFound" }) };
      const fields = JSON.parse(options.body).fields;
      for (const [name, value] of Object.entries(fields)) { if (value === null) delete target.fields[name]; else target.fields[name] = value; }
      store.writes.push(["update", target.record_id, fields]);
      return ok({ record: target });
    }
    if (recordMatch && method === "DELETE") {
      store.rows = store.rows.filter((item) => item.record_id !== recordMatch[1]);
      store.writes.push(["delete", recordMatch[1]]);
      return ok({ deleted: true });
    }
    return ok({ items: [], has_more: false });
  };
  return { hw, store, stop: () => { globalThis.fetch = original; } };
}

const call = async (body, date, extraEnv = {}) => {
  const result = await claimHandler({ httpMethod: "POST", body: JSON.stringify({ username: "ZZAli", brand: "NOW", agentName: "Aina", chatLink: "https://chat/1", ...body }), env: { HALLOWEEN_TEST_DATE: date, HALLOWEEN_SETTLE_MS: "0,0", ...extraEnv } });
  return JSON.parse(result.body);
};

test("GET reports whether the Lark table matches what the code writes", async (t) => {
  const broken = goodCatalog().filter((field) => field.field_name !== F.postLink);
  const lark = startFakeLark({ catalog: broken });
  t.after(lark.stop);
  const result = JSON.parse((await claimHandler({ httpMethod: "GET", env: {} })).body);
  assert.equal(result.ok, true);
  assert.equal(result.matches, false);
  assert.deepEqual(result.missing, [F.postLink]);
  const refused = await call({ action: "claim", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-26");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not set up correctly/);
  assert.deepEqual(lark.store.writes, [], "nothing is written into a table that does not match");
});

test("a three-day run writes one Halloween row and fills it a day at a time", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);

  const day1 = await call({ action: "claim", day: 1, choice: "TRICK", deposit: "350" }, "2026-10-26");
  assert.equal(day1.ok, true, JSON.stringify(day1));
  assert.equal(day1.amount, 120);
  assert.equal(day1.deposit, 350, "the server returns the deposit it used, for the Action log note");
  assert.equal(day1.track, "RM300+");
  assert.equal(lark.store.rows.length, 1);
  const saved = lark.store.rows[0].fields;
  assert.equal(saved[F.uid], "zzali", "the username is stored lower-case, like the other tables");
  assert.equal(saved[F.brand], "NOW");
  assert.equal(saved[F.tier], "Tier V");
  assert.equal(saved[F.track], "RM300+");
  assert.equal(saved[F.day1Bonus], 120);
  assert.equal(saved[F.agent], "Aina");
  assert.equal(typeof saved[F.day1Claimed], "number");

  assert.equal((await call({ action: "claim", day: 1, choice: "TREAT", deposit: 349 }, "2026-10-26")).ok, false, "a second Day 1 claim is a top-up, and needs more than the total already counted");
  assert.equal(lark.store.rows.length, 1);

  const day2 = await call({ action: "claim", day: 2, shared: true, shareMethod: "Social post", postLink: "https://fb.com/p/1" }, "2026-10-27");
  assert.equal(day2.ok, true, JSON.stringify(day2));
  assert.equal(day2.amount, 56);
  assert.equal(lark.store.rows.length, 1, "Day 2 updates the same row");
  assert.equal(lark.store.rows[0].fields[F.day2Share], 28);
  assert.equal(lark.store.rows[0].fields[F.postLink], "https://fb.com/p/1");
  assert.equal((await call({ action: "claim", day: 2 }, "2026-10-27")).ok, false, "one claim per day");

  const day3 = await call({ action: "claim", day: 3, shared: true }, "2026-10-28");
  assert.equal(day3.ok, true, JSON.stringify(day3));
  assert.equal(day3.amount, 56);
  assert.equal(lark.store.rows[0].fields[F.day3Share], 28);
  assert.equal((await call({ action: "claim", day: 3 }, "2026-10-28")).ok, false);
});

test("Day 2 and Day 3 pay the tier saved on Day 1, even if the P&L table now says another tier", async (t) => {
  const lark = startFakeLark({ tier: "Tier 2", rows: [day1Row({ [F.tier]: "Tier 3" })] });
  t.after(lark.stop);
  const day2 = await call({ action: "claim", day: 2 }, "2026-10-27");
  assert.equal(day2.ok, true, JSON.stringify(day2));
  assert.equal(day2.amount, 18);
  assert.equal(lark.store.rows[0].fields[F.day2Base], 18);
  const day3 = await call({ action: "claim", day: 3, shared: false }, "2026-10-28");
  assert.equal(day3.ok, true, JSON.stringify(day3));
  assert.equal(day3.amount, 18);
});

test("a RM200 player gets the RM100 row on Day 1 and nothing on Day 2 or Day 3", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const day1 = await call({ action: "claim", day: 1, choice: "TRICK", deposit: 200 }, "2026-10-26");
  assert.equal(day1.amount, 40);
  assert.equal(lark.store.rows[0].fields[F.track], "Below RM300");
  const before = structuredClone(lark.store.rows);
  assert.equal((await call({ action: "claim", day: 2 }, "2026-10-27")).ok, false);
  assert.equal((await call({ action: "claim", day: 3 }, "2026-10-28")).ok, false);
  assert.deepEqual(lark.store.rows, before);
});

test("Tier 2, TC brands, missing tier and closed windows write nothing", async (t) => {
  const lark = startFakeLark({ tier: "Tier 2" });
  t.after(lark.stop);
  assert.match((await call({ action: "claim", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-26")).error, /Tier 3 and Tier V/);
  lark.stop();

  const noTier = startFakeLark({ tier: null });
  t.after(noTier.stop);
  assert.equal((await call({ action: "claim", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-26")).ok, false);
  assert.deepEqual(noTier.store.writes, []);
  noTier.stop();

  const normal = startFakeLark();
  t.after(normal.stop);
  assert.match((await call({ action: "claim", brand: "PP", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-26")).error, /not part of the Halloween/);
  assert.match((await call({ action: "claim", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-25")).error, /not open/);
  assert.match((await call({ action: "claim", day: 1, choice: "TRICK", deposit: 300 }, "2026-10-29")).error, /not open/);
  assert.deepEqual(normal.store.writes, []);
});

test("a preview claim checks everything and writes nothing", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const result = await call({ action: "claim", preview: true, day: 1, choice: "TREAT", deposit: 300 }, "2026-10-26");
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.amount, 90);
  assert.deepEqual(lark.store.writes, []);
  const refused = await call({ action: "claim", preview: true, day: 1, choice: "TREAT", deposit: 10 }, "2026-10-26");
  assert.equal(refused.ok, false);
});

test("unclaim reverts only that day, and refuses to leave a later day orphaned", async (t) => {
  const lark = startFakeLark({ rows: [day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28, [F.day2Share]: 28, [F.shareMethod]: "5 friends", [F.day3Claimed]: 6, [F.day3Base]: 28 })] });
  t.after(lark.stop);
  const refused = await call({ action: "unclaim", day: 2 }, "2026-10-28");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Undo Day 3 first/);

  assert.equal((await call({ action: "unclaim", day: 3 }, "2026-10-28")).ok, true);
  assert.equal(lark.store.rows[0].fields[F.day3Claimed], undefined);
  assert.equal(lark.store.rows[0].fields[F.day2Claimed], 5, "Day 2 stays");
  const again = await call({ action: "unclaim", day: 3 }, "2026-10-28");
  assert.equal(again.ok, true);
  assert.equal(again.alreadyUndone, true);

  assert.equal((await call({ action: "unclaim", day: 2 }, "2026-10-28")).ok, true);
  assert.equal(lark.store.rows[0].fields[F.day2Share], undefined);
  assert.equal(lark.store.rows[0].fields[F.shareMethod], undefined);
  assert.equal((await call({ action: "unclaim", day: 1 }, "2026-10-28")).ok, true);
  assert.equal(lark.store.rows.length, 0);
});

test("two agents claim Day 1 at the same moment: one wins and no duplicate row is left, even when Lark's search lags", async (t) => {
  const lark = startFakeLark({ lagMs: 60 });
  t.after(lark.stop);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(
    { action: "claim", day: 1, choice: "TRICK", deposit: 350, agentName: `Agent${i}`, chatLink: `https://chat/${i}` },
    "2026-10-26", { HALLOWEEN_SETTLE_MS: "100,100" },
  )));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.error || "ok")));
  assert.equal(lark.store.rows.length, 1, "the losers removed their own rows");
  assert.match(results.find((r) => !r.ok).error, /claimed a moment ago by someone else/);
});

test("two agents claim Day 2 at the same moment: only one is accepted and the row names that agent", async (t) => {
  const lark = startFakeLark({ rows: [day1Row()] });
  t.after(lark.stop);
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => ({
    i,
    answer: await call({ action: "claim", day: 2, agentName: `Agent${i}`, chatLink: `https://chat/${i}` }, "2026-10-27", { HALLOWEEN_SETTLE_MS: "40,40" }),
  })));
  const accepted = results.filter((r) => r.answer.ok);
  assert.equal(accepted.length, 1, JSON.stringify(results.map((r) => r.answer.error || "ok")));
  assert.equal(lark.store.rows.length, 1);
  assert.equal(lark.store.rows[0].fields[F.agent], `Agent${accepted[0].i}`);
  assert.equal(lark.store.rows[0].fields[F.day2Base], 28);
});

test("a single agent's claim is never refused by the settle check", async (t) => {
  const lark = startFakeLark({ rows: [day1Row()] });
  t.after(lark.stop);
  const answer = await call({ action: "claim", day: 2, agentName: "Solo", chatLink: "https://chat/solo" }, "2026-10-27", { HALLOWEEN_SETTLE_MS: "30,30" });
  assert.equal(answer.ok, true, JSON.stringify(answer));
});

test("bad input is refused cleanly: nothing crashes and nothing is written", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const refused = async (label, body, date = "2026-10-26") => {
    const answer = await call({ action: "claim", day: 1, choice: "TRICK", deposit: 350, ...body }, date);
    assert.equal(answer.ok, false, `${label} must be refused: ${JSON.stringify(answer)}`);
  };
  for (const deposit of [null, -5, 0, 49, "abc", "", true, [], {}, "0x10", 1e21, 999_999_999, "1e309"]) await refused(`deposit ${JSON.stringify(deposit)}`, { deposit });
  for (const choice of ["", "MAYBE", 1, null, ["TRICK"], {}]) await refused(`choice ${JSON.stringify(choice)}`, { choice });
  for (const username of ["", "   ", {}, null, ["a"], true]) await refused(`username ${JSON.stringify(username)}`, { username });
  for (const brand of ["", "PP", "EZEZ", {}, null, 123]) await refused(`brand ${JSON.stringify(brand)}`, { brand });
  for (const day of [0, 2, 3, 4, -1, 1.5, "x", {}]) await refused(`day ${JSON.stringify(day)}`, { day });

  for (const [label, raw] of [["not json", "{oops"], ["json null", "null"], ["json array", "[]"], ["json string", "\"x\""], ["number", "5"]]) {
    const result = await claimHandler({ httpMethod: "POST", body: raw, env: { HALLOWEEN_TEST_DATE: "2026-10-26" } });
    assert.equal(result.statusCode, 400, `${label} is a 400, not a crash`);
  }
  assert.deepEqual(lark.store.writes, []);
  assert.equal(({}).polluted, undefined);
});

test("a deposit typed with spaces, commas or in capitals is still understood", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const answer = await call({ action: "claim", preview: true, day: 1, choice: " trick ", deposit: " 1,000 " }, "2026-10-26");
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.amount, 200);
  assert.equal((await call({ action: "claim", preview: true, day: null, choice: "TREAT", deposit: 300 }, "2026-10-26")).ok, true, "a null day means the browser did not say which day");
});

test("a social post link must be a plain web address", async (t) => {
  const lark = startFakeLark({ rows: [day1Row()] });
  t.after(lark.stop);
  const withLink = (postLink) => call({ action: "claim", preview: true, day: 2, shared: true, shareMethod: "Social post", postLink }, "2026-10-27");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "<img src=x onerror=alert(1)>", "has a space", "https://x.test/\"onmouseover=\"x", "vbscript:x"]) {
    assert.equal((await withLink(bad)).ok, false, `${bad} must be refused`);
  }
  for (const good of ["https://facebook.com/p/1", "http://x.test/a?b=1&c=2", "facebook.com/p/1", "HTTPS://X.TEST/P"]) {
    assert.equal((await withLink(good)).ok, true, `${good} must be accepted`);
  }
});

test("an undo landing at the same moment as the next day's claim never leaves a later day on top of an undone one", async () => {
  const env = { HALLOWEEN_SETTLE_MS: "40,40" };
  for (let run = 0; run < 10; run++) {
    const lark = startFakeLark({ latencyMs: 15, rows: [day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28 })] });
    try {
      const [, day3] = await Promise.all([
        call({ action: "unclaim", day: 2 }, "2026-10-28", env),
        call({ action: "claim", day: 3, agentName: "B", chatLink: "https://chat/b" }, "2026-10-28", env),
      ]);
      const fields = lark.store.rows[0].fields;
      assert.ok(!(fields[F.day3Claimed] && !fields[F.day2Claimed]), `run ${run}: Day 3 left without Day 2`);
      if (!fields[F.day2Claimed]) assert.equal(day3.ok, false, `run ${run}: Day 3 must be refused once Day 2 is undone`);
    } finally { lark.stop(); }
  }
  for (let run = 0; run < 10; run++) {
    const lark = startFakeLark({ latencyMs: 15, rows: [day1Row()] });
    try {
      const [, day2] = await Promise.all([
        call({ action: "unclaim", day: 1 }, "2026-10-27", env),
        call({ action: "claim", day: 2, agentName: "B", chatLink: "https://chat/b" }, "2026-10-27", env),
      ]);
      if (!lark.store.rows.length) assert.equal(day2.ok, false, `run ${run}: Day 2 accepted although the row is gone`);
      if (!day2.ok) assert.doesNotMatch(String(day2.error), /RecordIdNotFound|Lark update failed/, `run ${run}: a raw Lark error reached the agent`);
    } finally { lark.stop(); }
  }
});

test("any spelling of the brand is stored and searched as the dropdown's form, so a player can never get two Day 1 rows", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  assert.equal((await call({ action: "claim", day: 1, brand: "now", choice: "TRICK", deposit: 350 }, "2026-10-26")).ok, true);
  assert.equal(lark.store.rows[0].fields[F.brand], "NOW");
  for (const brand of ["NOW", "NOW32", " now32 ", "Now"]) {
    assert.match((await call({ action: "claim", day: 1, brand, choice: "TREAT", deposit: 300 }, "2026-10-26")).error, /more than the RM350 already counted/, `${brand} must find the same row`);
  }
  assert.equal(lark.store.rows.length, 1);
});

test("the production site ignores HALLOWEEN_TEST_DATE even if it is set there by mistake", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const body = JSON.stringify({ action: "claim", preview: true, day: 1, username: "zzali", brand: "NOW", choice: "TRICK", deposit: 350 });
  const ask = async (env, host) => {
    const answer = JSON.parse((await claimHandler({ httpMethod: "POST", body, env: { HALLOWEEN_SETTLE_MS: "0,0", ...env }, headers: { host } })).body);
    return { ok: answer.ok, error: answer.error };
  };
  assert.deepEqual(
    await ask({ HALLOWEEN_TEST_DATE: "2026-10-26" }, "test-1-7wp.pages.dev"),
    await ask({}, "test-1-7wp.pages.dev"),
    "on production the test date changes nothing",
  );
  assert.deepEqual(await ask({ HALLOWEEN_TEST_DATE: "2026-10-26" }, "feat-halloween-trick-or-trea.test-1-7wp.pages.dev"), { ok: true, error: undefined });
  assert.equal(testDateFor({ HALLOWEEN_TEST_DATE: "2026-10-26" }, { host: "TEST-1-7WP.pages.dev:443" }), "");
  assert.equal(testDateFor({ HALLOWEEN_TEST_DATE: "2026-10-26" }, { host: "31018ce8.test-1-7wp.pages.dev" }), "2026-10-26");
});

test("only the agent who claimed a day, from the same chat, can undo it", async (t) => {
  const lark = startFakeLark({ rows: [day1Row()] });
  t.after(lark.stop);
  const asA = { agentName: "Aina", chatLink: "https://chat/a" };
  const asB = { agentName: "Bala", chatLink: "https://chat/b" };
  assert.equal((await call({ action: "claim", day: 2, ...asA }, "2026-10-27")).ok, true);

  const stranger = await call({ action: "unclaim", day: 2, ...asB }, "2026-10-27");
  assert.equal(stranger.ok, false);
  assert.equal(stranger.notOwner, true);
  assert.match(stranger.error, /Only Aina, in the chat where it was claimed, can undo Day 2/);
  assert.equal((await call({ action: "unclaim", day: 2, agentName: "Aina", chatLink: "https://chat/other" }, "2026-10-27")).ok, false, "same agent, wrong chat");
  assert.equal(lark.store.rows[0].fields[F.day2Base], 28, "Day 2 is still claimed");

  assert.equal((await call({ action: "unclaim", day: 2, ...asA }, "2026-10-27")).ok, true);
  assert.equal(lark.store.rows[0].fields[F.day2Claimed], undefined);
  assert.equal(lark.store.rows[0].fields[F.agent], undefined, "the claimant of the undone day is cleared");
  assert.equal((await call({ action: "unclaim", day: 1, ...asB }, "2026-10-27")).ok, true, "with no claimant saved, the earlier day can be undone");
  assert.equal(lark.store.rows.length, 0);
});

test("undo in admin preview changes and checks nothing, whatever the table holds", async (t) => {
  const lark = startFakeLark({ rows: [day1Row({ [F.day2Claimed]: 5, [F.day2Base]: 28, [F.day3Claimed]: 6, [F.day3Base]: 28, [F.agent]: "Someone" })] });
  t.after(lark.stop);
  const answer = await call({ action: "unclaim", preview: true, day: 2, agentName: "Preview" }, "2026-10-28");
  assert.equal(answer.ok, true);
  assert.deepEqual(lark.store.writes, []);
});

test("without LARK_TABLE_HALLOWEEN the endpoint says so and the lookup shows no Halloween card", async () => {
  initEnv({ LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base" });
  const result = JSON.parse((await claimHandler({ httpMethod: "POST", body: "{}", env: {} })).body);
  assert.equal(result.ok, false);
  assert.equal(result.notConfigured, true);
});

test("the lookup returns the Halloween card state only for campaign brands inside their window", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const look = async (brand, date) => {
    const result = await searchHandler({
      body: JSON.stringify({ username: "zzali", brand, picName: "Aina", preview: true }),
      env: { HALLOWEEN_TEST_DATE: date },
    });
    assert.equal(result.statusCode, 200, result.body);
    return JSON.parse(result.body).row;
  };
  const day1 = (await look("NOW", "2026-10-26")).halloween;
  assert.equal(day1.state, "day1");
  assert.equal(day1.fullBrand, "NOW32");
  assert.equal(day1.tier, "Tier V");
  assert.equal(day1.table.length, 4);
  assert.equal((await look("NOW", "2026-10-25")).halloween, undefined, "before the send date");
  assert.equal((await look("NOW", "2026-10-29")).halloween, undefined, "after Day 3");
  assert.equal((await look("PP", "2026-10-26")).halloween, undefined, "not a campaign brand");

  lark.store.rows.push(day1Row());
  assert.equal((await look("NOW", "2026-10-26")).halloween.state, "topup");
  assert.equal((await look("NOW", "2026-10-27")).halloween.state, "day2");
});

// ---- Day 1 top-ups --------------------------------------------------------------------------
const NOON_MYT = Date.parse("2026-10-26T07:05:00Z");
const smallRow = (extra = {}) => day1Row({ [F.day1Deposit]: 50, [F.day1Bonus]: 18, [F.track]: "Below RM300", ...extra });

test("a top-up line reads back exactly, whatever the agent name holds", () => {
  const line = topupLine({ nowMs: NOON_MYT, fromDeposit: 50, toDeposit: 300, fromBonus: 18, toBonus: 120, agent: "96 Mathis · VIP\nRTN 🇲🇾", chatLink: "https://my.livechatinc.com/archives/TI1?shared=true" });
  assert.equal(line, "26/10 15:05 · RM50 → RM300 · bonus RM18 → RM120 (+RM102) · 96 Mathis VIP RTN 🇲🇾 · https://my.livechatinc.com/archives/TI1?shared=true");
  const [read] = readTopups(line);
  assert.deepEqual({ ...read, line: undefined }, { line: undefined, parsed: true, fromDeposit: 50, toDeposit: 300, fromBonus: 18, toBonus: 120, agent: "96 Mathis VIP RTN 🇲🇾", chatLink: "https://my.livechatinc.com/archives/TI1?shared=true" });
  assert.match(topupLine({ nowMs: NOON_MYT, fromDeposit: 50, toDeposit: 100, fromBonus: 18, toBonus: 40, agent: "", chatLink: "" }), / · - · -$/);
  assert.equal(readTopups("typed by hand\n\n")[0].parsed, false);
  assert.equal(readTopups("").length, 0);
});

test("Day 1 top-up: deposits add up, the difference is paid, the choice and the claimant stay", () => {
  const plan = claim({ row: smallRow(), nowMs: NOON_MYT, agent: "Bala", chatLink: "https://chat/2", input: { day: 1, choice: "TREAT", deposit: "300" } });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.topup, true);
  assert.equal(plan.amount, 102, "RM120 row minus the RM18 already paid");
  assert.equal(plan.total, 120);
  assert.equal(plan.choice, "TRICK", "TRICK or TREAT is chosen once");
  assert.equal(plan.track, "RM300+");
  assert.equal(plan.fields[F.day1Deposit], 300);
  assert.equal(plan.fields[F.day1Bonus], 120);
  assert.equal(plan.fields[F.track], "RM300+");
  assert.equal(plan.fields[F.day1Topups], "26/10 15:05 · RM50 → RM300 · bonus RM18 → RM120 (+RM102) · Bala · https://chat/2");
  assert.equal(F.agent in plan.fields || F.chatLink in plan.fields || F.day1Claimed in plan.fields, false, "the first claim's agent, chat and time stay");
  const second = claim({ row: smallRow({ [F.day1Deposit]: 300, [F.day1Bonus]: 120, [F.track]: "RM300+", [F.day1Topups]: plan.fields[F.day1Topups] }), nowMs: NOON_MYT, input: { day: 1, deposit: 600 } });
  assert.equal(second.amount, 80);
  assert.equal(second.fields[F.day1Topups].split("\n").length, 2, "each top-up adds a line");
  assert.equal(claim({ row: smallRow({ [F.choice]: "TREAT", [F.day1Bonus]: 15 }), input: { day: 1, deposit: 100 } }).amount, 15, "TREAT: RM30 row minus RM15");
});

test("Day 1 top-up is refused when the total is not higher, stays in the same row, or the day is over", () => {
  assert.match(claim({ row: smallRow(), input: { day: 1, deposit: 50 } }).error, /more than the RM50 already counted/);
  assert.match(claim({ row: smallRow(), input: { day: 1, deposit: 30 } }).error, /more than the RM50 already counted/);
  assert.match(claim({ row: smallRow(), input: { day: 1, deposit: 99 } }).error, /still in the RM50 row, so there is no extra bonus\. The next row starts at RM100/);
  assert.match(claim({ row: smallRow(), input: { day: 1, deposit: "" } }).error, /new total deposit/);
  assert.match(claim({ row: smallRow({ [F.choice]: "" }), input: { day: 1, deposit: 300 } }).error, /no TRICK or TREAT/);
  assert.match(claim({ row: smallRow(), today: "2026-10-27", input: { day: 1, deposit: 300 } }).error, /It is Day 2 now/, "only Day 1 has top-ups");
  assert.match(claim({ row: smallRow(), today: "2026-10-27", input: { day: 2 } }).error, /below RM300/, "a deposit after Day 1 changes nothing");
  assert.equal(claim({ row: smallRow(), tierText: "Tier 2", input: { day: 1, deposit: 300 } }).ok, true, "a top-up uses the tier saved on the first claim");
});

test("undo of a top-up: only the latest one, only by its agent in its chat, and never under a Day 2 claim", () => {
  const first = topupLine({ nowMs: NOON_MYT, fromDeposit: 50, toDeposit: 300, fromBonus: 18, toBonus: 120, agent: "Bala", chatLink: "https://chat/2" });
  const second = topupLine({ nowMs: NOON_MYT, fromDeposit: 300, toDeposit: 500, fromBonus: 120, toBonus: 200, agent: "Chen", chatLink: "https://chat/3" });
  const twice = smallRow({ [F.day1Deposit]: 500, [F.day1Bonus]: 200, [F.track]: "RM300+", [F.day1Topups]: `${first}\n${second}` });
  const undo = (r, agent, chatLink) => planUnclaim({ day: 1, row: r, agent, chatLink });
  const latest = undo(twice, "Chen", "https://chat/3");
  assert.equal(latest.kind, "topup");
  assert.deepEqual(latest.fields, { [F.day1Deposit]: 300, [F.day1Bonus]: 120, [F.track]: "RM300+" });
  assert.equal(latest.topups, first);
  assert.deepEqual(latest.clear, []);
  const refused = undo(twice, "Bala", "https://chat/2");
  assert.equal(refused.notOwner, true);
  assert.match(refused.error, /Only Chen, in the chat where it was made, can undo it; undo the top-up first/);
  assert.equal(undo(twice, "Aina", "https://chat/1").notOwner, true, "the first claimant cannot remove the whole Day 1 under a top-up");
  const once = smallRow({ [F.day1Deposit]: 300, [F.day1Bonus]: 120, [F.track]: "RM300+", [F.day1Topups]: first });
  const back = undo(once, "Bala", "https://chat/2");
  assert.deepEqual(back.fields, { [F.day1Deposit]: 50, [F.day1Bonus]: 18, [F.track]: "Below RM300" });
  assert.deepEqual(back.clear, [F.day1Topups]);
  assert.match(undo({ ...once, fields: { ...once.fields, [F.day1Deposit]: 350 } }, "Bala", "https://chat/2").error, /changed by hand/);
  assert.match(undo({ ...once, fields: { ...once.fields, [F.day1Topups]: `${first}\nnote` } }, "Bala", "https://chat/2").error, /changed by hand/);
  assert.match(undo({ ...once, fields: { ...once.fields, [F.day2Claimed]: 5 } }, "Bala", "https://chat/2").error, /Undo Day 2 first/);
});

test("the chat's story: RM100 claimed, RM300 topped up in another chat, Day 2 opens, and undo walks back one step at a time", async (t) => {
  const lark = startFakeLark();
  t.after(lark.stop);
  const asA = { agentName: "Aina", chatLink: "https://chat/a" };
  const asB = { agentName: "Bala", chatLink: "https://chat/b" };
  const asC = { agentName: "Chen", chatLink: "https://chat/c" };
  assert.equal((await call({ action: "claim", day: 1, choice: "TRICK", deposit: 100, ...asA }, "2026-10-26")).amount, 40);
  const preview = await call({ action: "claim", preview: true, day: 1, deposit: 300, ...asB }, "2026-10-26");
  assert.deepEqual([preview.ok, preview.topup, preview.amount], [true, true, 80]);
  assert.equal(lark.store.writes.length, 1, "the preview wrote nothing");
  const topped = await call({ action: "claim", day: 1, deposit: "300", ...asB }, "2026-10-26");
  assert.deepEqual([topped.ok, topped.topup, topped.amount, topped.total, topped.deposit, topped.track], [true, true, 80, 120, 300, "RM300+"]);
  const saved = lark.store.rows[0].fields;
  assert.deepEqual([saved[F.day1Deposit], saved[F.day1Bonus], saved[F.track], saved[F.choice], saved[F.agent], saved[F.chatLink]], [300, 120, "RM300+", "TRICK", "Aina", "https://chat/a"]);
  assert.match(saved[F.day1Topups], /^\d\d\/\d\d \d\d:\d\d · RM100 → RM300 · bonus RM40 → RM120 \(\+RM80\) · Bala · https:\/\/chat\/b$/);
  assert.equal((await call({ action: "claim", day: 1, deposit: 600, ...asC }, "2026-10-26")).amount, 80);
  assert.equal(lark.store.rows.length, 1);

  assert.equal((await call({ action: "unclaim", day: 1, ...asA }, "2026-10-26")).notOwner, true, "Day 1 cannot be removed under its top-ups");
  assert.equal((await call({ action: "unclaim", day: 1, ...asB }, "2026-10-26")).notOwner, true, "only the latest top-up can be undone");
  const undoC = await call({ action: "unclaim", day: 1, ...asC }, "2026-10-26");
  assert.deepEqual([undoC.ok, undoC.topupUndone, undoC.amount, undoC.toDeposit], [true, true, 80, 600]);
  assert.deepEqual([saved[F.day1Deposit], saved[F.day1Bonus]], [300, 120]);
  assert.equal(lark.store.rows[0].fields[F.day1Topups].split("\n").length, 1);

  const day2 = await call({ action: "claim", day: 2, ...asB }, "2026-10-27");
  assert.equal(day2.ok, true, "the top-up to RM300 opened Day 2");
  assert.match((await call({ action: "unclaim", day: 1, ...asB }, "2026-10-27")).error, /Undo Day 2 first/);
  assert.equal((await call({ action: "unclaim", day: 2, ...asB }, "2026-10-27")).ok, true);
  assert.equal((await call({ action: "unclaim", day: 1, ...asB }, "2026-10-27")).topupUndone, true, "a top-up can still be undone after Day 1");
  const row1 = lark.store.rows[0].fields;
  assert.deepEqual([row1[F.day1Deposit], row1[F.day1Bonus], row1[F.track], row1[F.day1Topups]], [100, 40, "Below RM300", undefined]);
  const undoA = await call({ action: "unclaim", day: 1, ...asA }, "2026-10-27");
  assert.deepEqual([undoA.ok, undoA.topupUndone], [true, undefined]);
  assert.equal(lark.store.rows.length, 0, "with no top-ups left, undoing Day 1 removes the row as before");
});

test("a top-up line Lark returns in pieces (a link becomes its own piece) is still read whole", async (t) => {
  const line = topupLine({ nowMs: NOON_MYT, fromDeposit: 50, toDeposit: 300, fromBonus: 18, toBonus: 120, agent: "Bala", chatLink: "https://chat/b" });
  const [head] = line.split("https://");
  const pieces = [{ type: "text", text: head }, { type: "url", text: "https://chat/b", link: "https://chat/b" }];
  const lark = startFakeLark({ rows: [smallRow({ [F.day1Deposit]: 300, [F.day1Bonus]: 120, [F.track]: "RM300+", [F.day1Topups]: pieces })] });
  t.after(lark.stop);
  const undo = await call({ action: "unclaim", day: 1, agentName: "Bala", chatLink: "https://chat/b" }, "2026-10-26");
  assert.equal(undo.topupUndone, true, JSON.stringify(undo));
  assert.equal(lark.store.rows[0].fields[F.day1Deposit], 50);
});

test("two agents top up the same player at the same moment: one is accepted and the row holds only its line", async (t) => {
  const lark = startFakeLark({ rows: [smallRow()] });
  t.after(lark.stop);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call(
    { action: "claim", day: 1, deposit: 300 + i * 10, agentName: `Agent${i}`, chatLink: `https://chat/${i}` },
    "2026-10-26", { HALLOWEEN_SETTLE_MS: "40,40" },
  )));
  const accepted = results.filter((r) => r.ok);
  assert.equal(accepted.length, 1, JSON.stringify(results.map((r) => r.error || "ok")));
  assert.match(results.find((r) => !r.ok).error, /Another top-up for this player was claimed a moment ago/);
  const lines = readTopups(lark.store.rows[0].fields[F.day1Topups]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].toDeposit, accepted[0].deposit);
  assert.equal(lark.store.rows[0].fields[F.day1Deposit], accepted[0].deposit);
});
