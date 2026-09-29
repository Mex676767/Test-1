import assert from "node:assert/strict";
import test from "node:test";
import { handler as configHandler } from "./ticket-config.js";
import { handler as createHandler, onRequest as createOnRequest } from "./ticket-create.js";
import { handler as statusHandler } from "./ticket-status.js";
import { handler as listHandler } from "./ticket-list.js";

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
