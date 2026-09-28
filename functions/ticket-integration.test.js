import assert from "node:assert/strict";
import test from "node:test";
import { handler as configHandler } from "./ticket-config.js";
import { handler as createHandler } from "./ticket-create.js";
import { handler as statusHandler } from "./ticket-status.js";

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
      fields: { member_id: "private" },
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
    assert.deepEqual(body.departments, [{ id: 2, code: "PYM_MYR", name: "PAYMENT MYR/PHP/PKR" }]);
    assert.deepEqual(body.markets, [{ id: 4, code: "MYR", label: "Malaysia" }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("create applies selected department and market ids", async () => {
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
      body: JSON.stringify({ toDepartmentId: 2, marketId: 4, fields: { member_id: "member123" } }),
    });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(requestBody, {
      toDepartmentId: 2,
      marketId: 4,
      fields: { member_id: "member123" },
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

test("status validates refs before calling the upstream API", async () => {
  const result = await statusHandler({
    httpMethod: "GET",
    env,
    queryStringParameters: { ref: "bad-ref" },
  });
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).error, /ticket reference/i);
});
