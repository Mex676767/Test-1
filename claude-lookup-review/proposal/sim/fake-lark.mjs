// Synthetic Lark Bitable for load simulation. No network, no credentials, no
// real data. Models: per-call latency, a sliding-window quota (Lark documents
// 20 req/s for records/search), 429 "TooManyRequest" (code 1254290), field
// validation on filters, page_size/page_token paging, OR/AND filters.

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fieldText(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (typeof v === "object") return "text" in v ? fieldText(v.text) : "value" in v ? fieldText(v.value) : "";
  return String(v).trim();
}

// limitStatus: HTTP status that accompanies code 1254290 (undocumented; 429, 200 or 400).
// perCondMs: extra latency per filter condition, to test whether OR-50 queries stay cheap.
// hangAfterWrite: the next N create/batch_create calls WRITE their rows and then never answer (until the caller aborts),
// like a Lark call that times out after committing. client_token: a repeat of a token replays the stored answer and
// writes nothing (Lark's documented idempotency).
// batch_update, as measured against real Lark on 2026-10-07 (production base, a test table):
//   - valid batch: every record applied, reply data.records in request order with record_id + the fields that were sent
//   - an unknown record_id: the WHOLE call is rejected and nothing is applied. HTTP 200, code 1254043, msg "record not found,id = <id>"
//   - an invalid field value (text into a number column; list the column in table.numberFields): the WHOLE call is rejected and nothing
//     is applied. HTTP 200, code 1254061 "NumberFieldConvFail"; the record is NOT named in the reply
//   - the same record_id twice: success, the last value wins
//   - client_token on create and batch_create: a repeat returns the SAME record(s), no second row (see `tokens` below)
// batchUpdateAtomic (default true = the measured behaviour). false is a hypothetical Lark that applies the others and omits an unknown
// record_id from the reply; the code must not corrupt data under it either.
export function createFakeLark({ tables, medianMs = 200, sigma = 0.4, perRowMs = 0.05, perCondMs = 0, quota = 20, enforce = true, seed = 7, limitStatus = 429, shuffleBatch = false, dropFromBatch = 0, hangAfterWrite = 0, batchUpdateAtomic = true }) {
  const rnd = mulberry32(seed);
  let hangs = hangAfterWrite;
  const tokens = new Map();
  const stats = {
    calls: 0, search: 0, create: 0, fields: 0, token: 0, other: 0, limited: 0, replays: 0, hung: 0, get: 0, update: 0, delete: 0, batchUpdate: 0, order: [],
    peakPerSecond: 0, orQueries: 0, orSizes: [], pagesBeyondFirst: 0, rowsReturned: 0, inFlight: 0, peakInFlight: 0,
  };
  const starts = [];
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
  });
  const latency = (rows) => {
    const u1 = Math.max(rnd(), 1e-9), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return medianMs * Math.exp(sigma * z) + rows * perRowMs;
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const notFound = (id) => json({ code: 1254043, msg: `record not found,id = ${id}` });
  const numberFail = () => json({ code: 1254061, msg: "NumberFieldConvFail" });
  const badNumberIn = (table, fields) => (table.numberFields || []).some((name) => {
    if (!fields || !(name in fields)) return false;
    const v = fields[name];
    return typeof v !== "number" && !(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
  });

  function matches(row, filter, schema, ci = false) {
    const conds = filter?.conditions || [];
    for (const c of conds) if (!schema.has(c.field_name)) return { error: `field not found: ${c.field_name}` };
    const norm = (s) => (ci ? String(s).toLowerCase() : String(s));
    const test = (c) => {
      const text = fieldText(row.fields[c.field_name]);
      if (c.operator === "is") return (c.value || []).some((v) => norm(text) === norm(String(v).trim()));
      if (c.operator === "isEmpty") return text === "";
      if (c.operator === "isNotEmpty") return text !== "";
      return true;
    };
    if (!conds.length) return { ok: true };
    return { ok: filter.conjunction === "or" ? conds.some(test) : conds.every(test) };
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : {};
    stats.calls++;
    const kind = /tenant_access_token/.test(u.pathname) ? "token"
      : /\/records\/batch_create$/.test(u.pathname) ? "batchCreate"
      : /\/records\/batch_update$/.test(u.pathname) ? "batchUpdate"
      : /\/records\/search$/.test(u.pathname) ? "search"
      : /\/fields$/.test(u.pathname) ? "fields"
      : /\/records$/.test(u.pathname) && init.method === "POST" ? "create"
      : /\/records$/.test(u.pathname) ? "list"
      : /\/records\/[^/]+$/.test(u.pathname) ? ((init.method || "GET") === "GET" ? "get" : init.method === "DELETE" ? "delete" : "update") : "other";
    stats[kind] = (stats[kind] || 0) + 1;
    const now = Date.now();
    while (starts.length && now - starts[0] >= 1000) starts.shift();
    if (enforce && kind !== "token" && starts.length >= quota) {
      stats.limited++;
      return json({ code: 1254290, msg: "TooManyRequest" }, limitStatus);
    }
    starts.push(now);
    stats.peakPerSecond = Math.max(stats.peakPerSecond, starts.length);
    stats.inFlight++; stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
    try {
      if (kind === "token") { await sleep(latency(0) / 2, init.signal); return json({ code: 0, tenant_access_token: "synthetic-token", expire: 7200 }); }
      if (kind === "fields") { await sleep(latency(0), init.signal); return json({ code: 0, data: { items: [{ field_name: "Tier", property: { options: [{ id: "optT1", name: "VIP1" }, { id: "optT2", name: "VIP2" }] } }] } }); }
      const tableId = u.pathname.match(/tables\/([^/]+)\//)?.[1] || u.pathname.match(/tables\/([^/]+)$/)?.[1];
      const table = tables[tableId];
      if (!table) return json({ code: 1254004, msg: "table not found" });
      stats.order.push(kind);                                    // order in which calls ACTUALLY reached Lark
      if (kind === "batchUpdate") {
        await sleep(latency(0), init.signal);
        const wanted = body.records || [];
        const known = wanted.filter((r) => table.rows.some((row) => row.record_id === r.record_id));
        for (const r of wanted) {                                  // the first problem, in request order, rejects the whole call
          if (!known.includes(r) && batchUpdateAtomic) return notFound(r.record_id);
          if (badNumberIn(table, r.fields)) return numberFail();
        }
        const updated = known.map((r) => {
          const row = table.rows.find((x) => x.record_id === r.record_id);
          row.fields = { ...row.fields, ...(r.fields || {}) };
          return { record_id: row.record_id, fields: r.fields || {} };   // real Lark: only the fields that were sent, in request order
        });
        return json({ code: 0, data: { records: updated } });
      }
      if (kind === "get" || kind === "update" || kind === "delete") {
        await sleep(latency(0), init.signal);
        const id = decodeURIComponent(u.pathname.split("/").pop());
        const at = table.rows.findIndex((r) => r.record_id === id);
        if (at < 0) return notFound(id);
        if (kind === "update" && badNumberIn(table, body.fields)) return numberFail();
        if (kind === "get") return json({ code: 0, data: { record: { record_id: id, fields: table.rows[at].fields } } });
        if (kind === "delete") { table.rows.splice(at, 1); return json({ code: 0, data: { deleted: true, record_id: id } }); }
        table.rows[at].fields = { ...table.rows[at].fields, ...(body.fields || {}) };
        return json({ code: 0, data: { record: { record_id: id, fields: table.rows[at].fields } } });
      }
      const clientToken = (kind === "batchCreate" || kind === "create") ? u.searchParams.get("client_token") : null;
      if (clientToken && tokens.has(clientToken)) {
        stats.replays++;
        await sleep(latency(0), init.signal);
        return json(tokens.get(clientToken));
      }
      const finishWrite = async (payload) => {
        if (clientToken) tokens.set(clientToken, payload);
        if (hangs > 0) { hangs--; stats.hung++; await sleep(600_000, init.signal); }   // committed, but the answer never arrives
        return json(payload);
      };
      if (kind === "batchCreate") {
        await sleep(latency(0), init.signal);
        let created = (body.records || []).map((r) => {
          const rec = { record_id: `rec_new_${table.rows.length}`, created_time: Date.now(), fields: r.fields || {} };
          table.rows.push(rec);
          return rec;
        });
        if (shuffleBatch) created = created.reverse();          // Lark does not document result order
        if (dropFromBatch) created = created.slice(0, created.length - dropFromBatch);
        return finishWrite({ code: 0, data: { records: created } });
      }
      if (kind === "list") {
        await sleep(latency(0), init.signal);
        return json({ code: 0, data: { items: table.rows, has_more: false } });
      }
      if (kind === "create") {
        await sleep(latency(0), init.signal);
        const rec = { record_id: `rec_new_${table.rows.length}`, created_time: Date.now(), fields: body.fields || {} };
        table.rows.push(rec);
        return finishWrite({ code: 0, data: { record: rec } });
      }
      if (kind === "search") {
        const conds = body.filter?.conditions || [];
        if (body.filter?.conjunction === "or" && conds.length > 1) { stats.orQueries++; stats.orSizes.push(conds.length); }
        const pageSize = Math.min(500, Number(u.searchParams.get("page_size")) || 20);
        const offset = Number(u.searchParams.get("page_token") || 0);
        if (offset > 0) stats.pagesBeyondFirst++;
        const all = [];
        for (const row of table.rows) {
          const m = matches(row, body.filter, table.schema, !!table.ci);
          if (m.error) { await sleep(latency(0), init.signal); return json({ code: 1254045, msg: m.error }); }
          if (m.ok) all.push(row);
        }
        const page = all.slice(offset, offset + pageSize);
        const names = body.field_names?.length ? new Set(body.field_names) : null;
        const items = page.map((r) => ({
          record_id: r.record_id,
          ...(body.automatic_fields ? { created_time: r.created_time } : {}),
          fields: names ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => names.has(k))) : r.fields,
        }));
        stats.rowsReturned += items.length;
        await sleep(latency(items.length) + conds.length * perCondMs, init.signal);
        const hasMore = offset + pageSize < all.length;
        return json({ code: 0, data: { items, has_more: hasMore, page_token: hasMore ? String(offset + pageSize) : "", total: all.length } });
      }
      return json({ code: 0, data: {} });
    } finally { stats.inFlight--; }
  }
  return { fetch: fetchImpl, stats, resetWindow: () => { starts.length = 0; } };
}
