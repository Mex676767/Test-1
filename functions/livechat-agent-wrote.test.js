import test from "node:test";
import assert from "node:assert/strict";
import { handler, agentWroteIn } from "./livechat-agent-wrote.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const users = [{ id: "cust-1", type: "customer" }, { id: "alice@x.com", type: "agent" }, { id: "bob@x.com", type: "agent" }];
const msg = (author_id, extra = {}) => ({ type: "message", author_id, text: "hi", ...extra });

test("the agent wrote when one of their ids authored a customer-facing message", () => {
  const chat = { users, thread: { events: [msg("cust-1"), msg("alice@x.com"), msg("bob@x.com")] } };
  assert.deepEqual(agentWroteIn(chat, ["alice@x.com"]), { wrote: true, authors: ["alice@x.com", "bob@x.com"] });
});

test("someone who only watched has not written, even when other agents did", () => {
  const chat = { users, thread: { events: [msg("cust-1"), msg("bob@x.com")] } };
  assert.deepEqual(agentWroteIn(chat, ["alice@x.com"]), { wrote: false, authors: ["bob@x.com"] });
});

test("whispers to other agents, system events and the customer's own messages do not count", () => {
  const chat = { users, thread: { events: [
    msg("cust-1"),
    msg("alice@x.com", { visibility: "agents" }),
    { type: "system_message", author_id: "alice@x.com" },
    { type: "annotation", author_id: "alice@x.com" },
  ] } };
  assert.deepEqual(agentWroteIn(chat, ["alice@x.com"]), { wrote: false, authors: [] });
});

test("ids are compared without regard to case, and any of the agent's ids matches; files and rich messages count", () => {
  const chat = { users, thread: { events: [{ type: "file", author_id: "ALICE@X.COM" }] } };
  assert.equal(agentWroteIn(chat, ["some-uuid", "alice@x.com"]).wrote, true);
  assert.equal(agentWroteIn({ users, thread: { events: [{ type: "rich_message", author_id: "alice@x.com" }] } }, ["alice@x.com"]).wrote, true);
  assert.deepEqual(agentWroteIn({}, ["alice@x.com"]), { wrote: false, authors: [] }, "an empty reply is simply not written");
});

function fakeLiveChat(t, { token = "tok", info = { account_id: "alice@x.com", client_id: "client-1" }, chat }) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      return String(options.headers.Authorization) === `Bearer ${token}` ? { ok: true, json: async () => info } : { ok: false, json: async () => ({ error: "invalid" }) };
    }
    if (url.endsWith("/agent/action/get_chat")) {
      calls.push({ auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => chat };
    }
    throw new Error("unexpected " + url);
  };
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  return calls;
}
const call = async (body, env = { LIVECHAT_CLIENT_ID: "client-1" }) => JSON.parse((await handler({ body: JSON.stringify(body), env })).body);

test("asks LiveChat for that exact thread with the account's own credential and answers wrote/authors", async (t) => {
  const calls = fakeLiveChat(t, { chat: { users, thread: { events: [msg("cust-1"), msg("alice@x.com")] } } });
  const out = await call({ accountKey: "lc1", agentToken: "tok", chatId: "CHAT", threadId: "THREAD" });
  assert.deepEqual(out, { ok: true, wrote: true, authors: ["alice@x.com"], me: ["alice@x.com"] });
  assert.deepEqual(calls, [{ auth: "Basic pat-1", body: { chat_id: "CHAT", thread_id: "THREAD" } }]);
  const lc2 = await call({ accountKey: "lc2", agentToken: "tok", chatId: "CHAT", threadId: "THREAD" }, { LIVECHAT_CLIENT_ID_2: "client-1" });
  assert.equal(calls.at(-1).auth, "Basic pat-2");
  assert.equal(lc2.ok, true);
});

test("refuses a bad login, another account's login and missing details without asking LiveChat about the chat", async (t) => {
  const calls = fakeLiveChat(t, { chat: { users, thread: { events: [] } } });
  assert.equal((await call({ accountKey: "lc1", agentToken: "nope", chatId: "C", threadId: "T" })).loginExpired, true);
  assert.equal((await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" }, { LIVECHAT_CLIENT_ID: "someone-else" })).loginExpired, true);
  assert.equal((await call({ accountKey: "lc1", agentToken: "tok", chatId: "C" })).ok, false);
  assert.equal((await call({ accountKey: "lc9", agentToken: "tok", chatId: "C", threadId: "T" })).ok, false);
  assert.equal(calls.length, 0);
});

test("a LiveChat error is reported as not ok, never as 'did not write'", async (t) => {
  fakeLiveChat(t, { chat: { error: { message: "Chat not found" } } });
  const out = await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" });
  assert.equal(out.ok, false);
  assert.equal(out.wrote, undefined);
  assert.match(out.error, /Chat not found/);
});
