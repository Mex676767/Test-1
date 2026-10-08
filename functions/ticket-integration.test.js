import assert from "node:assert/strict";
import test from "node:test";
import { handler as configHandler } from "./ticket-config.js";
import { handler as createHandler, onRequest as createOnRequest } from "./ticket-create.js";
import { handler as statusHandler } from "./ticket-status.js";
import { handler as listHandler } from "./ticket-list.js";
import { handler as commentHandler, onRequest as commentOnRequest } from "./ticket-comment.js";

const env = {
  TICKETS_API_KEY: "test_ticket_key",
};

test("config returns fields without exposing ticket records", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    fields: [{ key: "status", label: "Status", type: "SELECT", isActive: true }],
    tickets: [{
      ref: "TK2609210007",
      fields: { member_id: "private", status: "PYM_SOLVED" },
      currentDepartment: { id: 2, code: "PYM_MYR", name: "PAYMENT MYR/PHP/PKR" },
      market: { id: 4, code: "MYR", label: "Malaysia", isActive: true },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await configHandler({ httpMethod: "GET", env });
    const body = JSON.parse(result.body);
    assert.equal(body.ok, true);
    assert.equal("tickets" in body, false);
    assert.equal(body.fields[0].key, "status");
    assert.deepEqual(body.fields[0].options, [{ value: "PYM_SOLVED", label: "PYM_SOLVED", isActive: true }]);
    assert.deepEqual(body.departments, [{ id: 2, code: "PYM_MYR", name: "PAYMENT MYR/PHP/PKR" }]);
    assert.deepEqual(body.markets, [{ id: 4, code: "MYR", label: "Malaysia" }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("create forwards the updated field-based ticket payload", async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, id: 412, ref: "TK2609210007" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await createHandler({
      httpMethod: "POST",
      env,
      body: JSON.stringify({ fields: { toDepartment: "PYM_MYR", market: "MYR", member_id: "member123" } }),
    });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(requestBody, {
      fields: { toDepartment: "PYM_MYR", market: "MYR", member_id: "member123" },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("create requires a destination department", async () => {
  const result = await createHandler({
    httpMethod: "POST",
    env,
    body: JSON.stringify({ fields: { member_id: "member123" } }),
  });
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).error, /destination department/i);
});

test("create forwards attachment files in the ticket multipart request", async () => {
  const originalFetch = global.fetch;
  let upstreamBody;
  let upstreamHeaders;
  global.fetch = async (_url, options) => {
    upstreamBody = options.body;
    upstreamHeaders = options.headers;
    return new Response(JSON.stringify({
      ok: true,
      id: 413,
      ref: "TK2609210008",
      attachments: [{ field: "attachment", name: "receipt.png", mime: "image/png", size: 3 }],
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const formData = new FormData();
    formData.append("ticket", JSON.stringify({ fields: { toDepartment: "PYM_MYR", member_id: "member123" } }));
    formData.append("attachment", new Blob(["png"], { type: "image/png" }), "receipt.png");
    const result = await createOnRequest({
      env,
      request: new Request("https://example.test/ticket-create", { method: "POST", body: formData }),
    });
    const response = await result.json();
    assert.equal(result.status, 201);
    assert.equal(response.attachments[0].name, "receipt.png");
    assert.ok(upstreamBody instanceof FormData);
    assert.deepEqual(JSON.parse(upstreamBody.get("ticket")), {
      fields: { toDepartment: "PYM_MYR", member_id: "member123" },
    });
    assert.equal(upstreamBody.get("attachment").name, "receipt.png");
    assert.equal("Content-Type" in upstreamHeaders, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("status validates refs before calling the upstream API", async () => {
  const result = await statusHandler({
    httpMethod: "GET",
    env,
    queryStringParameters: { ref: "bad-ref" },
  });
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).error, /ticket reference/i);
});

test("status returns the ticket metadata needed by the in-app detail panel", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    fields: [{ key: "status", label: "Status", type: "SELECT" }],
    ticket: {
      ref: "TK2609210007",
      fields: { status: "OPEN", member_id: "member123" },
      currentDepartment: { id: 2, code: "PYM_MYR", name: "PAYMENT MYR/PHP/PKR" },
      market: { id: 4, code: "MYR", label: "Malaysia" },
      raisedBy: { id: 9, name: "Nina", email: "nina@example.com", avatarUrl: "private" },
      assignees: [{ id: 10, name: "Pao", email: "pao@example.com", extra: "private" }],
      createdAt: "2026-09-21T03:10:00.000Z",
      updatedAt: "2026-09-21T03:20:00.000Z",
      commentCount: 2,
      attachmentCount: 1,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await statusHandler({ httpMethod: "GET", env, queryStringParameters: { ref: "TK2609210007" } });
    const body = JSON.parse(result.body);
    assert.equal(body.ticket.commentCount, 2);
    assert.equal(body.ticket.market.code, "MYR");
    assert.deepEqual(body.ticket.assignees, [{ id: 10, name: "Pao", email: "pao@example.com" }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ticket list forwards search and returns scoped ticket summaries", async () => {
  const originalFetch = global.fetch;
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      ok: true,
      total: 1,
      tickets: [{ ref: "TK2609210007", fields: { status: "OPEN" }, assignees: [], commentCount: 1 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await listHandler({ httpMethod: "GET", env, queryStringParameters: { q: "member 123" } });
    const body = JSON.parse(result.body);
    assert.equal(body.total, 1);
    assert.equal(body.tickets[0].ref, "TK2609210007");
    assert.match(requestedUrl, /q=member\+123/);
    assert.match(requestedUrl, /sort=updatedAt%3Adesc/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("status returns the comment thread without author emails or extra fields", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    ticket: {
      ref: "TK2609210007",
      fields: { status: "OPEN" },
      commentCount: 1,
      comments: [{
        id: 41,
        author: { id: 7, name: "Alice", email: "alice@example.com" },
        body: "@Bob can you check the deposit?",
        mentions: [{ userId: 8, name: "Bob", email: "bob@example.com" }],
        createdAt: "2026-09-30T08:01:00.000Z",
        deleted: false,
        attachments: [{ path: "2026-09/30/a.jpg", originalName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, secret: "x" }],
        replies: [{ id: 42, author: { id: 8, name: "Bob" }, body: "Done.", mentions: [], createdAt: "2026-09-30T08:05:00.000Z", deleted: false, attachments: [] }],
      }],
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await statusHandler({ httpMethod: "GET", env, queryStringParameters: { ref: "TK2609210007" } });
    const [comment] = JSON.parse(result.body).ticket.comments;
    assert.deepEqual(comment.author, { id: 7, name: "Alice" });
    assert.deepEqual(comment.mentions, [{ userId: 8, name: "Bob" }]);
    assert.deepEqual(comment.attachments, [{ path: "2026-09/30/a.jpg", originalName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 }]);
    assert.equal(comment.replies[0].body, "Done.");
    assert.equal("replies" in comment.replies[0], false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("status keeps a deleted comment's place with a null body", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    ticket: { ref: "TK2609210007", fields: {}, comments: [{ id: 5, author: { id: 1, name: "A" }, body: null, deleted: true, replies: [{ id: 6, author: { id: 2, name: "B" }, body: "ok" }] }] },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await statusHandler({ httpMethod: "GET", env, queryStringParameters: { ref: "TK2609210007" } });
    const [comment] = JSON.parse(result.body).ticket.comments;
    assert.equal(comment.deleted, true);
    assert.equal(comment.body, null);
    assert.equal(comment.replies.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("comment posts JSON to the ticket's comments endpoint with the reply target", async () => {
  const originalFetch = global.fetch;
  let upstreamUrl;
  let upstreamBody;
  global.fetch = async (url, options) => {
    upstreamUrl = String(url);
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      ok: true,
      parentId: 41,
      comment: { id: 57, author: { id: 14, name: "Bot", email: "bot@example.com" }, body: "Done", mentions: [], createdAt: "2026-09-30T09:12:00.000Z", deleted: false, attachments: [], replies: [] },
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await commentHandler({
      httpMethod: "POST",
      env,
      queryStringParameters: { ref: "tk2609210007" },
      body: JSON.stringify({ body: "  Done  ", parentId: 41 }),
    });
    assert.equal(result.statusCode, 201);
    assert.match(upstreamUrl, /\/tickets\/TK2609210007\/comments$/);
    assert.deepEqual(upstreamBody, { body: "Done", parentId: 41 });
    const body = JSON.parse(result.body);
    assert.equal(body.parentId, 41);
    assert.deepEqual(body.comment.author, { id: 14, name: "Bot" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("comment validates the ref, an empty comment and a bad reply target before calling upstream", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("upstream must not be called"); };
  try {
    const call = (queryStringParameters, body) => commentHandler({ httpMethod: "POST", env, queryStringParameters, body: JSON.stringify(body) });
    assert.equal((await call({ ref: "nope" }, { body: "hi" })).statusCode, 400);
    const empty = await call({ ref: "TK2609210007" }, { body: "   " });
    assert.equal(empty.statusCode, 400);
    assert.match(JSON.parse(empty.body).error, /comment or attach/i);
    assert.equal((await call({ ref: "TK2609210007" }, { body: "hi", parentId: "abc" })).statusCode, 400);
    assert.equal((await call({ ref: "TK2609210007" }, { body: "hi", mentions: "Alice" })).statusCode, 400);
    assert.equal((await commentHandler({ httpMethod: "GET", env })).statusCode, 405);
  } finally {
    global.fetch = originalFetch;
  }
});

test("comment forwards files in a multipart request and refuses bad files", async () => {
  const originalFetch = global.fetch;
  let upstreamBody;
  let upstreamHeaders;
  global.fetch = async (_url, options) => {
    upstreamBody = options.body;
    upstreamHeaders = options.headers;
    return new Response(JSON.stringify({ ok: true, parentId: null, comment: { id: 58, author: { id: 14, name: "Bot" }, body: "Receipt", attachments: [] } }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const make = (parts) => {
      const formData = new FormData();
      formData.append("comment", JSON.stringify({ body: "Receipt" }));
      for (const [blob, name] of parts) formData.append("file", blob, name);
      return commentOnRequest({
        env,
        request: new Request("https://example.test/ticket-comment?ref=TK2609210007", { method: "POST", body: formData }),
      });
    };
    const ok = await make([[new Blob(["png"], { type: "image/png" }), "receipt.png"]]);
    assert.equal(ok.status, 201);
    assert.ok(upstreamBody instanceof FormData);
    assert.deepEqual(JSON.parse(upstreamBody.get("comment")), { body: "Receipt" });
    assert.equal(upstreamBody.get("file").name, "receipt.png");
    assert.equal("Content-Type" in upstreamHeaders, false);

    upstreamBody = undefined;
    const wrongType = await make([[new Blob(["gif"], { type: "image/gif" }), "x.gif"]]);
    assert.equal(wrongType.status, 400);
    const tooMany = await make(Array.from({ length: 5 }, (_, i) => [new Blob(["p"], { type: "image/png" }), `${i}.png`]));
    assert.equal(tooMany.status, 400);
    const tooBig = await make([[new Blob([new Uint8Array(1024 * 1024)], { type: "image/png" }), "big.png"]]);
    assert.equal(tooBig.status, 400);
    assert.equal(upstreamBody, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("comment passes the ticket service's refusal status and message through", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json" } });
  try {
    const result = await commentHandler({ httpMethod: "POST", env, queryStringParameters: { ref: "TK2609210007" }, body: JSON.stringify({ body: "hi" }) });
    assert.equal(result.statusCode, 429);
    assert.equal(JSON.parse(result.body).error, "Rate limit exceeded");
  } finally {
    global.fetch = originalFetch;
  }
});
