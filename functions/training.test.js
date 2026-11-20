import test from "node:test";
import assert from "node:assert/strict";
import { initEnv } from "./_lib/lark.js";
import { handler as lookup } from "./lark-search.js";
import { handler as record } from "./lark-record.js";
import { handler as claim } from "./lark-claim.js";
import { handler as remove } from "./lark-delete-record.js";
import { handler as playerName } from "./player-name.js";
import { handler as note } from "./console-note.js";
import { handler as birthday } from "./birthday-bonus.js";
import { isTrainingPlayer, trainingLookupBody } from "./_lib/training.js";

function noNetwork(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("network must not be used"); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("only edwintest on LPK is the training player", () => {
  assert.equal(isTrainingPlayer(" EdwinTest ", "lpk"), true);
  assert.equal(isTrainingPlayer("edwintest", "VS"), false);
  assert.equal(isTrainingPlayer("edwin", "LPK"), false);
});

test("the training lookup shows every bonus, is not read-only and never touches Lark or LiveChat", async (t) => {
  initEnv({ LARK_APP_ID: "a", LARK_APP_SECRET: "b", LARK_BASE_APP_TOKEN: "c", LARK_TABLE_CUSTOMER_APPROACHING: "ca" });
  const calls = noNetwork(t);
  const res = await lookup({ body: JSON.stringify({ username: "EdwinTest", brand: "LPK", picName: "96 Cara", link: "https://my.livechatinc.com/chats/C/T", chatAccess: { accountKey: "lc1", agentToken: "tok" } }) });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.training, true);
  assert.equal(body.readOnly, false);
  assert.match(body.caRecordId, /^rectraining/);
  for (const key of ["topPnl", "ltvTest", "gracePeriod", "riskPlayer", "vipBooster", "mooncake", "vs96Feedback"]) assert.ok(body.row[key], key);
  for (const key of ["specialReload", "telegram28", "redeemCode"]) assert.match(body.row[key].recordId, /^rectraining/);
  assert.ok(body.row.graceExpiryMs > Date.now());
  assert.deepEqual(calls, []);
});

test("writes for the training player are answered without writing anything", async (t) => {
  const calls = noNetwork(t);
  const ok = async (fn, body) => JSON.parse((await fn({ httpMethod: "POST", body: JSON.stringify(body) })).body);
  assert.equal((await ok(record, { recordId: "rectrainingcase1", inquiry: ["LTV"], status: "Given" })).training, true);
  assert.equal((await ok(record, { recordId: "recReal123", username: "edwintest", unclaim: true })).training, true);
  assert.equal((await ok(claim, { source: "redeemCode", recordId: "rectrainingredeem" })).training, true);
  assert.equal((await ok(remove, { recordId: "rectrainingcase1", agentName: "x" })).training, true);
  assert.equal((await ok(playerName, { recordId: "rectrainingpnl", username: "edwintest", brand: "LPK", expectedName: "", name: "Ed" })).customerName, "Ed");
  assert.equal((await ok(note, { username: "edwintest", brand: "LPK", note: "hi" })).saved, true);
  assert.deepEqual((await ok(note, { username: "edwintest", brand: "LPK", list: true })).notes, []);
  assert.deepEqual(calls, []);
  assert.equal(trainingLookupBody(0).row.claimsDay, "1970-01-01");
});

test("a training Birthday Bonus check returns a sample amount without creating a row", async (t) => {
  initEnv({ LARK_APP_ID: "a", LARK_APP_SECRET: "b", LARK_BASE_APP_TOKEN: "c", LARK_TABLE_BIRTHDAY: "bday" });
  const calls = noNetwork(t);
  const form = new FormData();
  form.append("username", "edwintest"); form.append("brand", "LPK");
  const out = JSON.parse((await birthday({ httpMethod: "POST", formData: form })).body);
  assert.equal(out.ok, true);
  assert.equal(out.recordId, "rectrainingbirthday");
  assert.deepEqual(calls, []);
});
