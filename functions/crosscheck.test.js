import test from "node:test";
import assert from "node:assert/strict";
import { handler, chatsWithWriters, larkTime, resetQaCache } from "./crosscheck.js";
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
    archived("T6", [msg("alice@x.com"), { type: "file", author_id: "alice@x.com" }]),
  ] };
  const stats = {};
  const chats = chatsWithWriters(archive, stats);
  assert.equal(stats.outreach, 1, "T6: only the agent wrote (what a Blast looks like) -- left out and counted");
  assert.deepEqual(chats.map((c) => [c.threadId, c.writers.join("+")]), [["T1", "alice@x.com+bob@x.com"], ["T5", "alice@x.com"]]);
  assert.equal(chats[0].customer, "Abang Zimito");
  assert.equal(chats[0].chatId, "CHAT-T1");
  assert.equal(chats[0].date, Date.parse("2026-10-08T00:55:00.000000Z"));
});

test("without SCAN_KEY and without the Agent Logins table the endpoint does not exist; a wrong or missing key is refused and nothing is read", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.equal((await call({ step: "recorded" }, { env: { ...ENV, SCAN_KEY: "", LARK_TABLE_AGENT_LOGINS: "" } })).status, 404);
  assert.equal((await call({ step: "recorded" }, { key: "nope" })).status, 401);
  assert.equal((await call({ step: "recorded" }, { key: null })).status, 401);
  assert.equal(w.log.searches.length, 0);
});

// LiveChat's account endpoints and the tracker (Agent Logins) rows, on top of the world() fake.
function withLiveChatLogins(w, { accounts }) {
  const inner = globalThis.fetch;
  w.log.accountCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url === "https://accounts.livechat.com/v2/info") {
      w.log.accountCalls += 1;
      const token = String(options.headers?.Authorization || "").replace("Bearer ", "");
      const who = accounts[token];
      return who ? { ok: true, json: async () => ({ account_id: who.login, email: who.email, client_id: "client-1" }) } : { ok: false, json: async () => ({ error: "invalid" }) };
    }
    return inner(url, options);
  };
}
const tracker = (...rows) => rows.map(([email, role, login = ""]) => ({ record_id: "t" + email, fields: { "Livechat Email": email, "LiveChat Login": login, ...(role ? { Role: role } : {}) } }));
const asLogin = (token, env = ENV) => ({ key: null, env, headers: { "x-livechat-account": "lc1", "x-livechat-token": token } });

test("a LiveChat sign-in marked QA in the tracker may read, never write; anyone else is refused, and the scan key still does everything", async (t) => {
  const w = world({ caPages: [[caRow("https://my.livechatinc.com/chats/CHAT/THREADNEW", 2000)]], loginItems: tracker(["qa@x.com", "QA"], ["agent@x.com", ""], ["both@x.com", "Lead, QA"], ["byid@x.com", "qa", "login-by-id"]) });
  withLiveChatLogins(w, { accounts: { "tok-qa": { login: "u1", email: "QA@x.com" }, "tok-agent": { login: "u2", email: "agent@x.com" }, "tok-both": { login: "u3", email: "both@x.com" }, "tok-id": { login: "login-by-id", email: "" } } });
  t.after(w.restore);
  resetQaCache();
  const env = { ...ENV, LIVECHAT_CLIENT_ID: "client-1" };
  const send = async (body, token, key = null) => {
    initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
    const res = await handler({ body: JSON.stringify(body), env, headers: key ? { "x-scan-key": key } : { "x-livechat-account": "lc1", "x-livechat-token": token } });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  assert.equal((await send({ step: "recorded", fromMs: 1000 }, "tok-qa")).threads[0], "THREADNEW", "marked QA: the email in the tracker matches whatever the letter case");
  assert.equal((await send({ step: "agents" }, "tok-both")).ok, true, "a Role cell with several values counts when one of them is QA");
  assert.equal((await send({ step: "agents" }, "tok-id")).ok, true, "a row can name the LiveChat login instead of the email");
  const notQa = await send({ step: "recorded" }, "tok-agent");
  assert.equal(notQa.status, 403);
  assert.match(notQa.error, /not marked QA/);
  assert.equal((await send({ step: "recorded" }, "tok-nobody")).status, 401, "a token LiveChat does not know");
  assert.equal((await send({ step: "recorded" }, "")).status, 401, "no sign-in and no key");
  for (const step of ["write", "existing"]) assert.equal((await send({ step, entries: [{ threadId: "T1", email: "a@x.com" }] }, "tok-qa")).status, 403);
  assert.equal(w.log.created.length, 0, "nothing was written by a QA sign-in");
  assert.equal((await send({ step: "write", entries: [{ threadId: "T1", email: "a@x.com" }] }, "", "scan-secret")).created, 1, "the admin key still writes");
  const before = w.log.accountCalls;
  await send({ step: "agents" }, "tok-qa");
  await send({ step: "agents" }, "tok-qa");
  assert.equal(w.log.accountCalls, before, "a sign-in already checked is not asked of LiveChat again for every step of a scan");
});

test("a login for the wrong LiveChat account or an unknown account name is refused before the tracker is read", async (t) => {
  const w = world({ loginItems: tracker(["qa@x.com", "QA"]) });
  withLiveChatLogins(w, { accounts: { "tok-qa": { login: "u1", email: "qa@x.com" } } });
  t.after(w.restore);
  resetQaCache();
  const env = { ...ENV, LIVECHAT_CLIENT_ID: "other-client" };
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  const wrong = await handler({ body: JSON.stringify({ step: "agents" }), env, headers: { "x-livechat-account": "lc1", "x-livechat-token": "tok-qa" } });
  assert.equal(wrong.statusCode, 401);
  assert.match(JSON.parse(wrong.body).error, /different account/);
  const unknown = await handler({ body: JSON.stringify({ step: "agents" }), env, headers: { "x-livechat-account": "lc9", "x-livechat-token": "tok-qa" } });
  assert.equal(unknown.statusCode, 401);
});
test("logged: the rows agents logged in the window, with what QA compares and never the date of birth or claim secret; QA may read it", async (t) => {
  const row = (createdAt, fields) => ({ record_id: "r" + createdAt, created_time: createdAt, fields });
  const w = world({ caPages: [
    [row(2000, { Username: "player1", Brand: "VS96", "Agent Name": "96 Alice", Inquiry: ["Free Spin"], Status: "Done", "Released amount": 30, link: { link: "https://my.livechatinc.com/archives/THREADA", text: "chat" }, "Player D.O.B": 946684800000, "Claim Secret": true }),
     row(500, { Username: "too-old", "Agent Name": "96 Alice" })],
    [row(3000, { Username: "player2", "Agent Name": "96 Bob" }), row(9000, { Username: "too-new", "Agent Name": "96 Bob" })],
  ], loginItems: tracker(["qa@x.com", "QA"]) });
  withLiveChatLogins(w, { accounts: { "tok-qa": { login: "u1", email: "qa@x.com" } } });
  t.after(w.restore);
  resetQaCache();
  const env = { ...ENV, LIVECHAT_CLIENT_ID: "client-1" };
  initLarkEnv(env); initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  const ask = async (body) => JSON.parse((await handler({ body: JSON.stringify(body), env, headers: { "x-livechat-account": "lc1", "x-livechat-token": "tok-qa" } })).body);
  const first = await ask({ step: "logged", fromMs: 1000, toMs: 5000, pageToken: "" });
  assert.equal(first.ok, true);
  assert.equal(first.rows.length, 1, "the row before the window is left out");
  assert.deepEqual(first.rows[0], { recordId: "r2000", createdAt: 2000, agent: "96 Alice", username: "player1", brand: "VS96", inquiry: ["Free Spin"], status: "Done", amount: 30, telegram: false, link: "https://my.livechatinc.com/archives/THREADA", threadId: "THREADA" });
  assert.equal(first.next, "1");
  assert.equal(first.scanned, 2);
  const second = await ask({ step: "logged", fromMs: 1000, toMs: 5000, pageToken: "1" });
  assert.deepEqual(second.rows.map((r) => r.username), ["player2"], "the row after the window is left out");
  assert.equal(second.next, "");
  assert.ok(!JSON.stringify([first, second]).includes("946684800000") && !/claimSecret|dob/i.test(JSON.stringify([first, second])));
});

test("lastusername: the player a chat's customer was last recorded under, found by the stable chat id in any brand; nothing found is not an error", async (t) => {
  const w = world();
  t.after(w.restore);
  const searches = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/tables/pnl-table/records/search")) {
      const conditions = JSON.parse(options.body).filter?.conditions || [];
      searches.push(conditions);
      const link = conditions.find((c) => c.operator === "contains");
      const rows = [{ record_id: "p1", fields: { Username: "player-one", Brand: "VS96", "Live Chat link": { link: "https://my.livechatinc.com/chats/CHATKNOWN/THREADOLD", text: "chat" } } }];
      const items = link.field_name === "Live Chat link" ? rows.filter((r) => JSON.stringify(r.fields["Live Chat link"]).includes(link.value[0])) : [];
      return { json: async () => ({ code: 0, data: { items, has_more: false } }) };
    }
    return inner(url, options);
  };
  const env = { ...ENV, LARK_TABLE_PNL: "pnl-table" };
  const found = await call({ step: "lastusername", chatId: "CHATKNOWN" }, { env });
  assert.deepEqual([found.ok, found.found, found.username, found.brand], [true, true, "player-one", "VS96"]);
  assert.ok(searches.every((conditions) => !conditions.some((c) => c.field_name === "Brand")), "no brand is asked for: the QA page only has the chat id");
  const none = await call({ step: "lastusername", chatId: "CHATNEW" }, { env });
  assert.deepEqual([none.ok, none.found, none.username], [true, false, ""]);
  assert.equal((await call({ step: "lastusername" }, { env })).status, 400);
  assert.equal((await call({ step: "lastusername", chatId: "x".repeat(81) }, { env })).status, 400);
  const noTable = await call({ step: "lastusername", chatId: "CHATKNOWN" }, { env: { ...ENV, LARK_TABLE_PNL: "" } });
  assert.deepEqual([noTable.ok, noTable.found], [true, false], "without the P&L table nothing is known, not an error");
});

test("chatlog: every agent's rows for ONE chat (exact thread id, oldest first) and every Unknown tick on it, without date of birth or claim secret", async (t) => {
  const row = (createdAt, link, fields = {}) => ({ record_id: "r" + createdAt, created_time: createdAt, fields: { link: { link, text: "chat" }, "Claim Secret": true, "Player D.O.B": 946684800000, ...fields } });
  const w = world({ caPages: [[
    row(3000, "https://my.livechatinc.com/archives/THREADX", { Username: "player1", Brand: "VS96", "Agent Name": "96 Bob", Inquiry: ["Free Spin"], Status: "Done", "Released amount": 5 }),
    row(1000, "https://my.livechatinc.com/chats/CHAT9/THREADX", { Username: "player1", "Agent Name": "96 Alice" }),
    row(2000, "https://my.livechatinc.com/archives/THREADXY", { Username: "other chat", "Agent Name": "96 Alice" }),
    row(4000, "https://my.livechatinc.com/archives/OTHER", { Username: "unrelated" }),
  ]] });
  t.after(w.restore);
  const kv = {
    store: new Map([["t:THREADX:96 carl", { metadata: { threadId: "THREADX", chatId: "CHAT9", agent: "96 Carl", source: "manual", at: 5000 } }], ["t:THREADY:96 dan", { metadata: { threadId: "THREADY", agent: "96 Dan" } }], ["meta:since", { value: "777" }]]),
    async list({ prefix }) { return { keys: [...this.store.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }; },
    async get(key) { return this.store.get(key)?.value ?? null; },
  };
  const env = { ...ENV, UNKNOWN_TICKS: kv };
  const found = await call({ step: "chatlog", threadId: "THREADX" }, { env });
  assert.equal(found.ok, true);
  assert.deepEqual(found.rows.map((r) => [r.agent, r.username, r.createdAt]), [["96 Alice", "player1", 1000], ["96 Bob", "player1", 3000]], "only THREADX (not THREADXY), oldest first");
  assert.deepEqual(found.rows[1], { recordId: "r3000", createdAt: 3000, agent: "96 Bob", username: "player1", brand: "VS96", inquiry: ["Free Spin"], status: "Done", amount: 5, telegram: false, link: "https://my.livechatinc.com/archives/THREADX", threadId: "THREADX" });
  assert.deepEqual(found.ticks.map((x) => x.agent), ["96 Carl"], "only the ticks of this chat");
  assert.deepEqual(found.tracking, { configured: true, since: 777 });
  assert.ok(!/946684800000|claimSecret|dob/i.test(JSON.stringify(found)));
  const none = await call({ step: "chatlog", threadId: "NOTHINGHERE" }, { env });
  assert.deepEqual([none.ok, none.rows, none.ticks], [true, [], []]);
  const unbound = await call({ step: "chatlog", threadId: "THREADX" });
  assert.deepEqual([unbound.ticks, unbound.tracking], [[], { configured: false, since: 0 }], "without the KV binding there are no ticks, and it says so");
  for (const bad of ["", "ab", "has space", "x".repeat(65), "../etc"]) assert.equal((await call({ step: "chatlog", threadId: bad }, { env })).status, 400);
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
  // A later page is asked for by its id ALONE: LiveChat refuses page_id together with filters, limit or sort_order.
  await call({ step: "archives", account: "lc2", from: Date.UTC(2026, 9, 7), to: Date.UTC(2026, 9, 8), pageId: "P2" });
  assert.deepEqual(w.log.archivesBodies[1], { auth: "Basic pat-2", body: { page_id: "P2" } });
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

test("the Unrecorded Chats table is needed only by the steps that use it: with it gone (deleted) the scan steps still work", async (t) => {
  const w = world({ archivesReply: { chats: [] } });
  t.after(w.restore);
  const env = { ...ENV, LARK_TABLE_UNRECORDED: "" };
  for (const step of ["existing", "write"]) assert.match((await call({ step, entries: [] }, { env })).error, /LARK_TABLE_UNRECORDED/);
  assert.equal((await call({ step: "recorded", fromMs: 1 }, { env })).ok, true);
  assert.equal((await call({ step: "agents" }, { env })).ok, true);
  assert.equal((await call({ step: "logged", fromMs: 1 }, { env })).ok, true);
  const archives = await call({ step: "archives", account: "lc1", from: 1, to: 2 }, { env });
  assert.equal(archives.ok, true, "listing the archives never touches the table");
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

test("archives and chat report how many outreach-only threads (the customer never wrote, e.g. a Blast) they left out", async (t) => {
  const blast = archived("TB", [msg("alice@x.com"), { type: "file", author_id: "alice@x.com" }]);
  const real = archived("TR", [msg("cust-1"), msg("alice@x.com")]);
  const w = world({ archivesReply: { chats: [blast, real] } });
  t.after(w.restore);
  const out = await call({ step: "archives", account: "lc1", from: 1, to: 2 });
  assert.deepEqual(out.chats.map((c) => c.threadId), ["TR"]);
  assert.equal(out.outreach, 1);
});

test("each chat comes with how many messages each writer and the customer wrote (notes between agents do not count)", () => {
  const archive = { chats: [archived("TC", [msg("cust-1"), msg("alice@x.com"), msg("alice@x.com"), msg("bob@x.com"), msg("cust-1"), msg("alice@x.com", { visibility: "agents" })])] };
  const [chat] = chatsWithWriters(archive);
  assert.deepEqual(chat.counts, { "alice@x.com": 2, "bob@x.com": 1 });
  assert.equal(chat.customerMessages, 2);
});
