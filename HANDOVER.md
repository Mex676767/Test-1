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

**Rollback the Durable Object:**

```bash
npx wrangler deployments list --name rtn-lark-rate-queue
npx wrangler rollback <version-id> --name rtn-lark-rate-queue
```

Durable Object versions (newest first). **Current: `72f10be6-fef0-4537-959e-dd679e371635`. Rollback target: `387762b5-9d62-4d01-aa31-152907030586`** (items A–D; `GATE_CONCURRENCY` was 3 then and the gate variables were set in the dashboard, not the file):
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

GitHub Actions (`.github/workflows/ci.yml`) runs both on every push and pull request. Tests use fakes only — they never call Lark, LiveChat or the ticket API. Simulator for the queue under load: `claude-lookup-review/proposal/sim/`.

Load test: `node scripts/stress-lookup.mjs --base <staging url> --agents 100 [--users players.txt] [--rounds 3]` sends N simultaneous read-only (`preview`) lookups and prints p50/p95/max. It refuses the production host (and `--write`, which creates rows, is only for a staging copy with its own Lark base). It needs a staging Pages project + separate Lark base to be fully realistic; the in-repo simulator covers the queue logic without Lark.

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
- Worker variables (rtn-lark-rate-queue): `GATE_WRITE_TIMEOUT_MS` (default 15000, creates/writes), `CREATE_MEMORY_MS` (default 120000; identical creates with a chat link share one row; 0 = off).

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
