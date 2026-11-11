import test from "node:test";
import assert from "node:assert/strict";
import {
  BF, bonusAmountOf, birthdayGivenThisYearFrom, dateInputToEpoch, malaysiaDateOf, newRowFields, rowYear,
} from "./_lib/birthday.js";

const MY = (iso) => Date.parse(iso + "+08:00");

test("Lark dates are read as Malaysia calendar dates", () => {
  assert.equal(malaysiaDateOf(MY("2026-11-12T00:00:00")), "2026-11-12", "midnight Malaysia (P&L date field)");
  assert.equal(malaysiaDateOf(Date.parse("2026-11-12T00:00:00Z")), "2026-11-12", "UTC midnight (how the widget writes D.O.B)");
  assert.equal(malaysiaDateOf(null), "");
  assert.equal(dateInputToEpoch("1990-11-12"), Date.parse("1990-11-12T00:00:00Z"));
  assert.equal(dateInputToEpoch("12/11/1990"), null);
});

test("SW - Bonus Amount is read from numbers, formulas and text", () => {
  assert.equal(bonusAmountOf(137.4025), 137.4);
  assert.equal(bonusAmountOf({ type: 2, value: [666.51] }), 666.51);
  assert.equal(bonusAmountOf("1,688"), 1688);
  assert.equal(bonusAmountOf(""), 0);
  assert.equal(bonusAmountOf(undefined), 0);
});

test("a birthday bonus already given this year blocks another (same brand, Given, Inquiry Birthday)", () => {
  const row = (created, fields) => ({ created_time: created, fields: { Brand: "LPK", Status: "Given", Inquiry: ["Birthday"], ...fields } });
  assert.equal(birthdayGivenThisYearFrom([row(MY("2026-03-01T10:00:00"))], "LPK", "2026"), true);
  assert.equal(birthdayGivenThisYearFrom([row(MY("2025-11-12T10:00:00"))], "LPK", "2026"), false, "last year");
  assert.equal(birthdayGivenThisYearFrom([row(MY("2026-03-01T10:00:00"), { Brand: "JOM" })], "LPK", "2026"), false, "other brand");
  assert.equal(birthdayGivenThisYearFrom([row(MY("2026-03-01T10:00:00"), { Status: "Rejected" })], "LPK", "2026"), false, "not given");
  assert.equal(birthdayGivenThisYearFrom([row(MY("2026-03-01T10:00:00"), { Inquiry: ["TOP P&L"] })], "LPK", "2026"), false, "other bonus");
});

test("a Birthday Bonus row belongs to the year of its Time of Inspection, else when it was created", () => {
  assert.equal(rowYear({ fields: { [BF.inspected]: MY("2026-07-02T09:00:00") }, created_time: MY("2025-01-01T09:00:00") }), "2026");
  assert.equal(rowYear({ fields: {}, created_time: MY("2025-12-31T23:30:00") }), "2025");
});

test("a new row writes username, brand and picture, plus DOB and Time of Inspection only when they are plain date fields", () => {
  const catalog = [
    { field_name: BF.username, type: 1 }, { field_name: BF.brand, type: 3 }, { field_name: BF.dob, type: 5 },
    { field_name: BF.inspected, type: 1001 }, { field_name: BF.screenshot, type: 17 },
  ];
  assert.deepEqual(newRowFields({ username: "abc", brand: "LPK", dob: "1990-11-12", fileToken: "tok", nowMs: 5 }, catalog), {
    [BF.username]: "abc", [BF.brand]: "LPK", [BF.dob]: Date.parse("1990-11-12T00:00:00Z"), [BF.screenshot]: [{ file_token: "tok" }],
  });
  const lookups = catalog.map((field) => (field.field_name === BF.dob ? { ...field, type: 19 } : field.field_name === BF.inspected ? { ...field, type: 5 } : field));
  assert.deepEqual(newRowFields({ username: "abc", brand: "LPK", dob: "1990-11-12", fileToken: "", nowMs: 5 }, lookups), {
    [BF.username]: "abc", [BF.brand]: "LPK", [BF.inspected]: 5,
  });
  assert.throws(() => newRowFields({ username: "a", brand: "b" }, []), /no field called "Username\/UID"/);
});
