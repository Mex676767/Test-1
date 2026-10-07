// Shows the CURRENT worker silently drops a row Lark considers a match when its
// text differs from the requested username (e.g. if Lark's `is` is case-insensitive).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite"; import { createFakeLark } from "./fake-lark.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, ".build"), { recursive: true });
const out = path.join(here, ".build", `do-v1-orphan-${process.pid}.ts`);
fs.writeFileSync(out, fs.readFileSync(path.join(here, "../../worker/src/index.ts"), "utf8").replace(/import \{ DurableObject \} from "cloudflare:workers";/, "class DurableObject { constructor(c, e) { this.ctx = c; this.env = e; } }"));
const { MyDurableObject } = await import(pathToFileURL(out).href);
const db = new DatabaseSync(":memory:");
const ctx = { storage: { sql: { exec(sql, ...p) { if (!p.length && sql.split(";").filter((s) => s.trim()).length > 1) { db.exec(sql); return { toArray: () => [] }; } const rows = db.prepare(sql).all(...p); return { toArray: () => rows }; } } } };
const table = { ci: true, schema: new Set(["Username/UID", "Brand", "Status"]), rows: [
  { record_id: "r1", created_time: 1, fields: { "Username/UID": [{ text: "U1", type: "text" }], Brand: "PP", Status: "Eligible" } },
  { record_id: "r2", created_time: 1, fields: { "Username/UID": [{ text: "u2", type: "text" }], Brand: "PP", Status: "Eligible" } }] };
const lark = createFakeLark({ tables: { t1: table }, medianMs: 5, sigma: 0, quota: 1000 });
globalThis.fetch = lark.fetch;
const d = new MyDurableObject(ctx, {});
const mk = (u) => ({ url: "https://open.larksuite.com/open-apis/bitable/v1/apps/b/tables/t1/records/search?page_size=500", method: "POST",
  headers: { authorization: "Bearer x", "content-type": "application/json" },
  body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "Username/UID", operator: "is", value: [u] }, { field_name: "Brand", operator: "is", value: ["PP"] }] }, field_names: ["Status"] }) });
const [a, b, unbatched] = await Promise.all([d.searchBatch(mk("u1")), d.searchBatch(mk("u2")), (async () => { const r = await lark.fetch(mk("u1").url, { method: "POST", body: mk("u1").body }); return r.json(); })()]);
console.log(JSON.stringify({ batched_u1_rows: JSON.parse(a.body).data.items.length, batched_u2_rows: JSON.parse(b.body).data.items.length, unbatched_u1_rows: unbatched.data.items.length }));
process.exit(0);
