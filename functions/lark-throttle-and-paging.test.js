import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { findOldestClaimableRow, initEnv, searchRecords } from "./_lib/lark.js";

const ENV = {
  LARK_APP_ID: "throttle-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
  LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table", LARK_TABLE_PNL: "pnl-table",
  LARK_TABLE_GRACE_PERIOD: "grace-table", LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
  LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table", LARK_TABLE_VIP_BOOSTER: "vip-table",
  LARK_TABLE_TELEGRAM28: "telegram-table", LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const withFetch = async (impl, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
};
const isToken = (url) => String(url).includes("tenant_access_token");
const usernameCond = [{ field_name: "Username", operator: "is", value: ["player1"] }];

// Lark's TooManyRequest is documented as code 1254290; the HTTP status that
// accompanies it is not documented, so it must be recognised from the code.
for (const status of [200, 400]) {
  test(`Lark code 1254290 is treated as rate limiting even with HTTP ${status}`, async () => {
    initEnv({ ...ENV });
    await withFetch(async (url) => isToken(url)
      ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
      : json({ code: 1254290, msg: "TooManyRequest" }, status), async () => {
      await assert.rejects(
        searchRecords("throttled-table", usernameCond, undefined, { timeoutMs: 4_000 }),
        (error) => error.rateLimited === true && error.retryable === true,
      );
    });
  });
}

test("a throttled projected search does not trigger the unprojected fallback search", async () => {
  initEnv({ ...ENV });
  let searches = 0;
  await withFetch(async (url) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    searches++;
    return json({ code: 1254290, msg: "TooManyRequest" }, 400);
  }, async () => {
    await assert.rejects(findOldestClaimableRow("throttled-bonus-table", "player1", "PP", () => true, undefined,
      { fieldNames: ["Status"], usernameField: "Username/UID" }));
  });
  assert.equal(searches, 1, "a rate-limited request must not immediately fan out into a second search");
});

test("a failed blank-row lookup never creates a replacement Customer Approaching row", async () => {
  initEnv({ ...ENV });
  const calls = [];
  await withFetch(async (url, options = {}) => {
    const text = String(url);
    if (isToken(text)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: text, method: options.method || "GET", body });
    if (text.includes("customer-table") && text.endsWith("/records")) return json({ code: 0, data: { record: { record_id: "rec-new" } } });
    // The only search that fails is the case-row dedupe lookup (Inquiry/Status isEmpty predicates).
    if (text.includes("customer-table") && (body.filter?.conditions || []).some((c) => c.field_name === "Inquiry")) {
      return json({ code: 1254290, msg: "TooManyRequest" }, 429);
    }
    return json({ code: 0, data: { items: [], has_more: false } });
  }, async () => {
    const result = await handler({ body: JSON.stringify({
      username: "Player1", brand: "PP", picName: "Agent A", link: "https://my.livechatinc.com/chats/CHAT1/THREAD1",
    }) });
    assert.equal(result.statusCode, 500, "the lookup fails visibly instead of guessing");
    assert.equal(JSON.parse(result.body).ok, false);
  });
  const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/records"));
  assert.equal(creates.length, 0, "no row may be created when the duplicate check could not run");
});

test("searches request an explicit page size instead of Lark's default of 20", async () => {
  initEnv({ ...ENV });
  let seenUrl = "";
  await withFetch(async (url) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    seenUrl = String(url);
    return json({ code: 0, data: { items: [], has_more: false } });
  }, async () => { await searchRecords("paging-table-default", usernameCond); });
  assert.match(seenUrl, /page_size=500/);
});

test("has_more is followed across pages instead of silently truncating", async () => {
  initEnv({ ...ENV });
  const pageTokens = [];
  await withFetch(async (url) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const token = new URL(String(url)).searchParams.get("page_token") || "";
    pageTokens.push(token);
    const page = token === "" ? 1 : Number(token);
    return json({ code: 0, data: { items: [{ record_id: `r${page}`, fields: {} }], has_more: page < 3, page_token: String(page + 1) } });
  }, async () => {
    const rows = await searchRecords("paging-table-follow", usernameCond);
    assert.deepEqual(rows.map((r) => r.record_id), ["r1", "r2", "r3"]);
  });
  assert.deepEqual(pageTokens, ["", "2", "3"]);
});

test("a search that is still incomplete after the page cap fails explicitly (no partial clean result)", async () => {
  initEnv({ ...ENV });
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : json({ code: 0, data: { items: [{ record_id: "x", fields: {} }], has_more: true, page_token: "next" } }), async () => {
    await assert.rejects(
      searchRecords("paging-table-endless", usernameCond, undefined, { timeoutMs: 2_000 }),
      (error) => /more than|refusing a partial/i.test(error.message) && error.retryable === false,
    );
  });
});

test("batched rows keep matching Brand across Lark field shapes (text array, string, formula wrapper)", async () => {
  initEnv({ ...ENV });
  const rows = [
    { record_id: "a", fields: { Username: "p1", Brand: [{ text: "PP", type: "text" }] } },
    { record_id: "b", fields: { Username: "p1", Brand: "PP" } },
    { record_id: "c", fields: { Username: "p1", Brand: { type: 1, value: [{ text: "PP", type: "text" }] } } },
    { record_id: "d", fields: { Username: "p1", Brand: "MY" } },
  ];
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : new Response(JSON.stringify({ code: 0, data: { items: rows, has_more: false } }), { status: 200, headers: { "x-lark-batched": "1" } }), async () => {
    const out = await searchRecords("brand-shape-table", [
      { field_name: "Username", operator: "is", value: ["p1"] }, { field_name: "Brand", operator: "is", value: ["PP"] },
    ]);
    assert.deepEqual(out.map((r) => r.record_id), ["a", "b", "c"]);
  });
});

// ---- shared-gate protocol (v2) -------------------------------------------------
const rows200 = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", "x-lark-batched": "1" } });
async function concurrentBatchedSearches({ protocol }) {
  let inFlight = 0, peak = 0;
  const seen = [];
  const stub = {
    searchBatch: async (request) => {
      inFlight++; peak = Math.max(peak, inFlight); seen.push(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return { status: 200, statusText: "OK", headers: [["x-lark-batched", "1"]], body: JSON.stringify({ code: 0, data: { items: [], has_more: false } }) };
    },
    acquire: async () => ({ ticket: "t", retryAfterMs: 0 }), release: async () => {}, penalize: async () => {},
  };
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, ...(protocol ? { LARK_QUEUE_PROTOCOL: protocol } : {}) });
  await withFetch(async (url) => json({ code: 0, tenant_access_token: "t", expire: 3600 }), async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => searchRecords(`gate-table-${protocol || "legacy"}-${i}`,
      [{ field_name: "Username", operator: "is", value: [`p${i}`] }], undefined, { timeoutMs: 5_000 })));
  });
  return { peak, seen };
}

test("legacy gate: the per-isolate cap of 3 still applies until the v2 gate is enabled", async () => {
  const { peak } = await concurrentBatchedSearches({ protocol: "" });
  assert.ok(peak <= 3, `expected <=3 concurrent searches reaching the queue, saw ${peak}`);
});

test("v2 gate: callers are not throttled by the per-isolate cap, and each search carries the caller's deadline", async () => {
  const { peak, seen } = await concurrentBatchedSearches({ protocol: "v2" });
  assert.ok(peak > 3, `expected more than 3 concurrent searches reaching the batcher, saw ${peak}`);
  const now = Date.now();
  for (const request of seen) {
    assert.ok(request.expiresAt > now && request.expiresAt <= now + 41_000, "deadline is below the widget's 45 s abort");
  }
});

test("shared permits carry their kind and a stable waiter id so a v2 queue keeps the caller's place", async () => {
  const calls = [];
  const stub = {
    acquire: async (...args) => { calls.push(args); return { ticket: "t", retryAfterMs: 0 }; },
    release: async () => {}, penalize: async () => {}, searchBatch: async () => { throw new Error("n/a"); },
  };
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub }, LARK_QUEUE_PROTOCOL: "v2" });
  const { createRecord } = await import("./_lib/lark.js");
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : json({ code: 0, data: { record: { record_id: "r1" } } }), async () => { await createRecord("customer-table", { Username: "p1" }); });
  assert.equal(calls.at(-1)[0], "write");
  assert.match(String(calls.at(-1)[1]), /^[0-9a-f-]{36}$/);
});

test("without the v2 flag the shared permit uses the legacy bare acquire() every deployed queue understands", async () => {
  const calls = [];
  const stub = {
    acquire: async (...args) => { calls.push(args); return { ticket: "t", retryAfterMs: 0 }; },
    release: async () => {}, penalize: async () => {}, searchBatch: async () => { throw new Error("n/a"); },
  };
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub } });   // no LARK_QUEUE_PROTOCOL
  const { createRecord } = await import("./_lib/lark.js");
  await withFetch(async (url) => isToken(url)
    ? json({ code: 0, tenant_access_token: "t", expire: 3600 })
    : json({ code: 0, data: { record: { record_id: "r1" } } }), async () => { await createRecord("customer-table", { Username: "p1" }); });
  assert.deepEqual(calls.at(-1), [], "no kind/waiterId arguments sent to a legacy queue");
});

test("the blank-case lookup is projected to the columns it re-checks, and still reuses a matching blank row instead of creating one", async () => {
  initEnv({ ...ENV });
  let caSearchBody = null;
  const creates = [];
  await withFetch(async (url, options = {}) => {
    const text = String(url);
    if (isToken(text)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    const body = options.body ? JSON.parse(options.body) : {};
    if (text.includes("customer-table") && text.endsWith("/records") && options.method === "POST") { creates.push(body); return json({ code: 0, data: { record: { record_id: "rec-new" } } }); }
    if (text.includes("customer-table") && (body.filter?.conditions || []).some((c) => c.field_name === "Inquiry")) {
      caSearchBody = body;
      return json({ code: 0, data: { items: [{
        record_id: "rec-blank", created_time: 1,
        fields: { Username: "player1", Brand: "PP", "Agent Name": "Agent A", link: { link: "https://my.livechatinc.com/chats/CHAT1/THREAD1", text: "x" } },
      }], has_more: false } });
    }
    return json({ code: 0, data: { items: [], has_more: false } });
  }, async () => {
    const result = await handler({ body: JSON.stringify({
      username: "Player1", brand: "PP", picName: "Agent A", link: "https://my.livechatinc.com/chats/CHAT1/THREAD1",
    }) });
    const parsed = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(parsed.caRecordId, "rec-blank", "the existing blank row is reused");
  });
  assert.equal(creates.length, 0, "no duplicate row created");
  assert.deepEqual([...caSearchBody.field_names].sort(), ["Agent Name", "Brand", "Inquiry", "Status", "Username", "link"].sort());
});

// ---- opt-in batched row creation -----------------------------------------------------
async function createWith({ flag, stub }) {
  initEnv({ ...ENV, LARK_SEARCH_QUEUE: { idFromName: () => "g", get: () => stub },
    ...(flag ? { LARK_QUEUE_PROTOCOL: "v2", LARK_BATCH_CREATE: "1" } : {}) });
  const { createRecord } = await import("./_lib/lark.js");
  const direct = [];
  const outcome = await withFetch(async (url, options = {}) => {
    if (isToken(url)) return json({ code: 0, tenant_access_token: "t", expire: 3600 });
    direct.push({ url: String(url), method: options.method });
    return json({ code: 0, data: { record: { record_id: "direct-1" } } });
  }, async () => { try { return { record: await createRecord("customer-table", { Username: "p1" }) }; } catch (error) { return { error }; } });
  return { ...outcome, direct };
}
const baseStub = (extra = {}) => ({ acquire: async () => ({ ticket: "t", retryAfterMs: 0 }), release: async () => {}, penalize: async () => {}, searchBatch: async () => { throw new Error("n/a"); }, ...extra });

test("batched create is OFF by default: rows are created directly", async () => {
  let used = false;
  const { record, direct } = await createWith({ flag: false, stub: baseStub({ createBatch: async () => { used = true; } }) });
  assert.equal(record.record_id, "direct-1");
  assert.equal(used, false);
  assert.equal(direct.filter((c) => c.method === "POST").length, 1);
});

test("with LARK_BATCH_CREATE=1 the row goes through the queue's createBatch and its record is returned", async () => {
  const seen = [];
  const { record, direct } = await createWith({ flag: true, stub: baseStub({ createBatch: async (request) => {
    seen.push(request);
    return { status: 200, statusText: "OK", headers: [], body: JSON.stringify({ code: 0, data: { record: { record_id: "batched-1", fields: {} } } }) };
  } }) });
  assert.equal(record.record_id, "batched-1");
  assert.equal(direct.filter((c) => c.method === "POST").length, 0, "no second, direct create");
  assert.deepEqual(JSON.parse(seen[0].body), { fields: { Username: "p1" } });
  assert.ok(seen[0].expiresAt > Date.now());
});

test("a queue that does not implement createBatch falls back to one direct create", async () => {
  const { record, direct } = await createWith({ flag: true, stub: baseStub({ createBatch: async () => { throw new Error('The RPC receiver does not implement the method "createBatch".'); } }) });
  assert.equal(record.record_id, "direct-1");
  assert.equal(direct.filter((c) => c.method === "POST").length, 1);
});

test("any other createBatch failure surfaces the error and NEVER creates a second row directly", async () => {
  const { error, direct } = await createWith({ flag: true, stub: baseStub({ createBatch: async () => { throw new Error("network connection lost"); } }) });
  assert.match(error.message, /connection lost/);
  assert.equal(direct.filter((c) => c.method === "POST").length, 0, "outcome unknown: do not risk a duplicate");
});

test("a Lark error returned by createBatch is reported as a failed create", async () => {
  const { error } = await createWith({ flag: true, stub: baseStub({ createBatch: async () => ({ status: 200, statusText: "", headers: [], body: JSON.stringify({ code: 1254002, msg: "Fail" }) }) }) });
  assert.match(error.message, /Lark create failed.*Fail/);
});
