import test from "node:test";
import assert from "node:assert/strict";
import { handler, chatsWithWriters, larkTime } from "./crosscheck.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

const ENV = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base",
  LARK_TABLE_CUSTOMER_APPROACHING: "ca-table", LARK_TABLE_UNRECORDED: "unrec-table", LARK_TABLE_AGENT_LOGINS: "logins-table", SCAN_KEY: "scan-secret",
};
const customer = { id: "cust-1", type: "customer", name: "Abang Zimito" };
const agents = [{ id: "alice@x.com", type: "agent" }, { id: "bob@x.com", type: "agent" }];
const msg = (author_id, extra = {}) => ({ type: "message", author_id, text: "hi", created_at: "2026-10-08T01:00:00.000000Z", ...extra });
const archived = (threadId, events, { active = false, users = [customer, ...agents] } = {}) =>
  ({ id: "CHAT-" + threadId, users, thread: { id: threadId, active, created_at: "2026-10-08T00:55:00.000000Z", events } });

// A tiny fake of Lark (CA table pages, the Unrecorded table, create) and LiveChat's list_archives.
function world({ caPages = [[]], unrecItems = [], loginItems = [], archivesReply = { chats: [] } } = {}) {
  const log = { created: [], archivesBodies: [], searches: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.includes("/tables/ca-table/records/search")) {
      const token = new URL(url).searchParams.get("page_token");
      const index = token ? Number(token) : 0;
      log.searches.push({ table: "ca", body: JSON.parse(options.body) });
      return { json: async () => ({ code: 0, data: { items: caPages[index], has_more: index + 1 < caPages.length, page_token: String(index + 1) } }) };
    }
    if (url.includes("/tables/logins-table/records/search")) return { json: async () => ({ code: 0, data: { items: loginItems, has_more: false } }) };
    if (url.includes("/tables/unrec-table/records/search")) return { json: async () => ({ code: 0, data: { items: unrecItems, has_more: false } }) };
    if (url.includes("/tables/unrec-table/records") && options.method === "POST") {
      const fields = JSON.parse(options.body).fields;
      if (fields["Thread ID"] === "BAD") return { json: async () => ({ code: 1254000, msg: "boom" }) };
      log.created.push(fields);
      return { json: async () => ({ code: 0, data: { record: { record_id: "rec" + log.created.length, fields } } }) };
    }
    if (url.endsWith("/agent/action/list_archives")) {
      log.archivesBodies.push({ auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => archivesReply };
    }
    throw new Error("unexpected " + url);
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, { key = "scan-secret", env = ENV } = {}) => {
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  const res = await handler({ body: JSON.stringify(body), env, headers: key === null ? {} : { "x-scan-key": key } });
  return { status: res.statusCode, ...JSON.parse(res.body) };
};
const caRow = (link, createdAt, agent) => ({ record_id: "r" + createdAt, created_time: createdAt, fields: { link: link ? { link, text: "chat" } : undefined, ...(agent ? { "Agent Name": agent } : {}) } });

test("larkTime writes the microsecond format LiveChat asks for", () => {
  assert.equal(larkTime(Date.UTC(2026, 9, 7, 0, 0, 0)), "2026-10-07T00:00:00.000000+00:00");
});

test("only ended chats an agent wrote in are listed, with the agents (not bots or the customer) who wrote", () => {
  const archive = { chats: [
    archived("T1", [msg("cust-1"), msg("alice@x.com"), msg("bob@x.com")]),
    archived("T2", [msg("cust-1"), msg("alice@x.com")], { active: true }),
    archived("T3", [msg("cust-1")]),
    archived("T4", [msg("cust-1"), msg("alice@x.com", { visibility: "agents" })]),
    archived("T5", [msg("cust-1"), msg("chatbot-id"), msg("alice@x.com")]),
  ] };
  const chats = chatsWithWriters(archive);
  assert.deepEqual(chats.map((c) => [c.threadId, c.writers.join("+")]), [["T1", "alice@x.com+bob@x.com"], ["T5", "alice@x.com"]]);
  assert.equal(chats[0].customer, "Abang Zimito");
  assert.equal(chats[0].chatId, "CHAT-T1");
  assert.equal(chats[0].date, Date.parse("2026-10-08T00:55:00.000000Z"));
});

test("without SCAN_KEY the endpoint does not exist; a wrong or missing key is refused and nothing is read", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.equal((await call({ step: "recorded" }, { env: { ...ENV, SCAN_KEY: "" } })).status, 404);
  assert.equal((await call({ step: "recorded" }, { key: "nope" })).status, 401);
  assert.equal((await call({ step: "recorded" }, { key: null })).status, 401);
  assert.equal(w.log.searches.length, 0);
});

test("recorded: the thread ids of Customer Approaching rows created since the start date, from the link, page by page", async (t) => {
  const w = world({ caPages: [
    [caRow("https://my.livechatinc.com/chats/CHAT/THREADNEW", 2000), caRow("https://my.livechatinc.com/chats/CHAT/THREADOLD", 500), caRow("", 2500)],
    [caRow("https://my.livechatinc.com/archives/THREADARCH", 3000)],
  ] });
  t.after(w.restore);
  const first = await call({ step: "recorded", fromMs: 1000, pageToken: "" });
  assert.deepEqual(first.threads, ["THREADNEW"]);
  assert.equal(first.next, "1");
  assert.equal(first.rows, 3);
  const second = await call({ step: "recorded", fromMs: 1000, pageToken: "1" });
  assert.deepEqual(second.threads, ["THREADARCH"]);
  assert.equal(second.next, "");
  assert.deepEqual(w.log.searches[0].body.filter.conditions, [], "the whole table, no filter");
});

test("archives: asks the account's own credential for the window, oldest first, and answers with the chats worth judging", async (t) => {
  const w = world({ archivesReply: { chats: [archived("T1", [msg("cust-1"), msg("alice@x.com")]), archived("T3", [msg("cust-1")])], next_page_id: "P2", found_chats: 2 } });
  t.after(w.restore);
  const out = await call({ step: "archives", account: "lc2", from: Date.UTC(2026, 9, 7), to: Date.UTC(2026, 9, 8), pageId: "" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chats.map((c) => c.threadId), ["T1"]);
  assert.equal(out.next, "P2");
  assert.equal(out.seen, 2);
  assert.deepEqual(w.log.archivesBodies, [{ auth: "Basic pat-2", body: { filters: { from: "2026-10-07T00:00:00.000000+00:00", to: "2026-10-08T00:00:00.000000+00:00" }, limit: 100, sort_order: "asc" } }]);
  const unknown = await call({ step: "archives", account: "lc9", from: 1, to: 2 });
  assert.match(unknown.error, /not configured/);
});

test("archives: an ended chat that came without its messages is handed back as pending, not silently skipped; an active one is not", async (t) => {
  const noEvents = { id: "CHAT-X", users: [customer], thread: { id: "TX", active: false } };
  const stillOpen = { id: "CHAT-Y", users: [customer], thread: { id: "TY", active: true } };
  const w = world({ archivesReply: { chats: [noEvents, stillOpen] } });
  t.after(w.restore);
  const out = await call({ step: "archives", account: "lc1", from: 1, to: 2 });
  assert.deepEqual(out.pending, [{ chatId: "CHAT-X", threadId: "TX" }]);
  assert.deepEqual(out.chats, []);
});

test("chat: a pending chat is fetched on its own with the account's credential and judged like any other", async (t) => {
  const calls = [];
  const w = world();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/agent/action/get_chat")) {
      calls.push({ auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ id: "CHAT-X", users: [customer, ...agents], thread: { id: "TX", active: false, created_at: "2026-10-08T00:55:00.000000Z", events: [msg("cust-1"), msg("bob@x.com")] } }) };
    }
    return inner(url, options);
  };
  t.after(w.restore);
  const out = await call({ step: "chat", account: "lc2", chatId: "CHAT-X", threadId: "TX" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chat.writers, ["bob@x.com"]);
  assert.equal(out.chat.threadId, "TX");
  assert.deepEqual(calls, [{ auth: "Basic pat-2", body: { chat_id: "CHAT-X", thread_id: "TX" } }]);
  assert.equal((await call({ step: "chat", account: "lc1", chatId: "", threadId: "TX" })).status, 400);
});

test("chat: a LiveChat error is reported, never turned into 'nobody wrote'", async (t) => {
  const w = world();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => String(url).endsWith("/agent/action/get_chat") ? { ok: true, json: async () => ({ error: { message: "Chat not found" } }) } : inner(url, options);
  t.after(w.restore);
  const out = await call({ step: "chat", account: "lc1", chatId: "C", threadId: "T" });
  assert.equal(out.ok, false);
  assert.match(out.error, /Chat not found/);
});

test("existing: the thread|email keys already in the table, so a re-run adds no twins", async (t) => {
  const w = world({ unrecItems: [{ record_id: "u1", fields: { "Thread ID": "T1", "Writer Email": "Alice@X.com" } }] });
  t.after(w.restore);
  assert.deepEqual((await call({ step: "existing" })).keys, ["T1|alice@x.com"]);
});

test("write: creates Open rows with lowercase emails, at most 25 per call, and reports the ones that fail", async (t) => {
  const w = world();
  t.after(w.restore);
  const entry = (n) => ({ threadId: "T" + n, chatId: "C" + n, account: "lc1", email: "Alice@X.com", date: 5, customer: "Zimito" });
  const out = await call({ step: "write", entries: [entry(1), { threadId: "BAD", email: "a@x.com" }, { threadId: "", email: "a@x.com" }, entry(2)] });
  assert.equal(out.created, 2);
  assert.equal(out.failed.length, 2);
  assert.deepEqual(w.log.created[0], { "Thread ID": "T1", "Chat ID": "C1", "LiveChat Account": "lc1", "Writer Email": "alice@x.com", "Chat Date": 5, Customer: "Zimito", Status: "Open" });
  const many = await call({ step: "write", entries: Array.from({ length: 40 }, (_, i) => entry(100 + i)) });
  assert.equal(many.created, 25);
});

test("the Unrecorded Chats table must be configured for every step except recorded", async (t) => {
  const w = world();
  t.after(w.restore);
  const env = { ...ENV, LARK_TABLE_UNRECORDED: "" };
  assert.match((await call({ step: "existing" }, { env })).error, /LARK_TABLE_UNRECORDED/);
  assert.equal((await call({ step: "recorded", fromMs: 1 }, { env })).ok, true);
});

test("recorded: also gives 'thread|agent name' pairs (lower case), so a chat can be judged per agent", async (t) => {
  const w = world({ caPages: [[caRow("https://my.livechatinc.com/chats/CHAT/T-A", 2000, "96 Mexha - VIP RTN"), caRow("https://my.livechatinc.com/chats/CHAT/T-B", 2100), caRow("https://my.livechatinc.com/chats/CHAT/T-OLD", 5, "Old Agent")]] });
  t.after(w.restore);
  const out = await call({ step: "recorded", fromMs: 1000 });
  assert.deepEqual(out.pairs, ["T-A|96 mexha - vip rtn"]);
  assert.deepEqual(out.threads.sort(), ["T-A", "T-B"], "a row without an agent still marks the chat recorded");
});

test("agents: which LiveChat email is which agent name, only for logins whose email is filled in", async (t) => {
  const login = (email, name, account) => ({ record_id: "x" + name, fields: { "Livechat Email": email, "Agent Name": name, "LiveChat Account": account } });
  const w = world({ loginItems: [login("Mexha@X.com", "96 Mexha", "lc1"), login("", "96 Teh", "lc1"), login("bob@x.com", "96 Bob", "lc2")] });
  t.after(w.restore);
  const out = await call({ step: "agents" });
  assert.deepEqual(out.agents, [{ email: "mexha@x.com", name: "96 Mexha", account: "lc1" }, { email: "bob@x.com", name: "96 Bob", account: "lc2" }]);
  const none = await call({ step: "agents" }, { env: { ...ENV, LARK_TABLE_AGENT_LOGINS: "" } });
  assert.deepEqual(none.agents, []);
});
