class DurableObject { constructor(c, e) { this.ctx = c; this.env = e; } }

type Env = {
  MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
};

type PermitResult = { ticket: string | null; retryAfterMs: number };
type SearchBatchInput = { url: string; method: string; headers: Record<string, string>; body: string };
type SearchBatchResult = { status: number; statusText: string; headers: [string, string][]; body: string };
type PendingSearch = {
  input: SearchBatchInput;
  body: any;
  usernameField: string;
  username: string;
  resolve: (result: SearchBatchResult) => void;
  reject: (error: unknown) => void;
};

const MAX_CONCURRENT_UPSTREAM = 3;
const MIN_START_GAP_MS = 250;
const PERMIT_LEASE_MS = 8_000;
const MAX_COOLDOWN_MS = 5_000;
const MAX_BATCH_USERNAMES = 50;
const MAX_BATCH_PAGES = 10;
const BATCH_WINDOW_MS = 25;

/**
 * Coordinates short Lark request permits across Pages isolates and agents.
 * The gate state is kept in SQLite so an object restart cannot lose active
 * leases or the shared rate-limit cooldown.
 */
export class MyDurableObject extends DurableObject<Env> {
  private pendingSearches: PendingSearch[] = [];
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private batchFlushPromise: Promise<void> | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS lark_queue_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_start_at INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO lark_queue_state (id, next_start_at, cooldown_until) VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS lark_queue_permits (
        ticket TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lark_queue_permits_expiry ON lark_queue_permits (expires_at);
    `);
  }

  async acquire(): Promise<PermitResult> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM lark_queue_permits WHERE expires_at <= ?", now);
    const state = this.ctx.storage.sql.exec<{ next_start_at: number; cooldown_until: number }>(
      "SELECT next_start_at, cooldown_until FROM lark_queue_state WHERE id = 1",
    ).toArray()[0];
    const active = this.ctx.storage.sql.exec<{ count: number; earliest_expiry: number | null }>(
      "SELECT COUNT(*) AS count, MIN(expires_at) AS earliest_expiry FROM lark_queue_permits",
    ).toArray()[0];
    const nextAvailableAt = Math.max(
      state.next_start_at,
      state.cooldown_until,
      active.count >= MAX_CONCURRENT_UPSTREAM ? Number(active.earliest_expiry || now) : 0,
    );
    if (active.count >= MAX_CONCURRENT_UPSTREAM || nextAvailableAt > now) {
      return { ticket: null, retryAfterMs: Math.max(50, nextAvailableAt - now) };
    }

    const ticket = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO lark_queue_permits (ticket, expires_at) VALUES (?, ?)",
      ticket,
      now + PERMIT_LEASE_MS,
    );
    this.ctx.storage.sql.exec("UPDATE lark_queue_state SET next_start_at = ? WHERE id = 1", now + MIN_START_GAP_MS);
    return { ticket, retryAfterMs: 0 };
  }

  async release(ticket: string, rateLimited = false, retryAfterMs = 0): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM lark_queue_permits WHERE ticket = ?", ticket);
    if (rateLimited) this.setCooldown(retryAfterMs);
  }

  async penalize(retryAfterMs = 0): Promise<void> {
    this.setCooldown(retryAfterMs);
  }

  /**
   * Merge same-table lookups arriving together into OR searches over up to
   * 50 usernames. Results are split back to each caller by username; the
   * Pages function then applies that caller's remaining exact filters.
   */
  async searchBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const body = JSON.parse(input.body || "{}");
    const conditions = body?.filter?.conditions;
    if (!Array.isArray(conditions)) return this.performUnbatchedSearch(input);
    const usernameConditions = conditions.filter((condition) =>
      condition?.operator === "is" && /^(username(?:\/uid)?|uid)$/i.test(String(condition.field_name || ""))
      && Array.isArray(condition.value) && condition.value.length === 1,
    );
    const supportedConditions = conditions.every((condition) =>
      ["is", "isEmpty", "isNotEmpty"].includes(String(condition?.operator || "")),
    );
    if (usernameConditions.length !== 1 || !supportedConditions) return this.performUnbatchedSearch(input);

    const usernameField = String(usernameConditions[0].field_name);
    const username = String(usernameConditions[0].value[0] ?? "");
    if (!username) return this.performUnbatchedSearch(input);
    return new Promise((resolve, reject) => {
      this.pendingSearches.push({ input, body, usernameField, username, resolve, reject });
      if (!this.batchFlushTimer) {
        this.batchFlushTimer = setTimeout(() => {
          this.batchFlushTimer = null;
          this.batchFlushPromise = this.flushSearchBatches().finally(() => { this.batchFlushPromise = null; });
        }, BATCH_WINDOW_MS);
      }
    });
  }

  private async flushSearchBatches(): Promise<void> {
    const pending = this.pendingSearches.splice(0);
    if (!pending.length) return;
    const groups = new Map<string, PendingSearch[]>();
    for (const request of pending) {
      const headers = Object.fromEntries(Object.entries(request.input.headers).map(([key, value]) => [key.toLowerCase(), value]));
      const url = new URL(request.input.url);
      // The page size is raised to the Bitable maximum for the merged search;
      // its original value is not relevant after per-caller filtering.
      url.searchParams.delete("page_token");
      url.searchParams.set("page_size", "500");
      const key = JSON.stringify([
        url.origin, url.pathname, headers.authorization || "", headers["content-type"] || "",
        request.usernameField, !!request.body.automatic_fields,
      ]);
      request.input.url = url.toString();
      const bucket = groups.get(key) || [];
      bucket.push(request);
      groups.set(key, bucket);
    }

    await Promise.all([...groups.values()].flatMap((group) => {
      const byUsername = new Map<string, PendingSearch[]>();
      for (const request of group) {
        const users = byUsername.get(request.username) || [];
        users.push(request);
        byUsername.set(request.username, users);
      }
      const unique = [...byUsername.entries()];
      const chunks: Array<[string, PendingSearch[]][]> = [];
      for (let start = 0; start < unique.length; start += MAX_BATCH_USERNAMES) {
        chunks.push(unique.slice(start, start + MAX_BATCH_USERNAMES));
      }
      return chunks.map((chunk) => this.executeSearchBatch(chunk));
    }));
  }

  private async executeSearchBatch(chunk: Array<[string, PendingSearch[]]>): Promise<void> {
    const first = chunk[0]?.[1][0];
    if (!first) return;
    try {
      const usernames = chunk.map(([username]) => username);
      const usernameField = first.usernameField;
      const mergedBody = {
        filter: {
          conjunction: "or",
          conditions: usernames.map((username) => ({ field_name: usernameField, operator: "is", value: [username] })),
        },
        automatic_fields: chunk.some(([, requests]) => requests.some((request) => !!request.body.automatic_fields)),
        ...(chunk.some(([, requests]) => requests.some((request) => !request.body.field_names?.length))
          ? {}
          : { field_names: [...new Set([usernameField, ...chunk.flatMap(([, requests]) => requests.flatMap((request) => [...(request.body.field_names || []), ...(request.body.filter?.conditions || []).map((condition: { field_name?: string }) => condition.field_name).filter(Boolean)]))])] }),
      };
      const baseUrl = new URL(first.input.url);
      baseUrl.searchParams.delete("page_token");
      baseUrl.searchParams.set("page_size", "500");
      const rows: any[] = [];
      let pageToken = "";
      let lastResult: SearchBatchResult | null = null;
      let hasMore = false;
      for (let page = 0; page < MAX_BATCH_PAGES; page++) {
        const pageUrl = new URL(baseUrl);
        if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
        const result = await this.fetchSearchWithPermit({
          ...first.input,
          url: pageUrl.toString(),
          body: JSON.stringify(mergedBody),
        });
        lastResult = result;
        if (result.status < 200 || result.status >= 300) break;
        const data = JSON.parse(result.body);
        if (data.code !== 0) break;
        rows.push(...(data.data?.items || []));
        hasMore = !!data.data?.has_more && !!data.data?.page_token;
        if (!hasMore) break;
        pageToken = String(data.data.page_token);
      }
      if (hasMore) throw new Error(`Batched Lark search exceeded ${MAX_BATCH_PAGES} pages.`);
      if (!lastResult) throw new Error("Batched Lark search returned no response.");
      const parsed = JSON.parse(lastResult.body);
      if (lastResult.status < 200 || lastResult.status >= 300 || parsed.code !== 0) {
        for (const [, requests] of chunk) for (const request of requests) request.resolve(lastResult!);
        return;
      }

      const baseData = parsed.data || {};
      for (const [username, requests] of chunk) {
        const matchingRows = rows.filter((row) => this.fieldText(row?.fields?.[usernameField]) === username);
        const responseBody = JSON.stringify({ ...parsed, data: { ...baseData, items: matchingRows, has_more: false, page_token: "" } });
        for (const request of requests) {
          request.resolve({
            status: 200,
            statusText: "OK",
            headers: [["content-type", "application/json"], ["x-lark-batched", "1"]],
            body: responseBody,
          });
        }
      }
    } catch (error) {
      const message = String((error as Error)?.message || error || "Batched Lark search failed.");
      const failed: SearchBatchResult = {
        status: 502,
        statusText: "Bad Gateway",
        headers: [["content-type", "application/json"]],
        body: JSON.stringify({ code: -1, msg: message }),
      };
      for (const [, requests] of chunk) for (const request of requests) request.resolve(failed);
    }
  }

  private fieldText(value: any): string {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map((item) => this.fieldText(item)).filter(Boolean).join(", ");
    if (typeof value === "object") {
      if ("text" in value) return this.fieldText(value.text);
      if ("value" in value) return this.fieldText(value.value);
      return "";
    }
    return String(value).trim();
  }

  private async performUnbatchedSearch(input: SearchBatchInput): Promise<SearchBatchResult> {
    return this.fetchSearchWithPermit(input);
  }

  private async fetchSearchWithPermit(input: SearchBatchInput): Promise<SearchBatchResult> {
    let permit: PermitResult;
    while (true) {
      permit = await this.acquire();
      if (permit.ticket) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, permit.retryAfterMs || 100)));
    }
    try {
      const response = await fetch(input.url, {
        method: input.method || "POST",
        headers: input.headers,
        body: input.body,
        signal: AbortSignal.timeout(6_000),
      });
      const body = await response.text();
      let limited = response.status === 429;
      try { const parsed = JSON.parse(body); limited ||= Number(parsed.code) === 99991400 || /too many requests|rate.?limit/i.test(String(parsed.msg || "")); } catch { /* keep HTTP status */ }
      await this.release(permit.ticket!, limited, Number(response.headers.get("Retry-After")) * 1000 || 0);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body,
      };
    } catch (error) {
      await this.release(permit.ticket!, false, 0);
      throw error;
    }
  }

  private setCooldown(retryAfterMs: number): void {
    const delay = Math.min(MAX_COOLDOWN_MS, Math.max(1_000, Number(retryAfterMs) || 0));
    this.ctx.storage.sql.exec(
      "UPDATE lark_queue_state SET cooldown_until = MAX(cooldown_until, ?) WHERE id = 1",
      Date.now() + delay,
    );
  }
}

export default {
  async fetch(): Promise<Response> {
    // All coordination uses the Durable Object RPC methods above. Keep the
    // Worker URL inert so it cannot be used as a public proxy or permit API.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
