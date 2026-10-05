import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./lark-search.js";
import { initEnv, searchRecords } from "./_lib/lark.js";

const response = (data) => ({
  status: 200,
  headers: { get: () => null },
  json: async () => data,
});

test("timed-out queued Lark searches release slots and do not poison later lookups", async () => {
  initEnv({ LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  let slowSearches = true;
  let activeSearches = 0;
  let maxActiveSearches = 0;
  let searchCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    }
    searchCalls++;
    activeSearches++;
    maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
    return new Promise((resolve, reject) => {
      const finish = () => {
        activeSearches--;
        options.signal?.removeEventListener("abort", onAbort);
        resolve(response({ code: 0, data: { items: [] } }));
      };
      const onAbort = () => {
        clearTimeout(timer);
        activeSearches--;
        reject(options.signal.reason || new Error("aborted"));
      };
      const timer = setTimeout(finish, slowSearches ? 250 : 1);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  };

  try {
    const stalledLookups = Array.from({ length: 4 }, (_, index) => searchRecords(
      `table-${index}`,
      [{ field_name: "Username", operator: "is", value: ["test-user"] }],
      undefined,
      { timeoutMs: index === 3 ? 40 : 140, maxAttempts: 1 },
    ));
    const stalledResults = await Promise.allSettled(stalledLookups);

    assert.ok(stalledResults.every((result) => result.status === "rejected"));
    assert.equal(searchCalls, 3, "the queued fourth request should time out without reaching Lark");
    assert.equal(activeSearches, 0, "aborted in-flight requests should release their slots");
    assert.ok(maxActiveSearches <= 3, "local fan-out should respect the concurrency cap");

    slowSearches = false;
    const laterResult = await searchRecords(
      "fresh-table",
      [{ field_name: "Username", operator: "is", value: ["test-user"] }],
      undefined,
      { timeoutMs: 300 },
    );
    assert.deepEqual(laterResult, []);
    assert.equal(activeSearches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("several concurrent preview lookups complete while capping Lark search fan-out", async () => {
  const activePermits = new Set();
  let maxActivePermits = 0;
  let permitSequence = 0;
  const queueStub = {
    acquire: async () => {
      if (activePermits.size >= 3) return { ticket: null, retryAfterMs: 1 };
      const ticket = `permit-${++permitSequence}`;
      activePermits.add(ticket);
      maxActivePermits = Math.max(maxActivePermits, activePermits.size);
      return { ticket, retryAfterMs: 0 };
    },
    release: async (ticket) => { activePermits.delete(ticket); },
    penalize: async () => {},
  };
  initEnv({
    LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_TABLE_CUSTOMER_APPROACHING: "customer-table", LARK_TABLE_REDEEM_CODE: "redeem-table",
    LARK_TABLE_PNL: "pnl-table", LARK_TABLE_GRACE_PERIOD: "grace-table",
    LARK_TABLE_TOP_PNL_NIGHT: "top-pnl-table", LARK_TABLE_LTV_DAY: "ltv-table",
    LARK_TABLE_RISK_PLAYER: "risk-table", LARK_TABLE_SPECIAL_RELOAD: "reload-table",
    LARK_TABLE_VIP_BOOSTER: "vip-table", LARK_TABLE_TELEGRAM28: "telegram-table",
    LARK_TABLE_MOONCAKE: "mooncake-table", LARK_TABLE_VS96_FEEDBACK: "vs96-table",
    LARK_SEARCH_QUEUE: { idFromName: () => "global", get: () => queueStub },
  });
  const originalFetch = globalThis.fetch;
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const response = (data) => ({ status: 200, headers: { get: () => null }, json: async () => data });
  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.includes("tenant_access_token")) {
      return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    }
    if (urlText.includes("/records/search")) {
      activeSearches++;
      maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 12);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      }).finally(() => { activeSearches--; });
    }
    return response({ code: 0, data: { items: [] } });
  };

  try {
    const lookups = await Promise.all(Array.from({ length: 3 }, (_, index) => handler({
      body: JSON.stringify({ username: `parallel-user-${index}`, brand: "PP", preview: true }),
    })));
    assert.ok(lookups.every((result) => result.statusCode === 200));
    assert.ok(lookups.every((result) => JSON.parse(result.body).ok));
    assert.ok(maxActiveSearches <= 3, `observed ${maxActiveSearches} simultaneous Lark searches`);
    assert.ok(maxActivePermits <= 3, `observed ${maxActivePermits} simultaneous global permits`);
    assert.equal(activePermits.size, 0);
    assert.equal(activeSearches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a search returns only after its shared permit is released", async () => {
  let activePermits = 0;
  const queueStub = {
    acquire: async () => { activePermits++; return { ticket: "permit", retryAfterMs: 0 }; },
    release: async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      activePermits--;
    },
    penalize: async () => {},
  };
  initEnv({
    LARK_APP_ID: "release-app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_SEARCH_QUEUE: { idFromName: () => "global", get: () => queueStub },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("tenant_access_token")
    ? response({ code: 0, tenant_access_token: "release-token", expire: 3600 })
    : response({ code: 0, data: { items: [] } });

  try {
    await searchRecords("release-table", [{ field_name: "Username", operator: "is", value: ["test-user"] }]);
    assert.equal(activePermits, 0, "the permit is freed before a successful search returns");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstream deadline starts after the shared queue grants a permit", async () => {
  const queueStub = {
    acquire: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ticket: "delayed-permit", retryAfterMs: 0 };
    },
    release: async () => {},
    penalize: async () => {},
  };
  initEnv({
    LARK_APP_ID: "queue-deadline-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_SEARCH_QUEUE: { idFromName: () => "global", get: () => queueStub },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("tenant_access_token")
    ? response({ code: 0, tenant_access_token: "queue-deadline-token", expire: 3600 })
    : response({ code: 0, data: { items: [] } });

  try {
    const rows = await searchRecords("delayed-queue-table", [], undefined, {
      timeoutMs: 500,
      upstreamTimeoutMs: 15,
    });
    assert.deepEqual(rows, [], "queue waiting longer than the upstream budget should not expire the search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stalled Lark fetch is still stopped by its upstream deadline", async () => {
  initEnv({ LARK_APP_ID: "upstream-deadline-app", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return response({ code: 0, tenant_access_token: "upstream-deadline-token", expire: 3600 });
    }
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      if (options.signal?.aborted) reject(options.signal.reason);
    });
  };

  try {
    await assert.rejects(searchRecords("stalled-upstream-table", [], undefined, {
      timeoutMs: 500,
      upstreamTimeoutMs: 20,
      maxAttempts: 1,
    }), /Lark upstream request timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a slow queue RPC falls back quickly and releases any late permit", async () => {
  initEnv({ LARK_APP_ID: "rpc-app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token" });
  const originalFetch = globalThis.fetch;
  const releasedTickets = [];
  const stub = {
    acquire: () => new Promise((resolve) => setTimeout(() => resolve({ ticket: "late-ticket", retryAfterMs: 0 }), 320)),
    release: (ticket) => { releasedTickets.push(ticket); return Promise.resolve(); },
    penalize: () => Promise.resolve(),
  };
  initEnv({
    LARK_APP_ID: "rpc-app-id", LARK_APP_SECRET: "app-secret", LARK_BASE_APP_TOKEN: "base-token",
    LARK_SEARCH_QUEUE: { idFromName: () => "queue-id", get: () => stub },
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("tenant_access_token")) {
      return response({ code: 0, tenant_access_token: "rpc-token", expire: 3600 });
    }
    return response({ code: 0, data: { items: [] } });
  };

  try {
    const startedAt = Date.now();
    const result = await searchRecords(
      "slow-queue-table",
      [{ field_name: "Username", operator: "is", value: ["test-user"] }],
      undefined,
      { timeoutMs: 1_000 },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 800, `lookup took ${elapsedMs}ms while coordinator was slow`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(releasedTickets.includes("late-ticket"), "a permit granted after fallback must be returned");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
