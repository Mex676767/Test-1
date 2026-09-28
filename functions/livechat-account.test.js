import test from "node:test";
import assert from "node:assert/strict";
import { initEnv, LIVECHAT_ACCOUNTS, LIVECHAT_PATS, accountKeyForPat } from "./_lib/livechat.js";

test("keeps stable account labels when both LiveChat credentials exist", () => {
  initEnv({ LIVECHAT_PAT: "first-token", LIVECHAT_PAT_2: "second-token" });
  assert.deepEqual(LIVECHAT_PATS, ["first-token", "second-token"]);
  assert.deepEqual(LIVECHAT_ACCOUNTS.map(({ key }) => key), ["lc1", "lc2"]);
  assert.equal(accountKeyForPat("first-token"), "lc1");
  assert.equal(accountKeyForPat("second-token"), "lc2");
});

test("the second credential remains lc2 when the first is unavailable", () => {
  initEnv({ LIVECHAT_PAT_2: "second-token" });
  assert.deepEqual(LIVECHAT_PATS, ["second-token"]);
  assert.equal(accountKeyForPat("second-token"), "lc2");
});
