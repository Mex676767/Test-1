import test from "node:test";
import assert from "node:assert/strict";
import { handler, consoleBase, resetNoteLimits } from "./console-note.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const CONSOLE = "https://console.test";
const KEY = "console-secret-key";
const ENV = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base",
  LARK_TABLE_CUSTOMER_APPROACHING: "ca-table", LARK_TABLE_AGENT_LOGINS: "logins-table",
  LIVECHAT_CLIENT_ID: "client-1", LIVECHAT_CLIENT_ID_2: "client-2",
  CONSOLE_API_URL: CONSOLE, CONSOLE_NOTE_TOKEN: KEY,
};
const bound = (id, account, login, name) => ({ record_id: id, fields: { "LiveChat Account": account, "LiveChat Login": login, "Agent Name": name, "Locked At": 1000 } });
const TABLE = [bound("r1", "lc1", "alice@x.com", "96 Raven - VIP RTN SNR MY"), bound("r2", "lc2", "bob@x.com", "96 Hans")];
const TOKENS = {
  "tok-alice": { account_id: "alice@x.com", client_id: "client-1" },
  "tok-bob": { account_id: "bob@x.com", client_id: "client-2" },
  "tok-newbie": { account_id: "newbie@x.com", client_id: "client-1" },
};

function world({ consoleReply, consoleThrows, larkThrows = false } = {}) {
  const log = { console: [], lark: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.startsWith(CONSOLE) || url.startsWith("http://localhost:8787")) {
      log.console.push({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
      if (consoleThrows) throw consoleThrows;
      const reply = typeof consoleReply === "function" ? consoleReply(url, options) : consoleReply || { status: 200, body: { saved: true } };
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    }
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? { ok: true, json: async () => info } : { ok: false, json: async () => ({ error: "invalid_token" }) };
    }
    if (url.includes("/tables/logins-table/records")) {
      log.lark += 1;
      if (larkThrows) throw new Error("Lark is down");
      return { json: async () => ({ code: 0, data: { items: TABLE } }) };
    }
    throw new Error("unexpected " + url);
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, env = ENV) => {
  initLarkEnv(env); initLiveChatEnv({});
  resetNoteLimits();
  const res = await handler({ body: JSON.stringify(body), env });
  return { status: res.statusCode, ...JSON.parse(res.body), raw: res.body };
};
const good = { accountKey: "lc1", agentToken: "tok-alice", username: "SweCin", brand: "SPIN321", note: "Asked about the VIP trip" };

test("the author is the Agent Name bound to the verified LiveChat login, never anything the browser says", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await call({ ...good, agent: "96 Hans", author: "Somebody Else", agentName: "Boss", username: "  SweCin " });
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.equal(w.log.console.length, 1);
  const sent = w.log.console[0];
  assert.equal(sent.url, `${CONSOLE}/api/ext/note`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["x-widget-token"], KEY);
  assert.deepEqual(sent.body, { player_key: "swecin", brand: "SPIN321", note: "Asked about the VIP trip", author: "96 Raven - VIP RTN SNR MY" });
  assert.ok(sent.signal, "the call to the console has a time limit");
  assert.ok(!out.raw.includes(KEY) && !out.raw.includes("tok-alice"), "no secret comes back to the browser");
});

test("the second LiveChat account's login gets its own bound name", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await call({ ...good, accountKey: "lc2", agentToken: "tok-bob" });
  assert.equal(out.ok, true);
  assert.equal(w.log.console[0].body.author, "96 Hans");
});

test("bad input is refused before anyone is called", async (t) => {
  const w = world();
  t.after(w.restore);
  for (const body of [
    { ...good, username: "" }, { ...good, brand: " " }, { ...good, note: "   " }, { ...good, note: "x".repeat(2001) }, { ...good, brand: "B".repeat(61) },
  ]) {
    const out = await call(body);
    assert.equal(out.status, 400);
    assert.equal(out.ok, false);
  }
  assert.equal((await call(null)).status, 400);
  assert.equal(w.log.console.length, 0);
  assert.equal(w.log.lark, 0);
  const exact = await call({ ...good, note: "x".repeat(2000) });
  assert.equal(exact.ok, true, "2000 characters is allowed");
});

test("no LiveChat login, a login LiveChat does not know, or one from the other account's app: refused, console not called", async (t) => {
  const w = world();
  t.after(w.restore);
  for (const body of [
    { ...good, agentToken: "" }, { ...good, accountKey: "lc9" }, { ...good, agentToken: "forged" },
    { ...good, accountKey: "lc1", agentToken: "tok-bob" },
  ]) {
    const out = await call(body);
    assert.equal(out.status, 401, JSON.stringify(body));
    assert.equal(out.ok, false);
    assert.equal(out.loginExpired, true);
  }
  assert.equal(w.log.console.length, 0);
});

test("a verified login with no Agent Name bound is refused", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await call({ ...good, agentToken: "tok-newbie" });
  assert.equal(out.status, 403);
  assert.match(out.error, /no Agent Name/);
  assert.equal(w.log.console.length, 0);
});

test("if the agent list cannot be read the note is not sent, with a plain message", async (t) => {
  const w = world({ larkThrows: true });
  t.after(w.restore);
  const out = await call(good);
  assert.equal(out.ok, false);
  assert.match(out.error, /Try again/);
  assert.equal(w.log.console.length, 0);
});

test("without the console address or key, or with a plain-http public address, notes are reported as not set up and nothing is called", async (t) => {
  const w = world();
  t.after(w.restore);
  for (const env of [
    { ...ENV, CONSOLE_API_URL: "" }, { ...ENV, CONSOLE_NOTE_TOKEN: "" }, { ...ENV, CONSOLE_API_URL: "http://console.test" }, { ...ENV, CONSOLE_API_URL: "not a url" },
  ]) {
    const out = await call(good, env);
    assert.equal(out.ok, false);
    assert.equal(out.notConfigured, true);
  }
  assert.equal(w.log.console.length, 0);
  assert.equal(w.log.lark, 0);
  assert.equal(consoleBase({ CONSOLE_API_URL: "http://localhost:8787/", CONSOLE_NOTE_TOKEN: "k" }), "http://localhost:8787");
  assert.equal(consoleBase({ CONSOLE_API_URL: "https://c.test///", CONSOLE_NOTE_TOKEN: "k" }), "https://c.test");
});

test("what the console says becomes a plain message and never leaks the key", async (t) => {
  const cases = [
    [404, { error: "player not found in the console" }, /not in the console/],
    [429, { error: "too many notes, slow down" }, /Too many notes right now/],
    [400, { error: "unknown brand" }, /did not accept the note: unknown brand/],
    [401, { error: "unauthorized" }, /Tell your admin/],
    [500, { error: "boom" }, /could not save the note/],
    [200, {}, /could not save the note/],
  ];
  for (const [status, body, pattern] of cases) {
    const w = world({ consoleReply: { status, body } });
    const out = await call(good);
    w.restore();
    assert.equal(out.ok, false, String(status));
    assert.match(out.error, pattern);
    assert.ok(!out.raw.includes(KEY));
  }
});

test("a console that times out or cannot be reached gives a calm 'may or may not be saved' answer and never throws", async (t) => {
  for (const failure of [Object.assign(new Error("timed out"), { name: "TimeoutError" }), new Error("fetch failed")]) {
    const w = world({ consoleThrows: failure });
    const out = await call(good);
    w.restore();
    assert.equal(out.ok, false);
    assert.equal(out.unsure, true);
    assert.match(out.error, /may or may not have been saved/);
  }
});

test("showing existing notes: a GET with the key, the player lower-cased, at most 10 notes, plain fields only", async (t) => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: i, note: `n${i}`, created_by: "raven (widget)", created_at: "2026-10-18 09:00:00", secret: "x" }));
  const w = world({ consoleReply: { status: 200, body: { player_key: "swecin", notes: many } } });
  t.after(w.restore);
  const out = await call({ ...good, note: undefined, list: true });
  assert.equal(out.ok, true);
  assert.equal(out.notes.length, 10);
  assert.deepEqual(Object.keys(out.notes[0]).sort(), ["at", "by", "note"]);
  const sent = w.log.console[0];
  assert.equal(sent.method, "GET");
  assert.equal(sent.url, `${CONSOLE}/api/ext/notes?player_key=swecin&brand=SPIN321`);
  assert.equal(sent.headers["x-widget-token"], KEY);
});

test("listing needs the same verified login, and a player the console does not know is just 'not found'", async (t) => {
  const w = world({ consoleReply: { status: 404, body: { error: "player not found in the console" } } });
  t.after(w.restore);
  const refused = await call({ ...good, list: true, agentToken: "forged" });
  assert.equal(refused.status, 401);
  assert.equal(w.log.console.length, 0);
  const none = await call({ ...good, list: true });
  assert.equal(none.ok, false);
  assert.equal(none.notFound, true);
});

test("one agent cannot flood the console: the 21st note inside a minute is held back", async (t) => {
  const w = world();
  t.after(w.restore);
  initLarkEnv(ENV); initLiveChatEnv({});
  resetNoteLimits();
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = JSON.parse((await handler({ body: JSON.stringify(good), env: ENV })).body);
    if (i < 20) assert.equal(last.ok, true);
  }
  assert.equal(last.ok, false);
  assert.match(last.error, /Too many notes/);
  assert.equal(w.log.console.length, 20);
});

test("an action-log entry goes to its own console route with the same verified author; a wrong type is refused", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await call({ ...good, type: "action", note: "Call back Friday" });
  assert.equal(out.ok, true);
  const sent = w.log.console[0];
  assert.equal(sent.url, `${CONSOLE}/api/ext/action`);
  assert.equal(sent.headers["x-widget-token"], KEY);
  assert.deepEqual(sent.body, { player_key: "swecin", brand: "SPIN321", note: "Call back Friday", author: "96 Raven - VIP RTN SNR MY" });
  const relationship = await call({ ...good, type: "relationship" });
  assert.equal(relationship.ok, true);
  assert.equal(w.log.console[1].url, `${CONSOLE}/api/ext/note`, "an explicit relationship type still goes to the notes route");
  const bad = await call({ ...good, type: "status" });
  assert.equal(bad.status, 400);
  assert.equal(w.log.console.length, 2, "nothing was sent for the bad type");
});

test("an action entry the console did not confirm is never reported as saved, and the unsure message names the Action log", async (t) => {
  const w = world({ consoleReply: { status: 200, body: {} } });
  t.after(w.restore);
  const notSaved = await call({ ...good, type: "action" });
  assert.equal(notSaved.ok, false);
  w.restore();
  const w2 = world({ consoleThrows: new Error("timed out") });
  t.after(w2.restore);
  const unsure = await call({ ...good, type: "action" });
  assert.equal(unsure.unsure, true);
  assert.match(unsure.error, /Action log/);
});

test("removing the Halloween Day 1 Action log line goes to the console's remove route with the verified author", async (t) => {
  const w = world({ consoleReply: { status: 200, body: { removed: true, player_key: "swecin", deletedRow: false } } });
  t.after(w.restore);
  const out = await call({ ...good, type: "action", note: undefined, remove: true, startsWith: "Halloween Day 1:", author: "Somebody Else" });
  assert.equal(out.ok, true);
  assert.equal(out.removed, true);
  const sent = w.log.console[0];
  assert.equal(sent.url, `${CONSOLE}/api/ext/action/remove`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["x-widget-token"], KEY);
  assert.deepEqual(sent.body, { player_key: "swecin", brand: "SPIN321", starts_with: "Halloween Day 1:", author: "96 Raven - VIP RTN SNR MY" });
  assert.ok(!out.raw.includes(KEY), "no secret comes back to the browser");
});

test("a removal the console says found nothing is still a success (already undone); other answers are explained", async (t) => {
  const answer = async (consoleReply) => { const w = world({ consoleReply }); try { return await call({ ...good, type: "action", remove: true, startsWith: "Halloween Day 1:" }); } finally { w.restore(); } };
  const none = await answer({ status: 200, body: { removed: false, player_key: "swecin" } });
  assert.equal(none.ok, true);
  assert.equal(none.removed, false);
  assert.match((await answer({ status: 404, body: { error: "player not found in the console" } })).error, /not in the console/);
  assert.match((await answer({ status: 401, body: { error: "unauthorized" } })).error, /could not remove the note/);
  assert.equal((await answer({ status: 200, body: {} })).ok, false, "an answer without removed:true/false is never reported as done");
  assert.equal((await answer({ status: 500, body: {} })).ok, false);
  const w = world({ consoleThrows: new Error("timed out") });
  t.after(w.restore);
  const unsure = await call({ ...good, type: "action", remove: true, startsWith: "Halloween Day 1:" });
  assert.equal(unsure.unsure, true);
});

test("only a Halloween Action log line can be removed; nothing is sent to the console otherwise", async (t) => {
  const w = world();
  t.after(w.restore);
  for (const body of [
    { type: "action", remove: true, startsWith: "Call back Friday" },
    { type: "action", remove: true, startsWith: "" },
    { type: "action", remove: true },
    { type: "action", remove: true, startsWith: "Halloween Day 4:" },
    { type: "relationship", remove: true, startsWith: "Halloween Day 1:" },
    { remove: true, startsWith: "Halloween Day 1:" },
    { type: "action", remove: true, list: true, startsWith: "Halloween Day 1:" },
  ]) assert.equal((await call({ ...good, ...body })).status, 400, JSON.stringify(body));
  assert.equal(w.log.console.length, 0);
  assert.equal((await call({ accountKey: "lc1", agentToken: "tok-newbie", username: "x", brand: "OG", type: "action", remove: true, startsWith: "Halloween Day 1:" })).ok, false, "an agent without a bound name is refused");
});

test("listing the Action log reads /api/ext/actions", async (t) => {
  const w = world({ consoleReply: { status: 200, body: { actions: [{ note: "[widget · raven · 10:00] call", status: null, created_by: "raven (widget)", created_at: "2026-10-18 10:00:00", snapshot_date: "2026-10-18" }] } } });
  t.after(w.restore);
  const out = await call({ ...good, type: "action", note: undefined, list: true });
  assert.equal(out.ok, true);
  assert.equal(out.notes.length, 1);
  assert.deepEqual(Object.keys(out.notes[0]).sort(), ["at", "by", "note"]);
  assert.equal(w.log.console[0].url, `${CONSOLE}/api/ext/actions?player_key=swecin&brand=SPIN321`);
});
