import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN, DAY1_TABLE, F, brandKey, checkFields, day1Bonus, dayNumber, halloweenStatus, malaysiaToday,
  normalizeTier, planClaim, planUnclaim, shapeFields,
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
    dateField(F.day1Claimed),
    numberField(F.day2Base), numberField(F.day2Share), dateField(F.day2Claimed),
    numberField(F.day3Base), numberField(F.day3Share), dateField(F.day3Claimed),
    selectField(F.shareMethod, ["Social post", "5 friends"]),
    textField(F.postLink), textField(F.agent), textField(F.chatLink),
  ];
}

const row = (fields, id = "rec1") => ({ record_id: id, created_time: 1, fields });
const day1Row = (extra = {}) => row({
  [F.uid]: "zzali", [F.brand]: "EZ", [F.tier]: "Tier V", [F.choice]: "TRICK",
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
  assert.deepEqual(starts["2026-10-26"], ["EZ", "NOW", "JUS"]);
  assert.deepEqual(starts["2026-10-31"], ["RM", "BM", "SA", "JK"]);
});

test("a brand's window is its send date plus two days, Malaysia time", () => {
  assert.equal(dayNumber("EZ", "2026-10-25"), 0);
  assert.equal(dayNumber("EZ", "2026-10-26"), 1);
  assert.equal(dayNumber("EZ", "2026-10-27"), 2);
  assert.equal(dayNumber("EZ", "2026-10-28"), 3);
  assert.equal(dayNumber("EZ", "2026-10-29"), 0);
  assert.equal(dayNumber("RM", "2026-11-02"), 3);
  assert.equal(dayNumber("RM", "2026-11-03"), 0);
  assert.equal(dayNumber("EZ96", "2026-10-26"), 1, "a full brand name still resolves");
  assert.equal(dayNumber("PP", "2026-10-27"), 0, "a brand outside the campaign never opens");
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
  const status = (today, r, tierText = "Tier V", brand = "EZ") => halloweenStatus({ brand, tierText, row: r, today });
  assert.equal(status("2026-10-25", null), null, "before the send date nothing shows");
  assert.equal(status("2026-10-29", day1Row()), null, "after Day 3 nothing shows");
  assert.equal(halloweenStatus({ brand: "PP", tierText: "Tier V", row: null, today: "2026-10-26" }), null);
  assert.equal(status("2026-10-26", null).state, "day1");
  assert.equal(status("2026-10-26", day1Row()).state, "done");
  assert.equal(status("2026-10-26", null, "Tier 2").state, "closed");
  assert.match(status("2026-10-26", null, "Tier 2").message, /Tier 2/);
  assert.equal(status("2026-10-27", null).state, "closed");
  assert.equal(status("2026-10-27", lowRow()).state, "closed");
  assert.match(status("2026-10-27", lowRow()).message, /below RM300/);
  const day2 = status("2026-10-27", day1Row());
  assert.equal(day2.state, "day2");
  assert.equal(day2.redPacket, 28);
  assert.equal(status("2026-10-27", day1Row(), "Tier 3").redPacket, 18);
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

const claim = (over) => planClaim({ brand: "EZ", tierText: "Tier V", row: null, today: "2026-10-26", nowMs: 1000, agent: "Aina", chatLink: "https://chat/1", ...over });

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
  assert.equal(day2({ tierText: "Tier 3", input: { day: 2 } }).amount, 18);

  const shared = day2({ input: { day: 2, shared: true, shareMethod: "Social post", postLink: "https://fb.com/p/1" } });
  assert.equal(shared.amount, 56);
  assert.equal(shared.fields[F.day2Share], 28);
  assert.equal(shared.fields[F.shareMethod], "Social post");
  assert.equal(shared.fields[F.postLink], "https://fb.com/p/1");
  assert.equal(day2({ tierText: "Tier 3", input: { day: 2, shared: true, shareMethod: "5 friends" } }).amount, 46);
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
  assert.deepEqual(report.missingOptions.filter((item) => item.field === F.brand).map((item) => item.option), ["EZ", "NOW"]);
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

function startFakeLark({ catalog = goodCatalog(), tier = "Tier V", rows = [] } = {}) {
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
    if (href.includes(`/tables/${hw}/fields`)) return ok({ items: catalog });
    if (href.includes(`/tables/${pnl}/fields`)) return ok({ items: [{ field_name: "Tier", type: 3, property: { options: [] } }] });
    if (href.includes(`/tables/${pnl}/records/search`)) {
      return ok({ items: tier === null ? [] : [{ record_id: "p1", fields: { Username: "zzali", Brand: "EZ", Tier: tier } }], has_more: false });
    }
    if (href.includes(`/tables/${hw}/records/search`)) {
      const conditions = JSON.parse(options.body).filter.conditions;
      const items = store.rows.filter((item) => conditions.every((c) => String(item.fields[c.field_name]).toLowerCase() === String(c.value[0]).toLowerCase()));
      return ok({ items, has_more: false });
    }
    if (href.includes(`/tables/${hw}/records`) && method === "POST") {
      const record = { record_id: `rec${store.nextId++}`, created_time: store.nextId, fields: JSON.parse(options.body).fields };
      store.rows.push(record);
      store.writes.push(["create", record.record_id, record.fields]);
      return ok({ record });
    }
    const recordMatch = href.match(new RegExp(`/tables/${hw}/records/([^/?]+)`));
    if (recordMatch && method === "PUT") {
      const target = store.rows.find((item) => item.record_id === recordMatch[1]);
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
  const result = await claimHandler({ httpMethod: "POST", body: JSON.stringify({ username: "ZZAli", brand: "EZ", agentName: "Aina", chatLink: "https://chat/1", ...body }), env: { HALLOWEEN_TEST_DATE: date, ...extraEnv } });
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
  assert.equal(saved[F.brand], "EZ");
  assert.equal(saved[F.tier], "Tier V");
  assert.equal(saved[F.track], "RM300+");
  assert.equal(saved[F.day1Bonus], 120);
  assert.equal(saved[F.agent], "Aina");
  assert.equal(typeof saved[F.day1Claimed], "number");

  assert.equal((await call({ action: "claim", day: 1, choice: "TREAT", deposit: 500 }, "2026-10-26")).ok, false, "TRICK or TREAT is once only");
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
  const day1 = (await look("EZ", "2026-10-26")).halloween;
  assert.equal(day1.state, "day1");
  assert.equal(day1.fullBrand, "EZ96");
  assert.equal(day1.tier, "Tier V");
  assert.equal(day1.table.length, 4);
  assert.equal((await look("EZ", "2026-10-25")).halloween, undefined, "before the send date");
  assert.equal((await look("EZ", "2026-10-29")).halloween, undefined, "after Day 3");
  assert.equal((await look("PP", "2026-10-26")).halloween, undefined, "not a campaign brand");

  lark.store.rows.push(day1Row());
  assert.equal((await look("EZ", "2026-10-26")).halloween.state, "done");
  assert.equal((await look("EZ", "2026-10-27")).halloween.state, "day2");
});
