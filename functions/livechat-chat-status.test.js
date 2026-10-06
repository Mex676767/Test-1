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

// ---- poll cost: preferred license first, raw payload only on request -------------------
function twoAccountFetch(calls) {
  return async (url, options) => {
    const token = String(options.headers.Authorization || "").replace("Basic ", "");
    calls.push({ url: String(url).split("/").pop(), token });
    if (String(url).endsWith("/list_chats")) {
      // Only the SECOND license owns this thread.
      return { json: async () => token === "second-token"
        ? { chats_summary: [{ id: "CHAT9", users: [], last_thread_summary: { id: "THREAD9", active: true } }] }
        : { chats_summary: [] } };
    }
    if (String(url).endsWith("/get_chat")) {
      return { json: async () => token === "second-token"
        ? { id: "CHAT9", thread: { id: "THREAD9", active: true }, users: [] }
        : { error: { message: "Chat not found" } } };
    }
    return { json: async () => ({ chats: [] }) };
  };
}

test("a caller that names its license is served by that license first (one API call, not one per license)", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  initEnv({ LIVECHAT_PAT: "first-token", LIVECHAT_PAT_2: "second-token" });
  const calls = [];
  globalThis.fetch = twoAccountFetch(calls);

  const body = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9", accountKey: "lc2" }) })).body);
  assert.equal(body.accountKey, "lc2");
  assert.equal(body.isActive, true);
  assert.equal(calls.length, 1, "no wasted call to the other license");
  assert.equal(calls[0].token, "second-token");

  const unlabeled = [];
  globalThis.fetch = twoAccountFetch(unlabeled);
  const fallback = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9" }) })).body);
  assert.equal(fallback.accountKey, "lc2", "without a label every license is still tried");
  assert.equal(unlabeled.length, 2);
});

test("a wrong license label cannot hide a chat: the other licenses are still tried", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  initEnv({ LIVECHAT_PAT: "first-token", LIVECHAT_PAT_2: "second-token" });
  globalThis.fetch = twoAccountFetch([]);
  const body = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9", accountKey: "lc1" }) })).body);
  assert.equal(body.accountKey, "lc2");
  assert.equal(body.isActive, true);
});

test("the raw LiveChat payload is returned only when requested or when the status could not be read", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  initEnv({ LIVECHAT_PAT: "first-token", LIVECHAT_PAT_2: "second-token" });
  globalThis.fetch = twoAccountFetch([]);
  const plain = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9" }) })).body);
  assert.equal(plain.raw, undefined, "normal poll carries no raw payload");
  const debug = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9", debug: true }) })).body);
  assert.ok(debug.raw, "debug poll carries it");
  const viaFastPath = JSON.parse((await handler({ body: JSON.stringify({ chatId: "THREAD9", realChatId: "CHAT9", accountKey: "lc2" }) })).body);
  assert.equal(viaFastPath.raw, undefined);
  const notFound = JSON.parse((await handler({ body: JSON.stringify({ chatId: "NOSUCH" }) })).body);
  assert.equal(notFound.notFound, true);
  assert.ok(notFound.raw, "not-found replies keep their diagnostic payload");
});
