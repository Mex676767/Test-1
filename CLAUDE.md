# Customer Approaching — project guide for Claude

## What this project is
The **Customer Approaching** widget: a small web app that runs inside LiveChat's agent sidebar and helps a retention / customer-service team handle VIP players. Live at https://test-1-7wp.pages.dev (Cloudflare Pages project `test-1`, auto-deploys GitHub `Mex676767/Test-1` branch `main`).

What agents use it for:
- **Look up a player.** The agent enters a username and brand during a chat. The widget checks about ten Lark tables (P&L tier, top-spender and LTV bonuses, grace period, risk player, VIP booster and others) and shows which bonuses the player is eligible for.
- **Claim and record cases.** Each chat gets one row in the Lark base's *Customer Approaching* table. When the chat closes, the case is recorded with inquiry type, status, released amount and chat link. A "needs attention" list catches chats that closed without being recorded.
- **Blast.** A tab that sends one message and an image to many past chats at once from a pasted list of links. It keeps a journal so a reload never sends anything twice, and it closes any chat it had to reopen.
- **Extras.** Escalation tickets (external ticket system), a knowledge assistant, an admin page for custom bonus rules.

Chat logging to Lark is automatic only while the agent is on the **Retention** tab; any other tab (Blast, Tickets, Knowledge, future ones) pauses it, and a chat closed meanwhile is recorded later by the background sweep.

## How it is built
- **Widget:** plain HTML / JavaScript / CSS. Main code `app.js`; Blast in `blast/`; `deployment-refresh.js` only shows a "new version available" notice (agents click ⟳ to update).
- **Backend:** Cloudflare Pages Functions in `functions/`, one endpoint per file (`export const onRequest = adapt(handler)`). `functions/_middleware.js` answers 404 for everything that is not widget/API (docs, tests, scripts, dot-paths). Lark client: `functions/_lib/lark.js`.
- **Shared Lark queue:** one Durable Object (Worker `rtn-lark-rate-queue`, source `claude-lookup-review/worker-v2-deploy/src/index.ts`, identical copy in `claude-lookup-review/proposal/worker-v2/index.ts`) gates all Lark traffic: merges searches and creates, orders work by request age, runs record get/update/delete, caches rarely-changing reads, optional batch updates. Its stats are at `GET /queue-stats` (header `x-stats-key`).
- **Data:** Lark Bitable. **Auth:** none on the API yet (decision pending; do not add it unasked).

## Rules to follow
- **Tests:** `node --test functions/*.test.js tests/*.test.mjs` and `node --no-warnings --test claude-lookup-review/proposal/worker-v2/gate.test.mjs`. Both must pass before merging; CI runs them. Tests use **fakes only** — never call live Lark, LiveChat or ticket APIs from tests.
- **Keep the two Durable Object copies identical** (`diff -q` the two `index.ts`).
- **Client cache:** JS/CSS are served `no-cache, must-revalidate`, but still bump the `?v=` on any changed client file in `index.html` / `blast/index.html`.
- **Branches:** work on a separate branch; merge to `main` only when the user says so. Merging deploys Pages automatically. The user deploys the Durable Object themselves (`npx wrangler deploy` from `claude-lookup-review/worker-v2-deploy`; Windows PowerShell has no `&&`, give two separate commands).
- **Pace settings** (`GATE_CONCURRENCY`, `GATE_START_GAP_MS`) live in `claude-lookup-review/worker-v2-deploy/wrangler.jsonc`; change the file and deploy. No secrets in that file.
- **Never** commit secrets, `.env` files or stats keys; do not print credential values.
- **Production tests** (bursts against the live site) create real rows in Lark with `zz…` usernames; the user deletes them. Do not delete production data yourself. Keep bursts ≤ about 70 requests.
- **Editing files:** `app.js` and most files use mixed CRLF/LF line endings; preserve each line's ending. The Bash tool mangles backslashes — write scripts with the Write tool.
- Do not lengthen the 2 s chat-status poll, and do not change Blast's checkpoint/journal duplicate-send protection, without asking.

## Where to look
- `HANDOVER.md` — runbook: architecture, variable names, deploy/rollback, DO versions, monitoring, known limits.
- `claude-lookup-review/` — Durable Object source, load simulator (`proposal/sim/`), review reports, Lark batch-update notes. Hidden from the public site.
- `scripts/stress-lookup.mjs` — guarded load-test script (refuses the production host).
- Memory notes for this project are under `C:\Users\faizf\.claude\projects\C--Users-faizf-Documents-WORK-Test-1\memory\`.
