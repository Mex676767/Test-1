import assert from "node:assert/strict";
import test from "node:test";
import { handler, buildUpdate } from "./ticket-update.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const REF = "TK2610190001";
const env = { TICKETS_API_KEY: "k" };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const author = { accountKey: "lc1", agentToken: "tok-alice" };

const AFTER = {
  id: 7, ref: REF, fields: { status: "IN_PROGRESS", remarks: "Moved to payments", member_id: "p1" },
  currentDepartment: { id: 60, code: "PYM", name: "Payment" }, market: { id: 1, code: "MYR", label: "Malaysia" },
  raisedBy: { id: 9, name: "Nina", email: "nina@x.com", avatarUrl: null }, assignees: [{ id: 44, name: "Ann", email: "ann@x.com" }],
  createdAt: "2026-10-19T01:00:00.000Z", updatedAt: "2026-10-19T02:00:00.000Z", commentCount: 3, attachmentCount: 0,
};
const CHANGED = [{ key: "status", label: "Status", from: "OPEN", to: "IN_PROGRESS", fromText: "Open", toText: "PYM PROCESSING" }];

function network({ replies = [] } = {}) {
  const original = globalThis.fetch;
  const patches = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (options.method === "PATCH") {
      patches.push({ url, body: JSON.parse(options.body) });
      return replies.shift() || reply({ ok: true, ref: REF, changed: CHANGED, visible: true, ticket: AFTER });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { patches, restore: () => { globalThis.fetch = original; } };
}
const send = (envUsed, input, method = "POST") => { initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); return handler({ httpMethod: method, env: envUsed, body: JSON.stringify(input) }); };
const parse = (result) => JSON.parse(result.body);

test("buildUpdate: only what the ticket API accepts goes through, and an empty change is refused", () => {
  assert.deepEqual(buildUpdate({ fields: { Status: "Open", remarks: null }, market: null, toDepartment: " PYM ", assignees: { add: ["a@x.com"], remove: [31] }, expect: { Status: "OPEN" } }).body,
    { fields: { Status: "Open", remarks: null }, market: null, toDepartment: "PYM", assignees: { add: ["a@x.com"], remove: [31] }, expect: { Status: "OPEN" } });
  assert.match(buildUpdate({}).error, /nothing to change/i);
  assert.match(buildUpdate({ fields: {}, assignees: { add: [], remove: [] }, expect: { Status: "OPEN" } }).error, /nothing to change/i, "expect alone is not a change");
  assert.match(buildUpdate({ fields: [1] }).error, /object/);
  assert.match(buildUpdate({ fields: { a: { nope: 1 } } }).error, /new value/);
  assert.match(buildUpdate({ fields: { a: 1 }, market: "" }).error, /market/);
  assert.match(buildUpdate({ fields: { a: 1 }, assignees: { add: "a@x.com" } }).error, /Assignees/);
  assert.match(buildUpdate({ fields: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 1])) }).error, /50/);
  assert.equal(buildUpdate({ toDepartment: null, fields: { a: 1 } }).body.toDepartment, undefined);
});

test("an update goes to PATCH /tickets/<ref> as the signed-in agent and the answer carries what changed and the ticket after", async () => {
  resetTicketReadCache(); resetTicketRateLimit();
  const net = network();
  try {
    const result = await send(onEnv, { ref: REF.toLowerCase(), author, fields: { Status: "PYM PROCESSING" }, expect: { Status: "OPEN" } }, "PATCH");
    assert.equal(result.statusCode, 200);
    assert.ok(net.patches[0].url.endsWith(`/tickets/${REF}`));
    assert.deepEqual(net.patches[0].body, { fields: { Status: "PYM PROCESSING" }, expect: { Status: "OPEN" }, onBehalfOf: "alice@x.com" });
    const body = parse(result);
    assert.deepEqual(body.changed, CHANGED);
    assert.equal(body.visible, true);
    assert.equal(body.actedAs, "alice@x.com");
    assert.equal(body.ticket.fields.status, "IN_PROGRESS");
    assert.deepEqual(body.ticket.assignees, [{ id: 44, name: "Ann", email: "ann@x.com" }]);
    assert.deepEqual(body.ticket.comments, [], "the update answers without the thread");
  } finally { net.restore(); }
});

test("without acting on behalf nothing about the person is sent", async () => {
  const net = network();
  try {
    await send(env, { ref: REF, fields: { remarks: "x" } });
    assert.equal("onBehalfOf" in net.patches[0].body, false);
  } finally { net.restore(); }
});

test("department, market and assignees travel together in the one request", async () => {
  const net = network();
  try {
    await send(onEnv, { ref: REF, author, toDepartment: "PYM", market: null, assignees: { add: ["ann@x.com"], remove: [31] } });
    assert.deepEqual(net.patches[0].body, { toDepartment: "PYM", market: null, assignees: { add: ["ann@x.com"], remove: [31] }, onBehalfOf: "alice@x.com" });
  } finally { net.restore(); }
});

test("a change that moved the ticket out of the agent's reach is saved, and says the ticket can no longer be seen", async () => {
  const net = network({ replies: [reply({ ok: true, ref: REF, changed: CHANGED, visible: false, message: "Saved" })] });
  try {
    const body = parse(await send(onEnv, { ref: REF, author, toDepartment: "CS" }));
    assert.equal(body.visible, false);
    assert.equal("ticket" in body, false);
    assert.equal(body.changed.length, 1);
  } finally { net.restore(); }
});

test("a failed expect (412) comes back with what the ticket holds now; nothing is shown as saved", async () => {
  const mismatched = [{ name: "Status", key: "status", expected: "OPEN", actual: "SOLVED" }];
  const net = network({ replies: [reply({ ok: false, code: "precondition_failed", error: "Status is no longer OPEN.", mismatched }, 412)] });
  try {
    const result = await send(onEnv, { ref: REF, author, fields: { Status: "IN_PROGRESS" }, expect: { Status: "OPEN" } });
    assert.equal(result.statusCode, 412);
    const body = parse(result);
    assert.equal(body.code, "precondition_failed");
    assert.deepEqual(body.mismatched, mismatched);
  } finally { net.restore(); }
});

test("the ticket system's own refusals keep their code and problems (a field the role may only view, a bad choice)", async () => {
  const problems = { fields: [{ name: "Status", key: "status", code: "unknown_choice", message: 'Status: "Closed" is not one of the choices' }] };
  const net = network({ replies: [reply({ ok: false, code: "validation_failed", error: 'Status: "Closed" is not one of the choices', problems }, 400), reply({ ok: false, code: "key_access", error: "This API key is not allowed to update tickets" }, 403)] });
  try {
    const bad = await send(onEnv, { ref: REF, author, fields: { Status: "Closed" } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual([parse(bad).code, parse(bad).problems], ["validation_failed", problems]);
    const off = await send(onEnv, { ref: REF, author, fields: { Status: "Open" } });
    assert.equal(off.statusCode, 403);
    assert.equal(parse(off).code, "key_access");
    assert.match(parse(off).error, /not allowed to update tickets/);
  } finally { net.restore(); }
});

test("an agent whose ticket account is not found is asked for the email, and a malformed request never reaches the ticket system", async () => {
  const net = network({ replies: [reply({ ok: false, error: 'No active account has the email "alice@x.com", so nothing can be done on their behalf.' }, 400)] });
  try {
    const result = await send(onEnv, { ref: REF, author, fields: { Status: "Open" } });
    assert.equal(parse(result).needTicketEmail, true);
    net.patches.length = 0;
    assert.equal((await send(onEnv, { ref: "nope", author, fields: { a: 1 } })).statusCode, 400);
    assert.equal((await send(onEnv, { ref: REF, author })).statusCode, 400);
    assert.equal((await send(onEnv, { ref: REF, author: { accountKey: "lc1", agentToken: "bad" }, fields: { a: 1 } })).statusCode, 401);
    assert.equal((await handler({ httpMethod: "GET", env: onEnv, body: "" })).statusCode, 405);
    assert.equal((await handler({ httpMethod: "POST", env: onEnv, body: "{" })).statusCode, 400);
    assert.equal((await handler({ httpMethod: "POST", env: {}, body: "{}" })).statusCode, 503);
    assert.equal(net.patches.length, 0);
  } finally { net.restore(); }
});
