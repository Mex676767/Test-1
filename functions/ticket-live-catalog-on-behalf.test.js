import assert from "node:assert/strict";
import test from "node:test";
import { handler as configHandler, resetTicketConfigCache } from "./ticket-config.js";
import { handler as createHandler } from "./ticket-create.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";
import { pickTicketEmail, parseTicketEmailRows } from "./_lib/ticket-email.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const withFetch = async (impl, run) => { const original = globalThis.fetch; globalThis.fetch = impl; try { return await run(); } finally { globalThis.fetch = original; } };
const reset = () => { resetTicketConfigCache(); resetTicketRateLimit(); resetTicketReadCache(); };
const env = { TICKETS_API_KEY: "k" };

const TICKETS = { ok: true, fields: [{ key: "status", label: "Status", type: "SELECT", isActive: true }, { key: "remarks", label: "Remarks", type: "LONGTEXT", isActive: true }], tickets: [{ ref: "TK1", fields: { status: "OPEN" } }] };
const LIVE = {
  markets: { ok: true, markets: [{ id: 1, code: "BDT", label: "Bangladesh", currency: "BDT" }, { id: 3, code: "WOWMYR", label: "WOW88 Malaysia", currency: "MYR" }] },
  departments: { ok: true, departments: [{ id: 2, code: "CS", name: "Customer Service", receivesTickets: true }, { id: 9, code: "OLD", name: "Closed Desk", receivesTickets: false }] },
  choices: { ok: true, fields: [{ key: "status", label: "Status", type: "SELECT", isActive: true, choices: [{ value: "OPEN", label: "Open", isActive: true }, { value: "ON_HOLD", label: "On hold", isActive: false }] }] },
};
const world = (overrides = {}) => async (url) => {
  const path = new URL(String(url)).pathname.replace("/api/v1", "");
  if (path === "/tickets") return reply(TICKETS);
  const body = overrides[path.slice(1)] !== undefined ? overrides[path.slice(1)] : (path === "/markets" ? LIVE.markets : path === "/departments" ? LIVE.departments : LIVE.choices);
  return body instanceof Response ? body : reply(body);
};
const config = async () => JSON.parse((await configHandler({ httpMethod: "GET", env, queryStringParameters: { fresh: "1" } })).body);

test("the lists come live from the ticket system: real ids, labels, retired choices flagged, departments that cannot receive tickets left out", async () => {
  reset();
  await withFetch(world(), async () => {
    const body = await config();
    assert.deepEqual(body.catalogSource, { departments: "live", markets: "live", choices: "live" });
    assert.deepEqual(body.departments, [{ id: 2, code: "CS", name: "Customer Service" }]);
    assert.deepEqual(body.markets, [{ id: 1, code: "BDT", label: "Bangladesh", currency: "BDT" }, { id: 3, code: "WOWMYR", label: "WOW88 Malaysia", currency: "MYR" }]);
    const status = body.fields.find((field) => field.key === "status");
    assert.deepEqual(status.options, [{ value: "OPEN", label: "Open", isActive: true }, { value: "ON_HOLD", label: "On hold", isActive: false }]);
    assert.equal("options" in body.fields.find((field) => field.key === "remarks"), false);
  });
});

test("one list failing falls back to the snapshot for that list only", async () => {
  reset();
  await withFetch(world({ markets: new Response("nope", { status: 404 }) }), async () => {
    const body = await config();
    assert.deepEqual(body.catalogSource, { departments: "live", markets: "snapshot", choices: "live" });
    assert.equal(body.markets.length, 9, "the snapshot's nine markets");
    assert.equal(body.departments.length, 1);
  });
  reset();
  await withFetch(world({ markets: { ok: true }, departments: { ok: true }, "fields/choices": { ok: true } }), async () => {
    const body = await config();
    assert.deepEqual(body.catalogSource, { departments: "snapshot", markets: "snapshot", choices: "snapshot" });
    assert.equal(body.departments.length, 20);
  });
});

const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
function network({ ticketReplies = [] } = {}) {
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.includes("/tickets")) {
      posts.push(options.body);
      const next = ticketReplies.shift();
      return next || reply({ ok: true, id: 1, ref: "TK2610150001" }, 201);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { posts, restore: () => { globalThis.fetch = original; } };
}
const ticketJson = (body) => JSON.parse(typeof body === "string" ? body : body.get("ticket"));
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const createAs = (overrides = {}, bodyExtra = {}, token = "tok-alice") => {
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
  return createHandler({ httpMethod: "POST", env: { ...onEnv, ...overrides }, body: JSON.stringify({ fields: { toDepartment: "CS" }, author: { accountKey: "lc1", agentToken: token }, ...bodyExtra }) });
};

test("on behalf: the verified agent's email goes with the ticket and the answer says who it was raised as", async () => {
  const net = network();
  try {
    const result = await createAs();
    assert.equal(result.statusCode, 201);
    const sent = ticketJson(net.posts[0]);
    assert.equal(sent.onBehalfOf, "alice@x.com");
    assert.deepEqual(sent.fields, { toDepartment: "CS" });
    assert.equal("author" in sent, false, "the agent's token never goes to the ticket system");
    const body = JSON.parse(result.body);
    assert.equal(body.actedAs, "alice@x.com");
    assert.equal("warning" in body, false);
  } finally { net.restore(); }
});

test("on behalf with files: onBehalfOf rides inside the multipart ticket part", async () => {
  const net = network();
  try {
    initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
    const form = new FormData();
    form.append("ticket", JSON.stringify({ fields: { toDepartment: "CS" }, author: { accountKey: "lc1", agentToken: "tok-alice" } }));
    form.append("attachment", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "a.pdf", { type: "application/pdf" }), "a.pdf");
    const result = await createHandler({ httpMethod: "POST", env: onEnv, formData: form, headers: {} });
    assert.equal(result.statusCode, 201);
    assert.ok(net.posts[0] instanceof FormData);
    assert.equal(ticketJson(net.posts[0]).onBehalfOf, "alice@x.com");
    assert.equal(net.posts[0].get("attachment").name, "a.pdf");
  } finally { net.restore(); }
});

test("no ticket-system account for that email: nothing is created, no image is kept, and the agent is asked for their ticket account email", async () => {
  const net = network({ ticketReplies: [reply({ ok: false, error: 'No active account has the email "alice@x.com", so nothing can be done on their behalf.' }, 400)] });
  try {
    const result = await createAs({ TICKETS_AUTHOR_EMAIL_FIELD: "livechat_email" });
    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.equal(body.ok, false);
    assert.equal(body.needTicketEmail, true);
    assert.equal(body.triedEmail, "alice@x.com");
    assert.equal(body.error, "Ticket account not found. Please enter your ticket account email.");
    assert.equal(net.posts.length, 1, "no second attempt under the integration account");
  } finally { net.restore(); }
});

test("an agent whose LiveChat gives no email is asked for their ticket email before anything is sent", async () => {
  TOKENS["tok-noemail"] = { account_id: "uuid-noemail", client_id: "c1" };
  const net = network();
  try {
    const result = await createAs({}, {}, "tok-noemail");
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).needTicketEmail, true);
    assert.equal(net.posts.length, 0);
  } finally { net.restore(); delete TOKENS["tok-noemail"]; }
});

test("the email the agent typed is used, and saved on their row once so they are not asked again", async () => {
  const net = network({ ticketReplies: [reply({ ok: true, id: 5, ref: "TK2610150005" }, 201)] });
  const inner = globalThis.fetch;
  const larkEnv = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table" };
  const table = [{ record_id: "rec-1", ...row("lc1", "uuid-alice", "96 Alice") }];
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (String(url).includes("/tables/logins-table/records")) {
      if (options.method && options.method !== "GET") { writes.push({ url: String(url), body: JSON.parse(options.body) }); return { json: async () => ({ code: 0, data: {} }) }; }
      return { json: async () => ({ code: 0, data: { items: table } }) };
    }
    return inner(url, options);
  };
  try {
    initLarkEnv(larkEnv);
    const result = await createAs(larkEnv, { author: { accountKey: "lc1", agentToken: "tok-alice", ticketEmail: "Alice@Company.com" } });
    assert.equal(result.statusCode, 201);
    assert.equal(ticketJson(net.posts[0]).onBehalfOf, "alice@company.com");
    assert.equal(JSON.parse(result.body).actedAs, "alice@company.com");
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith("/records/rec-1"));
    assert.deepEqual(writes[0].body.fields, { "Ticket Email": "alice@company.com" });
  } finally { globalThis.fetch = inner; net.restore(); initLarkEnv({}); }
});

test("an email an admin set in Lark always wins over one typed in the widget, which is neither used nor saved", async () => {
  const net = network({ ticketReplies: [reply({ ok: true, id: 6, ref: "TK2610150006" }, 201)] });
  const inner = globalThis.fetch;
  const larkEnv = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table" };
  const table = [{ record_id: "rec-1", ...row("lc1", "uuid-alice", "96 Alice", "alice@company.com") }];
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (String(url).includes("/tables/logins-table/records")) {
      if (options.method && options.method !== "GET") { writes.push(1); return { json: async () => ({ code: 0, data: {} }) }; }
      return { json: async () => ({ code: 0, data: { items: table } }) };
    }
    return inner(url, options);
  };
  try {
    initLarkEnv(larkEnv);
    const result = await createAs(larkEnv, { author: { accountKey: "lc1", agentToken: "tok-alice", ticketEmail: "boss@company.com" } });
    assert.equal(result.statusCode, 201);
    assert.equal(ticketJson(net.posts[0]).onBehalfOf, "alice@company.com", "never the typed boss@company.com");
    assert.equal(writes.length, 0);
  } finally { globalThis.fetch = inner; net.restore(); initLarkEnv({}); }
});

test("a Ticket Email an admin set that has no ticket account is not something the agent can fix: they are sent to the admin", async () => {
  const net = network({ ticketReplies: [reply({ ok: false, error: 'No active account has the email "alice@company.com", so nothing can be done on their behalf.' }, 400)] });
  const inner = globalThis.fetch;
  const larkEnv = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table" };
  const table = [{ record_id: "rec-1", ...row("lc1", "uuid-alice", "96 Alice", "alice@company.com") }];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (String(url).includes("/tables/logins-table/records")) return { json: async () => ({ code: 0, data: { items: table } }) };
    return inner(url, options);
  };
  try {
    initLarkEnv(larkEnv);
    const result = await createAs(larkEnv);
    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.equal("needTicketEmail" in body, false);
    assert.match(body.error, /Ticket Email saved for you \(alice@company\.com\) has no active ticket account\. Ask your admin/);
  } finally { globalThis.fetch = inner; net.restore(); initLarkEnv({}); }
});

test("on behalf refused because the key may not act for others: nothing is created under the integration account, the agent is told why", async () => {
  const net = network({ ticketReplies: [reply({ ok: false, error: "This API key's role may not act on behalf of other people (api-keys:act-on-behalf)." }, 403)] });
  try {
    const result = await createAs();
    assert.equal(result.statusCode, 403);
    const body = JSON.parse(result.body);
    assert.equal(body.ok, false);
    assert.equal(body.keyNeedsGrant, true);
    assert.match(body.error, /may not act on behalf of other people yet .*api-keys:act-on-behalf.*Nothing was created/);
    assert.equal(net.posts.length, 1, "no second attempt as the key's owner");
  } finally { net.restore(); }
});

test("on behalf refused because the person outranks the key's owner: the message names the account", async () => {
  const net = network({ ticketReplies: [reply({ ok: false, error: '"alice@x.com" outranks the account this API key belongs to, so nothing can be done on their behalf.' }, 403)] });
  try {
    const result = await createAs();
    assert.equal(result.statusCode, 403);
    assert.match(JSON.parse(result.body).error, /Your ticket account \(alice@x\.com\) is senior/);
  } finally { net.restore(); }
});

test("any other refusal is not retried: the agent sees the ticket system's own message", async () => {
  const net = network({ ticketReplies: [reply({ ok: false, error: "Query type is required." }, 400)] });
  try {
    const result = await createAs();
    assert.equal(result.statusCode, 400);
    assert.match(JSON.parse(result.body).error, /Query type is required/);
    assert.equal(net.posts.length, 1);
  } finally { net.restore(); }
});

test("switched off, nothing about the agent is sent or needed; switched on, a ticket needs a valid LiveChat login", async () => {
  let net = network();
  try {
    const off = await createHandler({ httpMethod: "POST", env: { TICKETS_API_KEY: "k" }, body: JSON.stringify({ fields: { toDepartment: "CS" } }) });
    assert.equal(off.statusCode, 201);
    assert.equal("onBehalfOf" in ticketJson(net.posts[0]), false);
  } finally { net.restore(); }
  net = network();
  try {
    const noLogin = await createHandler({ httpMethod: "POST", env: onEnv, body: JSON.stringify({ fields: { toDepartment: "CS" } }) });
    assert.equal(noLogin.statusCode, 401);
    const stale = await createAs({}, {}, "tok-gone");
    assert.equal(stale.statusCode, 401);
    assert.equal(net.posts.length, 0);
  } finally { net.restore(); }
});

const row = (account, login, name, ticketEmail = "") => ({ fields: { "LiveChat Account": account, "LiveChat Login": login, "Agent Name": name, "Ticket Email": ticketEmail } });

test("Ticket Email: the login's own, then the same agent's other login, then the LiveChat email", () => {
  const rows = parseTicketEmailRows([
    row("lc1", "uuid-a1", "96 Teh", "Teh@Company.com"), row("lc2", "uuid-a2", "96 Teh"),
    row("lc1", "uuid-b1", "96 Edwin"), row("lc2", "uuid-b2", "96 Edwin"),
    row("lc1", "uuid-c1", "96 Mexha", "not an email"),
  ]);
  assert.deepEqual(pickTicketEmail(rows, "lc1", "uuid-a1", "teh1@lc.com"), { email: "teh@company.com", via: "ticket-email" });
  assert.deepEqual(pickTicketEmail(rows, "lc2", "uuid-a2", "teh2@lc.com"), { email: "teh@company.com", via: "same-agent" }, "set once, used by both of the agent's logins");
  assert.deepEqual(pickTicketEmail(rows, "lc1", "uuid-b1", "Edwin1@lc.com"), { email: "edwin1@lc.com", via: "livechat" });
  assert.deepEqual(pickTicketEmail(rows, "lc1", "uuid-c1", "m@lc.com"), { email: "m@lc.com", via: "livechat" }, "a value that is not an email is ignored");
  assert.deepEqual(pickTicketEmail(rows, "lc1", "nobody", "x@lc.com"), { email: "x@lc.com", via: "livechat" }, "a login with no row");
  assert.deepEqual(pickTicketEmail([], "lc1", "x", ""), { email: "", via: "livechat" });
});

test("on behalf: the Ticket Email set in Lark is what the ticket system is asked for, whichever LiveChat account the agent used", async () => {
  const net = network();
  const original = globalThis.fetch;
  const larkEnv = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_AGENT_LOGINS: "logins-table" };
  const table = [row("lc1", "uuid-alice", "96 Alice"), row("lc2", "uuid-alice-two", "96 Alice", "alice@company.com")];
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (String(url).includes("/tables/logins-table/records")) return { json: async () => ({ code: 0, data: { items: table } }) };
    return wrapped(url, options);
  };
  try {
    initLarkEnv(larkEnv);
    const result = await createAs(larkEnv);
    assert.equal(result.statusCode, 201);
    assert.equal(ticketJson(net.posts[0]).onBehalfOf, "alice@company.com", "from the agent's other login's Ticket Email, not alice@x.com");
    assert.equal(JSON.parse(result.body).actedAs, "alice@company.com");
  } finally { globalThis.fetch = original; net.restore(); initLarkEnv({}); }
});
