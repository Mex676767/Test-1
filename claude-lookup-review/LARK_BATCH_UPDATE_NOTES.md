# Lark `batch_update` (records) — what the documentation says, and how the code is built around what it does NOT say

Source: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_update (fetched while preparing the flag-off implementation; re-check before turning the flag on).

## Documented
- `POST https://open.larksuite.com/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_update`
- Limit: "单次调用最多更新 1,000 条记录" — up to **1,000 records per call**.
- Rate limit: "50 次/秒" — **50 requests per second** (per this endpoint).
- Request body: `{ "records": [ { "record_id": "...", "fields": { ... } }, ... ] }`.
- Query parameters listed: `user_id_type` (optional), `ignore_consistency_check` (optional, skips the read-write consistency check for performance). **`client_token` is not listed for this endpoint** (it is for create).
- Response: `code` (0 = success), `msg`, `data.records` = the updated records with their `fields` and `record_id`.

## NOT documented (the page says nothing)
- Whether the call is **all-or-nothing** (atomic) or can **partially succeed**.
- How a **per-record error** is reported (one bad `record_id` / field).
- Whether the order of `data.records` follows the request.
- Any idempotency token for updates.

## How the implementation copes (so the unknowns cannot corrupt data)
- **Whole-call success only is trusted.** A reply with `code` ≠ 0 or a non-2xx status is treated as "the batch failed", regardless of whether Lark might have applied part of it.
- **Updates are idempotent** (the same field values written again leave the same row), so re-sending is always safe — which is what retries and splits rely on. Same-record writes are ordered by the per-record queue, so a re-sent older value can never land after a newer one.
- **Results are matched by `record_id`, never by position.** A record missing from a success reply is NOT assumed updated: that caller's write is re-sent as an ordinary single PUT.
- **One retry** (same body) on a transient failure (timeout / transport error / 5xx). A second transient failure is returned to the callers (they retry like any failed write).
- **Non-transient errors split the batch** (halves, recursively) so one bad record cannot fail the others; a lone record gets its own error.
- **Ownership (409) is decided BEFORE a write reaches the batch**: `lark-record.js` checks the row's owner first and never calls the update for another agent's row; the queue only ever sees writes that passed it.
- A lone pending update is sent as an ordinary PUT (no batch of one).
- Off by default. Switch: Pages env `LARK_BATCH_UPDATE=1` (needs `LARK_QUEUE_PROTOCOL=v2` and a Durable Object that has `updateBatch`); removing the variable returns to single PUTs run inside the queue.

## Before enabling in production (suggested)
1. Re-read the page above (atomicity / per-record errors may have been documented since).
2. Try it once against a sandbox row set: one batch with a deliberately bad `record_id` — does Lark apply the other records? That answers the atomicity question for real.
3. Enable on Pages, watch `updateBatches`, `updatedInBatches`, `updateSplits`, `updateMismatches`, `lark.batchUpdate` in `/queue-stats`.
