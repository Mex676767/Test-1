#!/usr/bin/env node
// One-off check of how Lark's records/batch_update really behaves. Run it by hand, ONCE, against a DEDICATED TEST TABLE -- never a
// production table. It creates its own rows in that table, runs four batch_update experiments, reads every row back after each one
// and prints Lark's RAW replies so they can be pasted into a review. It never prints the access token.
//
//   a) a valid batch                                  -> do all records change?
//   b) one record_id that does not exist              -> is the whole call rejected, or are the others applied? what does the reply look like?
//   c) one invalid field value (text in a number col) -> same questions
//   d) the same record_id twice in one batch          -> which value wins, is it an error?
//
// Setup (names only; values are yours to supply):
//   LARK_APP_ID, LARK_APP_SECRET          the app credentials (same as the widget uses)
//   LARK_BASE_APP_TOKEN                   the Base that holds the dedicated test table
//   BATCH_TEST_TABLE_ID                   the dedicated test table (create an empty one; it needs a text column and a number column)
//   BATCH_TEST_TEXT_FIELD   (default "Text")     name of a plain text column
//   BATCH_TEST_NUMBER_FIELD (default "Number")   name of a number column
//
//   node scripts/lark-batch-update-check.mjs --i-understand-this-writes-to-a-test-table [--cleanup]
//
//   e) the same create sent twice with the same client_token (single create, then batch_create)
//                                                     -> one row or two? is the second reply identical, or an error? (settles whether
//                                                        the queue's "retry a timed-out create with the SAME client_token" is safe)
//
// --cleanup deletes the rows this script created (only those) at the end.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const API = "https://open.larksuite.com/open-apis";
const GHOST_ID = "recDOESNOTEXIST000";
const need = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_BASE_APP_TOKEN", "BATCH_TEST_TABLE_ID"];

// Nothing that looks like a token may be printed.
export const scrub = (text) => String(text ?? "")
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
  .replace(/\b[tu]-[A-Za-z0-9_-]{20,}\b/g, "[token]");

export async function runBatchUpdateCheck({ env = process.env, argv = process.argv.slice(2), fetchImpl = globalThis.fetch, out = (line) => console.log(line) } = {}) {
  const say = (text = "") => out(scrub(text));
  const missing = need.filter((name) => !String(env[name] || "").trim());
  if (missing.length) { say(`Missing environment variables: ${missing.join(", ")}`); return { ok: false, reason: "missing-env" }; }
  if (!argv.includes("--i-understand-this-writes-to-a-test-table")) {
    say("Refusing to run: this script writes rows to the table named in BATCH_TEST_TABLE_ID.");
    say("Run it with --i-understand-this-writes-to-a-test-table, and only against a dedicated test table.");
    return { ok: false, reason: "no-confirmation" };
  }
  const table = env.BATCH_TEST_TABLE_ID.trim();
  const productionTables = Object.entries(env).filter(([name, value]) => /^LARK_TABLE_/.test(name) && String(value).trim()).map(([name, value]) => [name, String(value).trim()]);
  const clash = productionTables.find(([, value]) => value === table);
  if (clash) { say(`Refusing to run: BATCH_TEST_TABLE_ID is the same as ${clash[0]}. Use a dedicated test table, not an application table.`); return { ok: false, reason: "production-table" }; }
  const textField = env.BATCH_TEST_TEXT_FIELD || "Text";
  const numberField = env.BATCH_TEST_NUMBER_FIELD || "Number";
  const base = `${API}/bitable/v1/apps/${env.LARK_BASE_APP_TOKEN.trim()}/tables/${table}`;

  // ---- token (never printed) ------------------------------------------------------------------------------------------
  const auth = await fetchImpl(`${API}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }) });
  const authBody = await auth.json().catch(() => ({}));
  if (authBody.code !== 0 || !authBody.tenant_access_token) { say(`Could not get a tenant token: code ${authBody.code} ${authBody.msg || ""}`); return { ok: false, reason: "auth" }; }
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${authBody.tenant_access_token}` };
  say("tenant token obtained (not printed)");

  // Every call goes through here: returns the raw status + body text and the parsed JSON.
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* raw text only */ }
    return { status: res.status, text, json, logId: res.headers?.get?.("x-tt-logid") || "" };
  };

  // ---- is this table usable? -------------------------------------------------------------------------------------------
  const fields = await call("GET", "/fields?page_size=100");
  const found = (fields.json?.data?.items || []).map((f) => ({ name: f.field_name, type: f.type }));
  const hasText = found.find((f) => f.name === textField), hasNumber = found.find((f) => f.name === numberField);
  say(`\n=== table ${table}: columns ${found.map((f) => `${f.name}(type ${f.type})`).join(", ") || "(none read)"}`);
  if (!hasText || !hasNumber) {
    say(`The table needs a text column named "${textField}" and a number column named "${numberField}" (or set BATCH_TEST_TEXT_FIELD / BATCH_TEST_NUMBER_FIELD).`);
    return { ok: false, reason: "columns" };
  }

  // ---- own rows --------------------------------------------------------------------------------------------------------
  const ids = {};
  for (const key of ["A", "B", "C", "D", "E", "F"]) {
    const created = await call("POST", "/records", { fields: { [textField]: `init-${key}`, [numberField]: 0 } });
    const id = created.json?.data?.record?.record_id;
    if (!id) { say(`Could not create row ${key}: HTTP ${created.status} ${created.text}`); return { ok: false, reason: "create", ids }; }
    ids[key] = id;
  }
  say(`created rows: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  const readBack = async (keys) => {
    for (const key of keys) {
      const row = await call("GET", `/records/${ids[key]}`);
      say(`   read back ${key} (${ids[key]}): HTTP ${row.status} ${row.json?.data?.record ? JSON.stringify(row.json.data.record.fields) : row.text}`);
    }
  };
  const experiment = async (title, question, records, readKeys) => {
    say(`\n=== ${title}`);
    say(`question: ${question}`);
    say(`request body: ${JSON.stringify({ records })}`);
    const reply = await call("POST", "/records/batch_update", { records });
    say(`HTTP ${reply.status}${reply.logId ? `   x-tt-logid ${reply.logId}` : ""}`);
    say(`RAW reply: ${reply.text}`);
    await readBack(readKeys);
    return reply;
  };

  await experiment("(a) valid batch", "do both records change, and in what order are they returned?",
    [{ record_id: ids.A, fields: { [textField]: "a-1" } }, { record_id: ids.B, fields: { [textField]: "a-2" } }], ["A", "B"]);
  await experiment("(b) one record_id that does not exist", "is the whole call rejected (is C still 'init-C')? how is the missing record reported?",
    [{ record_id: ids.C, fields: { [textField]: "b-1" } }, { record_id: GHOST_ID, fields: { [textField]: "b-ghost" } }], ["C"]);
  await experiment("(c) one invalid field value", "is the whole call rejected (is D still 'init-D')? which record/field does the error name?",
    [{ record_id: ids.D, fields: { [textField]: "c-valid" } }, { record_id: ids.E, fields: { [numberField]: "this is not a number" } }], ["D", "E"]);
  await experiment("(d) the same record_id twice", "error, or does one value win? which one?",
    [{ record_id: ids.F, fields: { [textField]: "d-first" } }, { record_id: ids.F, fields: { [textField]: "d-second" } }], ["F"]);

  // (e) client_token replay. The text value carries a marker unique to this run, so the rows are found again by the marker alone.
  const marker = `e-${Date.now().toString(36)}`;
  const idsIn = (reply) => [reply.json?.data?.record?.record_id, ...(reply.json?.data?.records || []).map((r) => r.record_id)].filter(Boolean);
  const countMarked = async (label) => {
    const list = await call("GET", "/records?page_size=500");
    const marked = (list.json?.data?.items || []).filter((r) => r.fields?.[textField] === marker);
    say(`   rows carrying the marker after ${label}: ${marked.length}  ${JSON.stringify(marked.map((r) => r.record_id))}${list.json?.data?.has_more ? "  (table has more than 500 rows: count may be incomplete)" : ""}`);
    return marked.map((r) => r.record_id);
  };
  const replay = async (title, path, body) => {
    say(`\n=== ${title}`);
    say("question: same request twice with the same client_token: how many rows exist afterwards, and is the 2nd reply identical, a copy of the 1st, or an error?");
    say(`request: POST ${path}   body: ${JSON.stringify(body)}`);
    const first = await call("POST", path, body);
    say(`1st reply: HTTP ${first.status}${first.logId ? `   x-tt-logid ${first.logId}` : ""}\n   RAW: ${first.text}`);
    const second = await call("POST", path, body);
    say(`2nd reply: HTTP ${second.status}${second.logId ? `   x-tt-logid ${second.logId}` : ""}\n   RAW: ${second.text}`);
    say(`   same record id(s) in both replies: ${JSON.stringify(idsIn(first)) === JSON.stringify(idsIn(second)) && idsIn(first).length > 0}`);
    return countMarked(title);
  };
  const extra = new Set();
  const token1 = randomUUID(), token2 = randomUUID();
  (await replay("(e1) single create sent twice with the same client_token", `/records?client_token=${token1}`, { fields: { [textField]: marker, [numberField]: 1 } })).forEach((id) => extra.add(id));
  (await replay("(e2) batch_create sent twice with the same client_token", `/records/batch_create?client_token=${token2}`, { records: [{ fields: { [textField]: marker, [numberField]: 2 } }] })).forEach((id) => extra.add(id));
  say(`\n(e) total rows left carrying the marker: ${extra.size}   (1 + 1 = 2 would mean each repeated create was recognised as the same request)`);

  if (argv.includes("--cleanup")) {
    say("\n=== cleanup: deleting the rows this script created");
    for (const [key, id] of Object.entries(ids)) { const del = await call("DELETE", `/records/${id}`); say(`   deleted ${key} (${id}): HTTP ${del.status}`); }
    for (const id of extra) { const del = await call("DELETE", `/records/${id}`); say(`   deleted client_token row (${id}): HTTP ${del.status}`); }
  } else {
    say("\nThe rows above were left in the test table (run again with --cleanup to delete them).");
  }
  say("\nDone. Paste everything above (it contains no token).");
  return { ok: true, ids, clientTokenRows: [...extra] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBatchUpdateCheck().then((result) => { if (!result.ok) process.exitCode = 2; }).catch((error) => { console.error(scrub(error?.message || error)); process.exitCode = 1; });
}
