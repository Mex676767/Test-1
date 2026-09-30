import test from "node:test";
import assert from "node:assert/strict";
import { handler, getArchiveForThread } from "./livechat-chat-status.js";
import { initEnv } from "./_lib/livechat.js";

test("old archive lookup uses the exact thread_ids filter", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.livechatinc.com/v3.6/agent/action/list_archives");
    assert.deepEqual(JSON.parse(options.body), { filters: { thread_ids: ["TM25Q40O8Q"] } });
    return { json: async () => ({ chats: [{ id: "CHAT123", thread: { id: "TM25Q40O8Q", active: false } }] }) };
  };

  const result = await getArchiveForThread("token", "TM25Q40O8Q");
  assert.equal(result.match.id, "CHAT123");
});

test("handler resolves an archive after the recent chat lookup misses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  initEnv({ LIVECHAT_PAT: "first-token" });

  globalThis.fetch = async (url) => {
    if (url.endsWith("/list_chats")) {
      return { json: async () => ({ chats_summary: [], found_chats: 5000 }) };
    }
    if (url.endsWith("/list_archives")) {
      return {
        json: async () => ({
          chats: [{
            id: "CHAT123",
            users: [{ type: "customer", session_fields: [{ "Telegram ID": "42" }] }],
            thread: { id: "TM25Q40O8Q", active: false },
          }],
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await handler({ body: JSON.stringify({ chatId: "TM25Q40O8Q" }) });
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.chatId, "CHAT123");
  assert.equal(body.threadId, "TM25Q40O8Q");
  assert.equal(body.accountKey, "lc1");
  assert.equal(body.lookup, "archive");
  assert.equal(body.isActive, false);
  assert.equal(body.isTelegram, true);
});
