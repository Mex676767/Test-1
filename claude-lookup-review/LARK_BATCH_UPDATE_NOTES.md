# Lark `batch_update` (records) — what the documentation says, and how the code is built around what it does NOT say

Source: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_update (fetched while preparing the flag-off implementation; re-check before turning the flag on).

## Documented
- `POST https://open.larksuite.com/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_update`
- Limit: "单次调用最多更新 1,000 条记录" — up to **1,000 records per call**.
- Rate limit: "50 次/秒" — **50 requests per second** (per this endpoint).
- Request body: `{ "records": [ { "record_id": "...", "fields": { ... } }, ... ] }`.
- Query parameters listed: `user_id_type` (optional), `ignore_consistency_check` (optional, skips the read-write consistency check for performance). **`client_token` is not listed for this endpoint** (it is for create).
- Response: `code` (0 = success), `msg`, `data.records` = the updated records with their `fields` and `record_id`.

## MEASURED against real Lark (2026-10-07, production base, a dedicated test table, via scripts/lark-batch-update-check.mjs)
Recorded as reported by the operator; the raw reply text of each experiment is not reproduced here (paste the script's output below if it is wanted verbatim).
- **(a) valid batch:** every record applied; reply `data.records` in **request order**, each with `record_id` and **only the fields that were sent**.
- **(b) one non-existent record_id:** the **WHOLE call is rejected, nothing is applied**. HTTP **200**, code **1254043**, msg `record not found,id = <id>` (the record IS named).
- **(c) one invalid field value:** the **WHOLE call is rejected, nothing is applied**. HTTP **200**, code **1254061** `NumberFieldConvFail`; the record is **NOT named**.
- **(d) the same record_id twice in one batch:** success, the **last value wins**.
- **(e) client_token on create and batch_create:** a repeat returns the **SAME record(s)**; no duplicate row (the queue's retry of a timed-out create with the same token is safe).

Error codes (table at the bottom of the batch_update page, fetched 2026-10-07): record-level = 1254006, 1254015, 1254043, 1254044, 1254045, 1254060-1254069 (the *FieldConvFail family), 1254072, 1254074, 1254130. Everything else is about the call, not a record (auth 99991663 and friends, 1254302/1254304 permission denied, 1254003/1254004/1254040/1254041 base or table wrong, 1254291 write conflict, 1254607/1254608, 1255xxx internal).

## Was NOT documented (the page says nothing; the measurements above answer it)
- Whether the call is **all-or-nothing** (atomic) or can **partially succeed**.
- How a **per-record error** is reported (one bad `record_id` / field).
- Whether the order of `data.records` follows the request.
- Any idempotency token for updates.

## How the implementation copes (so the unknowns cannot corrupt data)
- **Whole-call success only is trusted.** A reply with `code` ≠ 0 or a non-2xx status is treated as "the batch failed", regardless of whether Lark might have applied part of it.
- **Updates are idempotent** (the same field values written again leave the same row), so re-sending is always safe — which is what retries and splits rely on. Same-record writes are ordered by the per-record queue, so a re-sent older value can never land after a newer one.
- **Results are matched by `record_id`, never by position.** A record missing from a success reply is NOT assumed updated: that caller's write is re-sent as an ordinary single PUT.
- **One retry** (same body) on a transient failure (timeout / transport error / 5xx). A second transient failure is returned to the callers (they retry like any failed write).
- **What an error does depends on its code** (`RECORD_LEVEL_UPDATE_CODES` in the queue; decided after the one transient retry):
  - **whole-call error** (token invalid 99991663 and the other auth codes, permission denied, table not found, write conflict, any code NOT known to be record-level, a non-JSON non-2xx reply): returned to **every** caller immediately. **No split, no re-send**: the same error would come back for every half. (For 99991663 Pages then refreshes the token and repeats the whole call once.) Counted `updateWholeCallErrors`.
  - **1254043 record not found:** the record id is parsed from msg; only that caller gets the error, and the rest are re-sent as ONE batch (so one ghost in 50 = 2 batch calls). Counted `updateRecordRejects`. If the id cannot be parsed the batch is bisected instead.
  - **other record-level codes** (FieldConvFail family, field not found, ...): the reply does not name the record, so the batch is bisected (halves, recursively); a lone record is sent as an ordinary PUT and gets its own error. Counted `updateSplits`. 50 records with one bad value cost about 7 batch calls.
  - **duplicates** never reach Lark: a newer write for a record that is still queued is merged into the older one (newest values win), so a batch never contains a record id twice.
- **Ownership (409) is decided BEFORE a write reaches the batch**: `lark-record.js` checks the row's owner first and never calls the update for another agent's row; the queue only ever sees writes that passed it.
- A lone pending update is sent as an ordinary PUT (no batch of one).
- Off by default. Switch: Pages env `LARK_BATCH_UPDATE=1` (needs `LARK_QUEUE_PROTOCOL=v2` and a Durable Object that has `updateBatch`); removing the variable returns to single PUTs run inside the queue.

## Rate limiting (confirmed from production Worker logs, 2026-10-07 21:35:51 GMT+8)
Lark's throttle arrives as `{"httpStatus":200,"code":1254290,"retryAfter":null}`: **TooManyRequest comes on HTTP 200 with NO Retry-After header.** 1254290 is Bitable's own limit, **likely per Base**, so it is probably shared with the Base's Lark automations / workflows, which our queue cannot see. Consequences for `batch_update` and everything else: **detection stays code-based, never status-based** (a whole-call 1254290 on a batch_update is returned to every caller and the gate backs off; it is not a record-level error and never splits a batch), and a throttle at low request rates from this app is not proof that the app alone exceeded Lark's documented per-endpoint limits (search 20/s, batch_update 50/s).

## Before enabling in production
1. Done: atomicity and error shapes measured (above).
2. Deploy the Pages side and the Durable Object that has this split rule (`updateBatch` with `RECORD_LEVEL_UPDATE_CODES`) first.
3. Enable on Pages (`LARK_BATCH_UPDATE=1`), watch `updateBatches`, `updatedInBatches`, `updateSplits`, `updateMismatches`, `lark.batchUpdate` in `/queue-stats`.
