import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./livechat-group-name.js";
import { initEnv } from "./_lib/livechat.js";

test("returns the signed-in OAuth agent's assigned groups for department access", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  initEnv({ LIVECHAT_PAT: "first-token" });

  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").pop();
    if (action === "list_chats") {
      return { json: async () => ({ chats_summary: [{ id: "CHAT1", last_thread_summary: { id: "THREAD1" } }] }) };
    }
    if (action === "get_chat") {
      return {
        json: async () => ({
          thread: {
            access: { group_ids: ["10"] },
          },
        }),
      };
    }
    if (action === "list_groups") {
      return { json: async () => ([
        { id: 10, name: "AS126 Priority Support" },
        { id: 20, name: "Priority 96" },
      ]) };
    }
    if (action === "info") {
      assert.equal(options.headers.Authorization, "Bearer signed-in-token");
      return { json: async () => ({ account_id: "agent-1" }) };
    }
    if (action === "get_agent") {
      assert.equal(options.headers.Authorization, "Bearer signed-in-token");
      assert.deepEqual(JSON.parse(options.body), { id: "agent-1", fields: ["groups"] });
      return { json: async () => ({ id: "agent-1", groups: [{ id: 10 }, { id: 20 }] }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await handler({ body: JSON.stringify({
    threadId: "THREAD1",
    groupID: "10",
    agentTokens: { lc1: "signed-in-token" },
  }) });
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.groupName, "AS126 Priority Support");
  assert.deepEqual(body.departmentGroups, ["AS126 Priority Support", "Priority 96"]);
  assert.equal(body.accountKey, "lc1");
});
