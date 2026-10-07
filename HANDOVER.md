# Customer Approaching widget — handover runbook

Not served to the public: the Pages middleware answers 404 for every root `*.md` file. Variable **names** only below; never put values in the repo.

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Widget (index.html, app.js, style.css, deployment-refresh.js, blast/, vendor/, knowledge/) | Cloudflare Pages project **test-1**, https://test-1-7wp.pages.dev | Auto-deploys every push to GitHub `Mex676767/Test-1` branch `main`. Output directory = repo root. |
| Backend endpoints | `functions/*.js` (Pages Functions) | One file per route; each exports `onRequest = adapt(handler)`. `_middleware.js` runs first. |
| Shared Lark queue | Worker **rtn-lark-rate-queue**, Durable Object `MyDurableObject`, bound to Pages as `LARK_SEARCH_QUEUE` | Source: `claude-lookup-review/worker-v2-deploy/src/index.ts`. Deployed by hand with wrangler. |
| Data | Lark Bitable base (`LARK_BASE_APP_TOKEN`), table `Customer Approaching` + bonus source tables | |
| Tickets | external ticket API (`TICKETS_*`) | |
| LiveChat | OAuth app(s) (`LIVECHAT_CLIENT_ID*`, `LIVECHAT_PAT*`) | Widget loads inside a LiveChat Agent App iframe. |

Request path for a lookup: widget → `/lark-search` → (Lark client in `functions/_lib/lark.js`) → Durable Object gate (FIFO, 250 ms start gap, 3 concurrent, merges searches, batches creates) → Lark.

## 2. Environment variables (names only)

Set in Cloudflare → Pages → test-1 → Settings → Variables and Secrets (Production). A change only takes effect on a **new deployment** (Retry deployment).

- Lark: `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_BASE_APP_TOKEN`, `LARK_TABLE_CUSTOMER_APPROACHING`, `LARK_TABLE_PNL`, `LARK_TABLE_REDEEM_CODE`, `LARK_TABLE_GRACE_PERIOD`, `LARK_TABLE_TOP_PNL_NIGHT`, `LARK_TABLE_LTV_DAY`, `LARK_TABLE_RISK_PLAYER`, `LARK_TABLE_SPECIAL_RELOAD`, `LARK_TABLE_VIP_BOOSTER`, `LARK_TABLE_TELEGRAM28`, `LARK_TABLE_MOONCAKE`, `LARK_TABLE_VS96_FEEDBACK`, `LARK_TABLE_BONUS_CONFIG`, `LARK_ESCALATION_BASE_TOKEN`, `LARK_ESCALATION_TABLE`
- LiveChat: `LIVECHAT_PAT`, `LIVECHAT_PAT_2`, `LIVECHAT_CLIENT_ID`, `LIVECHAT_CLIENT_ID2` (alias `LIVECHAT_CLIENT_ID_2`), `LIVECHAT_REDIRECT_URI`
- Tickets: `TICKETS_API_BASE_URL`, `TICKETS_API_KEY`, `TICKETS_MARKET_ID`, `TICKETS_TO_DEPARTMENT_ID`
- Queue behaviour flags:
  - `LARK_QUEUE_PROTOCOL=v2` — use the v2 long-poll protocol (required; currently set).
  - `LARK_BATCH_CREATE=1` — coalesce row creates into Lark `batch_create` (needs `LARK_QUEUE_PROTOCOL=v2` and a Durable Object that has `createBatch`). Remove the variable to go back to single creates.
  - `QUEUE_STATS_KEY` — enables `GET /queue-stats` (header `x-stats-key: <value>`). Unset = the endpoint returns 404.
- Binding (not a variable): `LARK_SEARCH_QUEUE` → Durable Object `MyDurableObject` of worker `rtn-lark-rate-queue`.

## 3. Deploying

**Widget / Functions:** merge to `main` and push. Cloudflare builds automatically. Check the Deployments tab shows the new commit as Production/Success. Never push a client file change without bumping its `?v=` in `index.html` / `blast/index.html` (scripts are `no-cache, must-revalidate`, but the bump is the safety net).

**Durable Object (by hand, from your own terminal — it needs your Cloudflare login):**

```bash
cd claude-lookup-review/worker-v2-deploy
npx wrangler deploy
```

**Deploy the Durable Object only when agents are quiet (off-peak).** A deploy restarts the object: for a moment every call to it fails ("Durable Object reset because its code was updated"), its in-memory state (queue, create memory, caches, stats) is lost, and lookups running at that instant can fail. On 2026-10-07 a deploy during working hours left two lookups with every source unavailable and two `caseRowError`s before anyone had tested anything. The Pages side now repeats most calls once after 300-500 ms (see section 12), which covers the gap of a normal restart, but the safest rule is: before `npx wrangler deploy`, look at `/queue-stats` `perMinute` (`totalStarts`, `isolates`) for the last few minutes and deploy only when they are near zero; deploy again to change nothing is also a restart.

**Rollback the Durable Object:**

```bash
npx wrangler deployments list --name rtn-lark-rate-queue
npx wrangler rollback <version-id> --name rtn-lark-rate-queue
```

Durable Object versions (newest first). **Current: `8a335abd-3cca-49e5-b548-4a2c4de4c9a1`. Rollback target: `ad9ff18c-8d49-4b00-ad09-aae0e228a110`** (same behaviour, without the throttle log fields / `limitedByLabel` / `limitedByCode` / `totalStarts`; the Pages code works with either). The older target before the token lane is `72f10be6-fef0-4537-959e-dd679e371635` (everything before the token lane; the Pages code tolerates it, and `LARK_BATCH_UPDATE` must be removed from Pages before rolling back to it, because only the newer DO splits batches by error code). The older target `387762b5-9d62-4d01-aa31-152907030586` is items A–D (`GATE_CONCURRENCY` was 3 then and the gate variables were set in the dashboard, not the file):
- `8a335abd-3cca-49e5-b548-4a2c4de4c9a1` — deployed after merge `e3b15d1`: throttle visibility (the `Lark rate limit` log line now has the call label, Lark code, HTTP status, Retry-After, `x-ogw-ratelimit-*` headers, table id and the new gap; stats `limitedByLabel`, `limitedByCode`, per-minute `totalStarts`, `limitedSearch` / `limitedWrite` / `limitedOther`) and the corrected file header comment. No pace, token-lane or batch_update change. See section 12.
- `ad9ff18c-8d49-4b00-ad09-aae0e228a110` — deployed after the 2026-10-07 merges (`8152500`/`52ce995` token lane, `fb76249` batch_update record-level split): token lane (`TOKEN_CONCURRENCY`=4 / `TOKEN_GAP_MS`=50 from `wrangler.jsonc`), per-minute search/update p95, token starts and isolates, and `updateBatch` that splits ONLY on record-level Lark codes (whole-call errors go to every caller). One intermediate DO version with only the token lane was deployed earlier the same day; its id was not recorded. `LARK_BATCH_UPDATE` was still off when this was written.
- `72f10be6-fef0-4537-959e-dd679e371635` — review follow-ups (ownership only from the agent's own row, same-record write ordering, Pages counter reports, per-minute history, `updateBatch` for the OFF-by-default batch_update, gate vars `GATE_CONCURRENCY`=4 / `GATE_START_GAP_MS`=250 from `wrangler.jsonc`). Deployed.
- `387762b5-9d62-4d01-aa31-152907030586` — items A–D (request-age ordering, `larkCall`/`cachedCall`, labels).
- `2b76c017-f4f7-46e3-ada3-fde4139c21ca` — steps 0–3 (diagnostics, identical-create sharing, client_token + one retry).
- `b8491272-767a-472a-8835-ff5bbd00179c` — first version with `createBatch`.
- `d357b841-4199-409e-acd2-659a6dd2faa3` — before `createBatch` (keep `LARK_BATCH_CREATE` off if you roll back to it).
Rolling back to `387762b5…` also removes the gate variables from the Worker (they came from the file), so the code defaults (concurrency 3, gap 250 ms) apply until you set them again.

**Rollback the widget:** Cloudflare → test-1 → Deployments → pick an older Success deployment → Rollback; or `git revert` the commit and push.

## 4. Tests and CI

```bash
node --test functions/*.test.js tests/*.test.mjs
node --no-warnings --test claude-lookup-review/proposal/worker-v2/gate.test.mjs
```

GitHub Actions (`.github/workflows/ci.yml`) runs both on every push and pull request, then a third step, `node scripts/runtime-smoke.mjs`: it starts the Functions in the real Workers runtime (`wrangler pages dev`, wrangler 3.114.17 = what Cloudflare's Pages build used, `nodejs_compat` on) and calls `/hello` plus a hidden path. It exists because Node accepts things Cloudflare refuses to publish; the first token-lane build failed that way ("Disallowed operation called within global scope", a `crypto.randomUUID()` at module top level). The smoke step makes no Lark, LiveChat or ticket call and needs no secrets. `functions/global-scope.test.js` is the fast Node-side version of the same guard. Tests use fakes only — they never call Lark, LiveChat or the ticket API. Simulator for the queue under load: `claude-lookup-review/proposal/sim/`.

Load test: `node scripts/stress-lookup.mjs --base <staging url> --agents 100 [--users players.txt] [--rounds 3]` sends N simultaneous read-only (`preview`) lookups and prints p50/p95/max. It refuses the production host (and `--write`, which creates rows, is only for a staging copy with its own Lark base). **Stop guard** (`scripts/stress-guard.mjs`): with the queue's stats key in the environment (`QUEUE_STATS_KEY`, or the variable named by `--stats-key-env`; the value is never printed) it takes a `/queue-stats` snapshot before and after every round and (a) refuses to start a round unless `gapMs` equals the base gap (`--base-gap-ms`, default 250) and the queue is idle, i.e. it is not still backed off from an earlier throttle; (b) stops after a round with more than `--max-non-200` (default 2) non-200 answers, or if `limited` / `retries429` / `tokenLimited` went up or `gapMs` rose, prints the snapshots and exits non-zero. Against production the key is required (`--no-queue-guard` keeps only the HTTP check). It needs a staging Pages project + separate Lark base to be fully realistic; the in-repo simulator covers the queue logic without Lark.

## 5. Watching it

- Cloudflare → Pages → test-1 → Functions → real-time logs. Look for: `Lark rate limit`, `Lark queue fail-open`, `Case row not saved`, `Lark lookup source unavailable`, `Lark queue has no createBatch`.
- Queue numbers: `curl -H "x-stats-key: <QUEUE_STATS_KEY>" https://test-1-7wp.pages.dev/queue-stats`. Fields to read: `limited` and `retries429` (Lark throttling; should stay ~0), `queueWaitP50` / `queueWaitMax` (ms), `meanBatch`, `peakStartsPerSec`, `createBatches` / `createdInBatches`, `createMismatches` and `orphanFallbacks` (must stay 0), `peakQueue`, `gapMs` (the gate's current gap; it rises after a 429).
- Worker logs: Cloudflare → Workers → rtn-lark-rate-queue → Logs (observability is enabled).
- Diagnostics added to `getStats()` (all in ms): `permits.<token|read|write>.wait` (permit requested → granted) and `.hold` (granted → released), each with `n/p50/p95/max`; `lark.<search|batchCreate|create|other>` = latency of each kind of upstream call. If `wait` is large and `hold` is small, the gate pace is the limit; if `hold`/`lark` are large, Lark itself is slow. New counters: `createMemoryHits`, `createSharedInflight`, `writeRetries`.
- Items A–D (request-age ordering, calls run inside the queue, ownership via merged search, shared cached reads): `getStats()` also has `labels` (permit/call counts by purpose: token, fields, list, record-get, update, delete, create, search, other), `lark.<get|update|delete|list|fields|…>` latency, and `cacheHits` / `cacheShared` / `cacheStaleServed` / `cacheEntries` / `larkCalls`. Pages side counters (`larkClientStats`): `queueCallFallbacks` (the queue lacked larkCall/cachedCall and the old permit path was used) and `ownershipFallbacks` (the merged ownership search missed and the single-record GET decided).
- Follow-up (review of A–D): `getStats()` also has `startedAt` / `uptimeSec` (this queue instance), `pagesCounters` (what Pages reports fire-and-forget: `queueCallFallback`, `ownershipFallback:<noUsername|noAgent|missing|blankOwner|otherOwner|searchError>`, `failOpen`, `caseRowError`, `lookupWarning:<source>`, `lookupHardDeadline`, `noRequestStart`), `writesSuperseded` (a newer queued write for the same record replaced an older queued one) and `perMinute` (last 24 h, columnar: `minutes` = epoch minutes, `starts`, `limited`, `waitP95` ms, `peakQueue`; idle minutes are not stored).
- Ownership rule: a submit is allowed from the merged search ONLY when the search shows this agent as the row's owner; a blank owner, another owner, a missing row, a failed search or an old widget (no username) are decided by the single-record GET (counted by reason).
- Batch updates (`LARK_BATCH_UPDATE=1` on Pages, OFF by default; needs `LARK_QUEUE_PROTOCOL=v2` and a queue with `updateBatch`): submits' updates share Lark's `batch_update`. What Lark documents and what it does not: `claude-lookup-review/LARK_BATCH_UPDATE_NOTES.md`. Watch `updateBatches`, `updatedInBatches`, `updateSplits`, `updateMismatches`, `lark.batchUpdate`. Off = single PUTs run inside the queue.
- Requires the Pages `nodejs_compat` compatibility flag (already set on production): request start times use `AsyncLocalStorage`.
- Worker variables (rtn-lark-rate-queue): `GATE_WRITE_TIMEOUT_MS` (default 15000, creates/writes), `CREATE_MEMORY_MS` (default 120000; identical creates with a chat link share one row; 0 = off), `TOKEN_CONCURRENCY` (default 4) and `TOKEN_GAP_MS` (default 50): the token lane, see section 10. The gate and token variables are set from `wrangler.jsonc`.
- Per-minute columns added: `searchP95`, `updateP95` (ms, upstream Lark latency), `tokenStarts` (token-lane starts; NOT counted in `starts`) and `isolates` (distinct Pages isolates that reported that minute; each isolate sends a random id with its counter reports and at most one idle heartbeat per 5 s). `getStats()` also has `tokenLane` (concurrency, gapMs, active, queued) and `tokenLimited`.

## 6. Raising the gate pace (only with evidence)

Default is a 250 ms gap and 3 concurrent. Ramp 200 → 150 → 125 → 100 ms only after a full peak day at each step with `/queue-stats` showing no 429s (`limited` and `retries429` flat) and `queueWaitP50` low. Any 429 burst: go back one step (the gate also slows itself down after a 429). The pace comes from the Worker variables `GATE_START_GAP_MS` (code default 250) and `GATE_CONCURRENCY` (code default 3) on the **rtn-lark-rate-queue** worker, not on Pages; `GATE_LONGPOLL_MS` is the long-poll window.

**The repo is the source of truth for the pace.** The two values are in `claude-lookup-review/worker-v2-deploy/wrangler.jsonc` under `"vars"` (currently `GATE_CONCURRENCY` "4", `GATE_START_GAP_MS` "250"). Change the pace by editing that file and running `npx wrangler deploy`, or change it in the dashboard AND edit the file to match: a later `wrangler deploy` replaces the Worker's variables with the ones in the file, so a dashboard-only change would be silently undone. `keep_vars` is deliberately not used. Only non-secret numbers belong in that file.

## 7. Batched creates (`LARK_BATCH_CREATE`)

Lark does not document the order or atomicity of `batch_create`, so the Durable Object matches created rows back to callers by content and **fails closed** (the lookup shows "Case row not saved — press Look Up again") on any mismatch. After enabling, check: every chat has its own row with the right Username/Brand/Agent/link; no blank duplicate twins; `createMismatches` = 0. To turn it off: delete the variable and Retry deployment.

## 8. Known limits and open items

- **No authentication on any endpoint** (decision pending). The middleware only hides non-widget files; the API is reachable by anyone who knows the URL. Options discussed: LiveChat OAuth-token check in `_middleware.js` (log-only phase first), Cloudflare Access for admin pages, require a custom header on writes, WAF rate limits.
- Real Lark behaviour still to confirm in production: HTTP status for TooManyRequest (code 1254290), write quotas, `is` operator case sensitivity.
- The update notice baseline is the first `/widget-version` answer after load; a deploy landing in those few seconds is announced one deploy late. Harmless.
- `/release.json` is served from an old direct-upload deployment (not in git) and is unused unless a page carries a `widget-release` meta tag (only `scripts/deploy.ps1` releases do).
- Repo files are mixed CRLF/LF; edits to `app.js` should preserve each line's ending.
- Hidden from the public site: `/claude-lookup-review`, `/tests`, `/scripts`, `/mockups`, `/output`, `/functions`, root `*.md|ps1|zip|log`, any root dot-path. A test fails if a new top-level path is committed without being classified.

## 9. Map of the code

- `app.js` — whole widget UI/state; `style.css`; `deployment-refresh.js` (update notice only; ⟳ Refresh does the reload).
- `blast/` — bulk-send UI embedded as an iframe (`popup.js`, `web-adapter.js` journal/checkpoint sends; never resend on unconfirmed delivery).
- `functions/lark-search.js` — the lookup; time budgets near the top (first pass 22 s, retry ≤14 s, total ≈36 s; widget aborts at 45 s).
- `functions/_lib/lark.js` — Lark client, paging, rate-limit handling, queue calls.
- `functions/_middleware.js`, `_routes.json`, `_headers` — hiding, routing, caching.
- `functions/widget-version.js` — release id used by the update notice. `functions/queue-stats.js` — queue metrics.

## 10. Lark access tokens: the token lane and invalid-token handling

**Token lane.** Fetching Lark's tenant token (one per Pages isolate, cached for ~2 h) goes through the queue as a `token` permit. Token permits have their OWN limiter in the Durable Object (`TOKEN_CONCURRENCY` 4 at a time, `TOKEN_GAP_MS` 50 ms apart) and take no slot, start gap or priority from the read/write gate. A wave of cold isolates after a deploy therefore cannot delay lookups or submits; it only delays the isolates that are waiting for their own token (about 2.5 s for 30 isolates in the simulator). Watch `tokenLane`, `permits.token` and `perMinute.tokenStarts` / `isolates` in `/queue-stats`.

**Invalid-token handling.** Lark's generic error codes for access tokens (table at https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code , same page in the Lark docs: https://open.larksuite.com/document/server-docs/api-call-guide/generic-error-code ; how to fix 99991663: https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-99991663-error). What the code does with each:

| Code | Lark's message | Meaning | What the app does |
|---|---|---|---|
| **99991663** | Invalid access token for authorization | the tenant_access_token expired or is wrong | **drops the cached token, fetches a new one, retries the call ONCE** (counted `tokenRefreshRetry`); a second invalid reply is returned as the error, no loop |
| 99991661 | Need a token | no Authorization header | a bug in the request: **no retry**, counted `authBug:99991661` |
| 99991664 | invalid app token | malformed app_access_token | bug: no retry, counted `authBug:99991664` |
| 99991665 | invalid tenant code | malformed tenant_access_token | bug: no retry, counted `authBug:99991665` |
| 99991671 | Invalid token: must start with t-/u- | token format wrong | bug: no retry, counted `authBug:99991671` |
| 99991668, 99991677, 99991679 | user_access_token problems | not used by this app | not handled |
| 99991672 / 99991673 | missing scope / unauthorized app | app configuration | not retried |

Who retries: Pages retries its own calls; for calls the queue runs (record get/update/delete, shared reads) the queue returns Lark's error and Pages repeats the whole call with the new token. The token / Authorization value never appears in stats, labels, logs or error text (`scrubSecrets` removes anything shaped like one). The doc page for 99991663 does not state the token's lifetime; the app uses the `expire` value Lark returns with the token.

## 11. Checking how Lark's batch_update really behaves (one-off, by hand)

`scripts/lark-batch-update-check.mjs` runs five experiments (valid batch; one non-existent record_id; one invalid field value; the same record_id twice; and (e) the same create sent twice with the same `client_token`, once as a single create and once as batch_create, printing both replies and how many rows exist afterwards, which settles whether the queue's retry of a timed-out create with the same token is safe) against a DEDICATED TEST TABLE (never an application table: it refuses a table id equal to any `LARK_TABLE_*` variable), reads every row back and prints Lark's raw replies without the token. Needs `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_BASE_APP_TOKEN`, `BATCH_TEST_TABLE_ID` (and optionally `BATCH_TEST_TEXT_FIELD` / `BATCH_TEST_NUMBER_FIELD`, default "Text" / "Number"), and the flag `--i-understand-this-writes-to-a-test-table`; `--cleanup` deletes the rows it created. The real-Lark results of 2026-10-07 are recorded in `claude-lookup-review/LARK_BATCH_UPDATE_NOTES.md`: a bad record_id or field value rejects the WHOLE call (HTTP 200 + code), nothing is applied; duplicates in one batch: last wins; client_token repeats return the same record. The queue splits a batch ONLY on record-level codes (1254043 shortcut: fail that record, re-send the rest as one batch; FieldConvFail family: bisect); any other error (token, permission, table, unknown code) goes to every caller at once, no split. New stats counters: `updateRecordRejects`, `updateWholeCallErrors` (next to `updateBatches`, `updatedInBatches`, `updateSplits`, `updateMismatches`). To turn batching on after the DO with this rule is deployed: set Pages env `LARK_BATCH_UPDATE=1` (remove it to go back to single PUTs).

## 12. Seeing throttles, and surviving a Durable Object restart

**Throttle visibility (Durable Object).** Every throttle Lark answers (HTTP 429, code 1254290 or 99991400) is now logged and counted with what Lark said. The log line is `Lark rate limit {label, httpStatus, code, retryAfter, ratelimit: {retry-after, x-ogw-ratelimit-*}, table, logId, gapMs (the NEW, doubled gap), baseGapMs, active, queued, startsLastSecond, tokenActive}`; it never contains a token. `label` is the kind of call: search, create, batchCreate, update, batchUpdate, get, delete, list, fields, token (a throttled token fetch, reported by Pages) or ticket (a call run by Pages with a permit). In `/queue-stats`:
- `limitedByLabel` and `limitedByCode`: totals since the object started, main gate AND token lane (the plain `limited` counts only the main gate, `tokenLimited` only the token lane).
- `perMinute` new columns: `totalStarts` (= `starts` + `tokenStarts`: every request the queue let out to Lark that minute, i.e. the real Lark request rate), and `limitedSearch` / `limitedWrite` / `limitedOther` (throttles by kind of call; other = get, list, fields, token, ticketed calls; token-lane throttles included).
**What a throttle really looks like (confirmed in the production Worker logs, 2026-10-07 21:35:51 GMT+8):** `{"httpStatus":200,"code":1254290,"retryAfter":null}`. Lark's "TooManyRequest" (1254290) arrives on **HTTP 200** with **no Retry-After header**, so (a) detection must stay **code-based, never status-based** (the DO's `isRateLimited` and Pages' `isLarkRateLimited` test the code 1254290 / 99991400 as well as HTTP 429; a status-only check would miss it), and (b) the back-off cannot use Lark's own advice: it uses the queue's cooldown (at least 1 s) and the doubled gap. 1254290 is Bitable's own limit, most likely **per Base** and therefore **shared with everything else that uses the Base, such as its Lark automations / workflows, which our queue cannot see**. A throttle at only about 4 starts/s from us does not prove we exceeded 20 req/s: look at `totalStarts` per minute together with what else runs on the Base before concluding anything about the pace.

A throttle doubles the gap (AIMD: 250 -> 500 ms, then it shrinks by 20% per 20 successful calls), so a single throttle leaves the queue slower for a while: check `gapMs` before the next test.

**Surviving a restart (Pages).** A call to the queue that fails with a restart / lost-connection error ("Durable Object reset because its code was updated", "Network connection lost", "... was reset", or a remote error flagged retryable and not overloaded) is repeated ONCE after 300-500 ms, for permits (acquire), searches, record get/update (larkCall except DELETE), batch updates and shared cached reads. Not repeated: createBatch (the queue's client_token and create memory are lost with the reset, so a create that already committed could be made twice; the lookup's duplicate check on the chat link covers a failed create), DELETE, our own timeouts, and any other error. Pages counters (in `pagesCounters`): `doRetry:<codeUpdated|connectionLost|reset|retryable>` (a call was repeated), `doFailed:<method>` (a queue call failed for good, after any repeat; before this, only a missing method was visible, as `queueCallFallback`) and `batchFallback` (a search batch failed and the direct permit path was used).
