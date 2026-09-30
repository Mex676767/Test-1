import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./livechat-agent-department.js";
import { initEnv } from "./_lib/livechat.js";

test("detects RTN from the signed-in agent's Priority 96 membership", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  initEnv({ LIVECHAT_PAT: "admin-token" });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/v2/info")) {
      assert.equal(options.headers.Authorization, "Bearer agent-token");
      return { ok: true, json: async () => ({ account_id: "agent@example.com" }) };
    }
    if (String(url).endsWith("/list_groups")) {
      assert.deepEqual(JSON.parse(options.body), { fields: ["agent_priorities"] });
      return { ok: true, json: async () => ([
        { id: 4, name: "AC69 Priority Support", agent_priorities: { "agent@example.com": "normal" } },
        { id: 9, name: "Priority 96", agent_priorities: { "agent@example.com": "normal" } },
        { id: 12, name: "CS 96A", agent_priorities: { "someone-else@example.com": "normal" } },
      ]) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const response = await handler({ body: JSON.stringify({ accountKey: "lc1", agentToken: "agent-token" }) });
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.department, "rtn");
  assert.deepEqual(body.groups, ["AC69 Priority Support", "Priority 96"]);
});
