# C9 Tickets integration

The LiveChat widget creates tickets and reads their latest status through the
C9 Tickets REST API. The API key remains in the Cloudflare Pages environment;
the browser calls only this project's `/ticket-*` functions.

Configure these environment variables on the deployed Pages project:

- `TICKETS_API_KEY` — a developer-issued `tmk_...` key owned by a user whose
  role can view and create the relevant tickets.
- `TICKETS_TO_DEPARTMENT_ID` — the numeric ID of the department that receives
  tickets raised from this widget.
- `TICKETS_MARKET_ID` — optional numeric market ID applied to new tickets.
- `TICKETS_API_BASE_URL` — optional; defaults to
  `https://tickets.96ghq.com/api/v1`.

After saving the variables, redeploy the Pages project. The widget reads the
live ticket field catalog. The API catalog does not include SELECT choices, so
the app includes the choices verified in the live dashboard and accepts typed
exact values for new choices added later.

The admin Tickets workspace supports search, record details, status checks and
ticket creation. Files can be selected or pasted and are attached during
creation. Opened tickets are watched every 30 seconds while the Tickets tab is
active; the app reports status, comment-count, file-count, or updated-time
changes in its notification panel.

The admin preview opens with a compact inbox. All, Active and Solved filters
share one list; the filter button exposes agent, status, department and market
filters. Opening a ticket and creating a new ticket each use their own view.
Additional form fields and ticket details are collapsible, and form drafts and
chosen attachments remain available when returning to the inbox. Tickets stay
hidden in the installed LiveChat widget (`DEPARTMENT_TABS_LIVE = false`).

The ticket API currently supports list, read, and create. It does not expose an
update route, comment contents, comment posting, history, or log entries. The
app shows their counts and links to the dashboard, but those website features
cannot be replicated until matching REST endpoints are added.

## Images in R2 and the ticket author

**Images.** Bind an R2 bucket to the Pages project as `TICKET_IMAGES` (Settings → Bindings → R2 bucket). PNG, JPG and WEBP
files (up to 5MB each, PDFs stay under 1MB) are then stored in the bucket and the ticket gets their links (appended to the remarks, or to the field named by
`TICKETS_IMAGE_LINKS_FIELD`) instead of the files; PDFs are still attached. A link is `TICKET_IMAGES_PUBLIC_URL/<key>` if the
bucket has a public address, otherwise `/ticket-image?k=<key>` on this site. The key contains a random UUID, so a link cannot be
guessed, but anyone holding it can open the image. Add an R2 lifecycle rule if old images should expire. Without the binding
nothing changes: images are attached as before.

**Author.** The ticket API records the API key's owner as the author, so the widget also sends the signed-in agent's LiveChat id
(the account_id UUID) and email in ticket fields. Set `TICKETS_AUTHOR_ID_FIELD` and `TICKETS_AUTHOR_EMAIL_FIELD` to the field keys
the ticket team created. The server asks LiveChat who the agent's token belongs to, so the browser cannot choose the author. Once a
field is set, a ticket without a valid LiveChat login is refused.

**All LiveChat users.** `GET /livechat-agents` with header `x-agents-key: <LIVECHAT_AGENTS_KEY>` lists every agent of both
LiveChat accounts (`account`, `email`, `name`, `role`) and, for agents who have signed in to the widget, their `login` (the
account_id UUID) and `agentName`. The accounts' Personal Access Tokens need the `agents--all:ro` scope. Unset key = 404.

## Choice lists and the request limit

**Choice lists.** The ticket API has no call for the dropdown choices, the departments or the markets (`GET /tickets` lists the fields
without choices). The ticket system's docs page (`https://tickets.96ghq.com/api-docs`, "Fields you can post") does list them, so
`functions/_lib/ticket-catalog.js` is a snapshot of that page: every choice with its display label and stored value, the 20 departments
and the 9 markets. `/ticket-config` offers the catalog first, then any value real tickets carry that the catalog does not know, so a
stale snapshot hides nothing. If the API ever lists a field's choices itself, those come first. The widget shows the labels everywhere
(title, detail rows, filters, the create form). **When the ticket team changes a list, refresh the snapshot** (open the docs page,
expand every "+N more", copy the lists into the file, update `CATALOG_SNAPSHOT_DATE`). Drop the file once the API serves the lists as JSON.

**Request limit.** Each API key may make 120 requests a minute, shared by every agent. To stay inside it: ticket and inbox reads are
shared for 10 s / 15 s per isolate (identical reads in flight at once are one call; `?fresh=1`, sent for Refresh, search and opening a
ticket, skips the copy); the 30 s ticket poll pauses while the widget is hidden; after a 429 an isolate stops calling for the
`Retry-After` seconds and the agent sees "The ticket system is busy ... Try again in N s". Watch for that message when more agents
use Tickets (the Customer Service rollout).

## Live lists and raising tickets as the agent (2026-10-15)

**Live lists.** The ticket API now has `GET /markets`, `GET /departments` and `GET /fields/choices` (live from its database: real ids,
display labels, an active flag per choice, retired choices flagged). `/ticket-config` reads all three together with the ticket list and
the widget shows them as they are; departments that cannot receive tickets are left out of the create form. Each list falls back to
the snapshot in `functions/_lib/ticket-catalog.js` on its own if it cannot be read, so the form never goes empty. The response says which
source each list came from (`catalogSource`). The ticket team asks callers not to cache beyond one run; `/ticket-config` keeps a
copy for 5 minutes (Refresh bypasses it) to stay inside the 120 requests a minute.

**Raising tickets as the agent.** Any request to the ticket API may carry `onBehalfOf` (an email); the ticket is then raised by that
person, from their department. Set `TICKETS_ON_BEHALF_OF=1` to turn it on: `/ticket-create` asks LiveChat who the agent's token belongs
to (the browser cannot choose) and sends that email. It needs:
1. the API key bound to a role that holds `api-keys:act-on-behalf` (ask a ticket-system administrator), and
2. an active ticket-system account with the agent's LiveChat email (and the person must not outrank the key's owner).

When the ticket system has no active account with the agent's email, nothing is created and the widget shows "Ticket account not found. Please enter your ticket account email." with a box for it (see Ticket Email below). When the key may not act for others at all (the missing grant, or a senior account), the ticket is raised under the key's owner instead (with the LiveChat id and email in
the `TICKETS_AUTHOR_*` fields if those are set) and the agent sees why above the ticket. Any other refusal is shown as is.

**Two LiveChat accounts, one ticket account.** An agent who works in both LiveChat accounts has a different email in each (checked
2026-10-15: no email appears in both), and the ticket system finds a person by email. So the Lark table "Livechat App Agent Logins" gets a
text column **Ticket Email** (add it once). Fill it for an agent on either of their rows: both of their LiveChat logins then raise tickets
as that ticket-system account. Without it the LiveChat email is used, which only works when it happens to be the ticket account's email.
The widget shows who a ticket was raised as, or why it fell back, above the ticket.
A typed email is used and saved on the agent's row (once, and only if neither of their rows has a Ticket Email), and remembered in that browser. An email an admin set in Lark always wins, and an agent cannot change it, so nobody can raise tickets as someone else by typing their email; a wrong admin-set email shows "Ask your admin to correct it" instead of the box.
