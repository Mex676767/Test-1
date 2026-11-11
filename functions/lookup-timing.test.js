import test from "node:test";
import assert from "node:assert/strict";
import { noteLookupTimings } from "./lark-search.js";

const collect = (tasks) => {
  const counters = {};
  noteLookupTimings(tasks, (name, n = 1) => { counters[name] = (counters[name] || 0) + n; });
  return counters;
};

test("the Customer Approaching player search is timed apart from the other lookups", () => {
  assert.deepEqual(collect([
    { label: "Other-brand check", ms: 420 },
    { label: "P&L tier", ms: 300 },
    { label: "LTV", ms: 900 },
  ]), { "lookupN:all": 1, "lookupMs:caSearch": 420, "lookupN:caSearch": 1, "lookupMs:others": 1200, "lookupN:others": 2 });
});

test("a lookup where that search was the slowest is counted", () => {
  const counters = collect([{ label: "Other-brand check", ms: 2000 }, { label: "LTV", ms: 900 }]);
  assert.equal(counters["lookupSlowest:caSearch"], 1);
});

test("nothing is counted when no timing is known", () => {
  assert.deepEqual(collect([{ label: "LTV" }]), {});
});
