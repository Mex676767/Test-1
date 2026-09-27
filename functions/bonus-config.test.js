import test from "node:test";
import assert from "node:assert/strict";
import { isConfiguredBonusEligible, normalizeBonusConfig } from "./_lib/bonus-config.js";

const base = {
  key: "weekend-reload",
  label: "Weekend Reload",
  sourceTableId: "tbl123",
  inquiry: "Weekend Reload",
};

test("normalizes a regular bonus configuration", () => {
  const config = normalizeBonusConfig({ ...base, usernameField: "", displayField: "", selection: "NEWEST" });
  assert.equal(config.usernameField, "Username/UID");
  assert.equal(config.displayField, "Status");
  assert.equal(config.selection, "newest");
});

test("generic eligibility rules always reject terminal statuses", () => {
  const config = normalizeBonusConfig({ ...base, rule: "starts_with", ruleValue: "Pass" });
  assert.equal(isConfiguredBonusEligible(config, "Pass RM18"), true);
  assert.equal(isConfiguredBonusEligible(config, "Pass - Claimed RM18"), false);
  assert.equal(isConfiguredBonusEligible(config, "Failed"), false);
  assert.equal(isConfiguredBonusEligible(config, ""), false);
});
