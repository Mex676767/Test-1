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

function fakeLiveChat(t, { token = "tok", info = { account_id: "alice@x.com", client_id: "client-1" }, chat, accounts }) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  const accountCalls = [];
  calls.accountCalls = accountCalls;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      return String(options.headers.Authorization) === `Bearer ${token}` ? { ok: true, json: async () => info } : { ok: false, json: async () => ({ error: "invalid" }) };
    }
    if (url.includes("accounts.livechat.com/v2/accounts/")) {
      accountCalls.push({ url, auth: options.headers.Authorization });
      return accounts ? accounts(url, options.headers.Authorization) : { ok: false, json: async () => ({ error: { message: "missing scope" } }) };
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
  assert.deepEqual([...calls], [{ auth: "Basic pat-1", body: { chat_id: "CHAT", thread_id: "THREAD" } }]);
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

// LiveChat's login id is a UUID, but a chat marks an agent's messages with their email (seen on a real chat).
const uuidInfo = (id) => ({ account_id: id, client_id: "client-1" });
const chatBy = (...authors) => ({ users, thread: { events: [msg("cust-1"), ...authors.map((a) => msg(a))] } });

test("a UUID login is matched through the email LiveChat returns for the agent's own token", async (t) => {
  const calls = fakeLiveChat(t, {
    info: uuidInfo("uuid-own-token"), chat: chatBy("alice@x.com"),
    accounts: () => ({ ok: true, json: async () => ({ account_id: "uuid-own-token", email: "Alice@X.com" }) }),
  });
  const out = await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" });
  assert.equal(out.wrote, true);
  assert.equal(out.emailLookup, "own token");
  assert.deepEqual(out.me, ["uuid-own-token", "alice@x.com"]);
  assert.deepEqual(calls.accountCalls, [{ url: "https://accounts.livechat.com/v2/accounts/me", auth: "Bearer tok" }]);
});

test("when the agent's own token cannot read the account, the account's PAT is tried; the answer is remembered", async (t) => {
  const calls = fakeLiveChat(t, {
    info: uuidInfo("uuid-pat"), chat: chatBy("bob@x.com"),
    accounts: (url) => url.endsWith("/me") ? { ok: false, json: async () => ({ error: { message: "missing scope" } }) } : { ok: true, json: async () => ({ email: "alice@x.com" }) },
  });
  const first = await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" });
  assert.equal(first.wrote, false, "Bob wrote, Alice only watched");
  assert.equal(first.emailLookup, "PAT");
  assert.deepEqual(calls.accountCalls.map((c) => c.auth), ["Bearer tok", "Basic pat-1"]);
  assert.match(calls.accountCalls[1].url, /\/v2\/accounts\/uuid-pat$/);
  await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" });
  assert.equal(calls.accountCalls.length, 2, "the email is remembered, LiveChat is not asked again");
});

test("with no way to read the email the answer is unknown (null), never 'did not write'", async (t) => {
  fakeLiveChat(t, { info: uuidInfo("uuid-no-email"), chat: chatBy("alice@x.com") });
  const out = await call({ accountKey: "lc1", agentToken: "tok", chatId: "C", threadId: "T" });
  assert.equal(out.ok, true);
  assert.equal(out.wrote, null);
  assert.deepEqual(out.authors, ["alice@x.com"]);
  assert.match(out.error, /Could not read your LiveChat email \(own token: missing scope; PAT: missing scope\)/);
});
