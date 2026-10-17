import assert from "node:assert/strict";
import test from "node:test";
import { handler as commentHandler } from "./ticket-comment.js";
import { handler as statusHandler } from "./ticket-status.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "./_lib/tickets.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const REF = "TK2610150001";

function network({ replies = [] } = {}) {
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.includes("/comments")) {
      posts.push({ url, body: JSON.parse(options.body) });
      return replies.shift() || reply({ ok: true, parentId: null, comment: { id: 57, author: { id: 14, name: "Alice" }, body: "hello" } }, 201);
    }
    if (url.includes("/tickets/")) return reply({ ok: true, ticket: THREAD });
    throw new Error(`unexpected ${url}`);
  };
  return { posts, restore: () => { globalThis.fetch = original; } };
}
const THREAD = {
  ref: REF, fields: { status: "OPEN" }, commentCount: 2,
  comments: [
    { id: 41, author: { id: 7, name: "Alice" }, body: "@Bob can you check the deposit?", mentions: [{ userId: 8, name: "Bob" }], createdAt: "2026-10-15T08:01:00.000Z", deleted: false, attachments: [{ path: "p/1.png", originalName: "slip.png", mimeType: "image/png", sizeBytes: 1200 }],
      replies: [{ id: 42, author: { id: 8, name: "Bob" }, body: "Done.", mentions: [], createdAt: "2026-10-15T08:05:00.000Z", deleted: false, attachments: [] }] },
    { id: 43, author: { id: 9, name: "Cara" }, body: "secret", deleted: true, attachments: [], replies: [] },
  ],
};
const env = { TICKETS_API_KEY: "k" };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const post = (envUsed, input) => { initLiveChatEnv({ LIVECHAT_PAT: "pat-1" }); return commentHandler({ httpMethod: "POST", env: envUsed, body: JSON.stringify(input) }); };
const author = { accountKey: "lc1", agentToken: "tok-alice" };

test("the ticket read carries the thread: comments with replies, mentions and files; a deleted comment keeps its place without its text", async () => {
  resetTicketReadCache(); resetTicketRateLimit();
  const net = network();
  try {
    const result = await statusHandler({ httpMethod: "GET", env, queryStringParameters: { ref: REF, fresh: "1" } });
    const comments = JSON.parse(result.body).ticket.comments;
    assert.equal(comments.length, 2);
    assert.deepEqual(comments[0].author, { id: 7, name: "Alice" });
    assert.deepEqual(comments[0].mentions, [{ userId: 8, name: "Bob" }]);
    assert.deepEqual(comments[0].attachments, [{ name: "slip.png", mime: "image/png", size: 1200, path: "p/1.png" }]);
    assert.equal(comments[0].replies[0].body, "Done.");
    assert.equal("replies" in comments[0].replies[0], false, "a reply has no replies of its own here");
    assert.deepEqual([comments[1].deleted, comments[1].body], [true, ""]);
  } finally { net.restore(); resetTicketReadCache(); }
});

test("a comment is posted as the signed-in agent, with the reply target, and the answer says who it was posted as", async () => {
  const net = network();
  try {
    const result = await post(onEnv, { ref: REF.toLowerCase(), body: "  Customer confirmed.  ", parentId: 41, author });
    assert.equal(result.statusCode, 201);
    assert.ok(net.posts[0].url.endsWith(`/tickets/${REF}/comments`));
    assert.deepEqual(net.posts[0].body, { body: "Customer confirmed.", parentId: 41, onBehalfOf: "alice@x.com" });
    const body = JSON.parse(result.body);
    assert.equal(body.actedAs, "alice@x.com");
    assert.equal(body.comment.id, 57);
  } finally { net.restore(); }
});

test("a comment needs a valid ticket, some text, a sensible length and a real reply target; nothing is sent otherwise", async () => {
  const net = network();
  try {
    for (const [input, pattern] of [
      [{ ref: "nope", body: "x", author }, /ticket reference/],
      [{ ref: REF, body: "   ", author }, /Write a comment first/],
      [{ ref: REF, body: "x".repeat(5001), author }, /at most 5000/],
      [{ ref: REF, body: "x", parentId: "abc", author }, /not to a valid comment/],
    ]) {
      const result = await post(onEnv, input);
      assert.equal(result.statusCode, 400);
      assert.match(JSON.parse(result.body).error, pattern);
    }
    assert.equal(net.posts.length, 0);
    assert.equal((await commentHandler({ httpMethod: "GET", env: onEnv })).statusCode, 405);
  } finally { net.restore(); }
});

test("no ticket account for the agent's email: the comment is not posted and the agent is asked for their ticket account email", async () => {
  const net = network({ replies: [reply({ ok: false, error: 'No active account has the email "alice@x.com", so nothing can be done on their behalf.' }, 400)] });
  try {
    const result = await post(onEnv, { ref: REF, body: "hi", author });
    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.equal(body.needTicketEmail, true);
    assert.equal(body.triedEmail, "alice@x.com");
    assert.equal(net.posts.length, 1);
  } finally { net.restore(); }
});

test("the key may not act for others: the comment is not posted under the integration account", async () => {
  const net = network({ replies: [reply({ ok: false, error: "This API key's role may not act on behalf of other people (api-keys:act-on-behalf)." }, 403)] });
  try {
    const result = await post(onEnv, { ref: REF, body: "hi", author });
    assert.equal(result.statusCode, 403);
    assert.equal(JSON.parse(result.body).keyNeedsGrant, true);
    assert.equal(net.posts.length, 1);
  } finally { net.restore(); }
});

test("switched on, a comment needs a valid LiveChat login; switched off, it is posted as the key's owner without one", async () => {
  const net = network();
  try {
    assert.equal((await post(onEnv, { ref: REF, body: "hi" })).statusCode, 401);
    assert.equal((await post(onEnv, { ref: REF, body: "hi", author: { accountKey: "lc1", agentToken: "tok-gone" } })).statusCode, 401);
    assert.equal(net.posts.length, 0);
    const off = await post(env, { ref: REF, body: "hi" });
    assert.equal(off.statusCode, 201);
    assert.deepEqual(net.posts[0].body, { body: "hi" });
  } finally { net.restore(); }
});
