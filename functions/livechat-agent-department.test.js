import test from "node:test";
import assert from "node:assert/strict";
import { handler, resetDepartmentCache } from "./livechat-agent-department.js";
import { initEnv } from "./_lib/livechat.js";

const GROUPS = [
  { id: 4, name: "AC69 Priority Support" },
  { id: 9, name: "Priority 96" },
  { id: 12, name: "CS 96A" },
];

function world({ info = { account_id: "agent@example.com" }, agents = {}, patBroken = false } = {}) {
  const original = globalThis.fetch;
  const calls = { getAgent: [], listGroups: 0, info: 0 };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      calls.info += 1;
      return String(options.headers.Authorization) === "Bearer agent-token"
        ? { ok: true, json: async () => info }
        : { ok: false, json: async () => ({ error: "invalid_token" }) };
    }
    if (url.endsWith("/v2/accounts/me")) return { ok: true, json: async () => ({ email: "found@example.com" }) };
    if (url.endsWith("/get_agent")) {
      const body = JSON.parse(options.body);
      calls.getAgent.push({ authorization: options.headers.Authorization, id: body.id, fields: body.fields });
      if (patBroken && String(options.headers.Authorization).startsWith("Basic ")) {
        return { ok: false, status: 403, json: async () => ({ error: { message: "Missing scope `agents--all:ro`" } }) };
      }
      return body.id in agents
        ? { ok: true, json: async () => ({ groups: agents[body.id].map((id) => ({ id })) }) }
        : { ok: false, status: 404, json: async () => ({ error: { message: "Agent not found" } }) };
    }
    if (url.endsWith("/list_groups")) { calls.listGroups += 1; return { ok: true, json: async () => GROUPS }; }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const call = async (token = "agent-token") => {
  initEnv({ LIVECHAT_PAT: "pat-1" });
  return JSON.parse((await handler({ body: JSON.stringify({ accountKey: "lc1", agentToken: token }) })).body);
};

test("Retention: the agent belongs to Priority 96, asked of LiveChat with the account's token and the agent's email", async () => {
  resetDepartmentCache();
  const w = world({ agents: { "agent@example.com": [4, 9] } });
  try {
    const body = await call();
    assert.equal(body.ok, true);
    assert.equal(body.department, "rtn");
    assert.deepEqual(body.groups, ["AC69 Priority Support", "Priority 96"]);
    assert.deepEqual(w.calls.getAgent, [{ authorization: "Basic pat-1", id: "agent@example.com", fields: ["groups"] }]);
  } finally { w.restore(); }
});

test("Customer Service: any other groups; Priority TC counts as Retention", async () => {
  resetDepartmentCache();
  let w = world({ info: { account_id: "cs-agent@example.com" }, agents: { "cs-agent@example.com": [4, 12] } });
  try { assert.equal((await call()).department, "cs"); } finally { w.restore(); }
  resetDepartmentCache();
  w = world({ info: { account_id: "tc-agent@example.com" }, agents: { "tc-agent@example.com": [12] } });
  globalThis.fetch = ((inner) => async (url, options) => String(url).endsWith("/list_groups") ? { ok: true, json: async () => [{ id: 12, name: "priority tc" }] } : inner(url, options))(globalThis.fetch);
  try { assert.equal((await call()).department, "rtn"); } finally { w.restore(); }
});

test("a UUID login: the email is looked up and that is what get_agent is asked for", async () => {
  resetDepartmentCache();
  const w = world({ info: { account_id: "uuid-department-1" }, agents: { "found@example.com": [9] } });
  try {
    const body = await call();
    assert.equal(body.department, "rtn");
    assert.equal(w.calls.getAgent[0].id, "found@example.com");
  } finally { w.restore(); }
});

test("when the account's token cannot read agents, the agent's own login is tried; both failing is an error, not a guess", async () => {
  resetDepartmentCache();
  let w = world({ info: { account_id: "fallback@example.com" }, agents: { "fallback@example.com": [9] }, patBroken: true });
  try {
    assert.equal((await call()).department, "rtn");
    assert.deepEqual(w.calls.getAgent.map((attempt) => attempt.authorization), ["Basic pat-1", "Bearer agent-token"]);
  } finally { w.restore(); }
  resetDepartmentCache();
  w = world({ info: { account_id: "nobody@example.com" }, agents: {}, patBroken: true });
  try {
    const body = await call();
    assert.equal(body.ok, false);
    assert.match(body.error, /agents--all:ro/);
  } finally { w.restore(); }
});

test("an expired or foreign login is refused; the answer is remembered for a few minutes", async () => {
  resetDepartmentCache();
  let w = world({ agents: { "agent@example.com": [9] } });
  try {
    const bad = await call("wrong-token");
    assert.equal(bad.ok, false);
    assert.equal(bad.loginExpired, true);
    assert.equal(w.calls.getAgent.length, 0);
    await call();
    await call();
    assert.equal(w.calls.getAgent.length, 1, "the agent's groups are asked once");
    assert.equal(w.calls.listGroups, 1, "the group list is asked once");
  } finally { w.restore(); }
  w = world();
  try {
    initEnv({ LIVECHAT_PAT: "pat-1" });
    const missing = JSON.parse((await handler({ body: JSON.stringify({ accountKey: "nope", agentToken: "agent-token" }) })).body);
    assert.equal(missing.ok, false);
  } finally { w.restore(); }
});
