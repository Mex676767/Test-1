import test from "node:test";
import assert from "node:assert/strict";
import { lookupChatAccess } from "./_lib/chat-access.js";
import { initEnv } from "./_lib/livechat.js";

const link = "https://my.livechatinc.com/chats/CHAT/THREAD";
const access = { accountKey: "lc1", agentToken: "test-token" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const normalChat = () => ({ users: [
  { id: "me@example.com", type: "agent", present: true, visibility: "all" },
  { id: "customer", type: "customer" },
], thread: { id: "THREAD", active: true, events: [{ type: "message", author_id: "customer", visibility: "all" }] } });

function world(t, { identity, chat } = {}) {
  initEnv({ LIVECHAT_PAT: "test-pat" });
  const requests = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/v2/info")) return identity ? identity() : reply({ account_id: "me@example.com" });
    assert.ok(url.endsWith("/get_chat"), "only expected read-only LiveChat requests");
    assert.deepEqual(JSON.parse(options.body), { chat_id: "CHAT", thread_id: "THREAD" });
    return chat ? chat() : reply(normalChat());
  };
  return requests;
}

test("missing and expired logins request reconnection; a fresh login restores a handling agent's lookup", async (t) => {
  let expired = true;
  const requests = world(t, { identity: () => expired ? reply({ error: "invalid_token" }, 401) : reply({ account_id: "me@example.com" }) });
  const missing = await lookupChatAccess({}, { accountKey: "lc1" }, link);
  assert.equal(missing.loginRequired, true);
  assert.equal(requests.length, 0);
  const invalid = await lookupChatAccess({}, access, link);
  assert.equal(invalid.code, "login_required");
  assert.equal(invalid.readOnly, true);
  expired = false;
  assert.equal((await lookupChatAccess({}, access, link)).readOnly, false);
});

test("a delayed identity check no longer turns a normal active chat read-only after six seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const requests = world(t, { identity: () => new Promise((resolve) => { release = resolve; }) });
  let settled = false;
  const pending = lookupChatAccess({}, access, link).then((value) => { settled = true; return value; });
  assert.equal(requests.length, 2, "chat and identity are read in parallel");
  t.mock.timers.tick(6500);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false, "the old six-second cutoff must not classify the agent");
  release(reply({ account_id: "me@example.com" }));
  assert.equal((await pending).readOnly, false);
});

test("a stalled check is bounded and cancels its reads without enabling writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = world(t, { identity: () => new Promise(() => {}), chat: () => new Promise(() => {}) });
  const pending = lookupChatAccess({}, access, link);
  t.mock.timers.tick(12001);
  const result = await pending;
  assert.equal(result.code, "verification_timeout");
  assert.equal(result.readOnly, true);
  assert.equal(result.loginRequired, false);
  assert.ok(requests.every(({ options }) => options.signal.aborted));
});

test("an expired login is reported even if the chat read stalls", async (t) => {
  const requests = world(t, { identity: () => reply({ error: "invalid_token" }, 401), chat: () => new Promise(() => {}) });
  assert.equal((await lookupChatAccess({}, access, link)).code, "login_required");
  assert.ok(requests.every(({ options }) => options.signal.aborted));
});

test("service failures, missing links, restricted messages and wrong threads have distinct retry reasons", async (t) => {
  let current = reply({}, 403);
  world(t, { chat: () => current });
  assert.equal((await lookupChatAccess({}, access, "")).code, "chat_link_missing");
  assert.equal((await lookupChatAccess({}, access, link)).code, "chat_access_denied");
  const chat = normalChat();
  delete chat.thread.events;
  current = reply(chat);
  assert.equal((await lookupChatAccess({}, access, link)).code, "events_unavailable");
  chat.thread.id = "OTHER";
  current = reply(chat);
  assert.equal((await lookupChatAccess({}, access, link)).code, "thread_mismatch");
});
