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

The ticket API supports list, read, create, comment and (since 2026-10-19) update (`PATCH /tickets/<ref>`, see "Editing a ticket" below).
It does not expose history or log entries; the app links to the dashboard for those.

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

**Update (2026-10-15): no fallback, and comments.** With `TICKETS_ON_BEHALF_OF=1` a ticket or comment is never raised under the key's
owner: if the ticket system refuses to act as the agent, nothing is created and a dialog says why. "Ticket account not found" asks for the
ticket account email in a box (saved once, see above); "the API key may not act on behalf of other people yet" means the key's role is
missing `api-keys:act-on-behalf` (ask the ticket team); a senior account the key cannot act for is named. Comments: the ticket read
(`/ticket-status`) now carries the thread (comments with replies, mentions and file names) and `/ticket-comment` posts a comment or a
reply (`{ ref, body, parentId?, author }`) as the signed-in agent through the same `onBehalfOf` rules. The widget shows the thread
under each ticket with a box to comment or reply.

## Editing a ticket (admin preview only)

`POST /ticket-update` (`PATCH` also accepted) `{ ref, author, fields?, toDepartment?, market?, assignees?, expect? }` makes one atomic
`PATCH /tickets/<ref>` as the signed-in agent (same `onBehalfOf` rules as comments). `fields` are field keys to new values (`null` clears);
`toDepartment` is a department code; `market` a market code or `null`; `assignees` is `{ add: [email|name|id], remove: [id|email|name] }`;
`expect` is the value the agent saw for each changed field, so a ticket changed by someone else meanwhile is refused (412 `precondition_failed`,
nothing saved) instead of overwritten. The answer is `{ ok, ref, changed, visible, ticket, actedAs }`; `visible: false` means the change moved
the ticket out of what the agent may see. Errors keep the ticket API's `code`, `problems` and `mismatched`. Files cannot be added or removed yet.

**Status, department and market are asked of the ticket system.** `/ticket-list` takes `status` (a choice value), `department` and `market` (ids) and
sends them as `f:status|is|…`, `dept|is|…`, `market|is|…` (all must hold), so they narrow every ticket and not only the 100 newest that one
read returns. With a person picked as well ("raised by or assigned to" is an OR), the two sides are each read with the narrowing and merged.
The widget re-reads the list whenever one of these filters or the person changes. A department or market that only has a code (the built-in
fallback lists) is still filtered on the loaded tickets. The Active / Solved tabs and the search box's filters still work on what was loaded.

**Filters.** The four filters (Agent, Status, Department, Market) and the bulk status are the same searchable dropdown as the ticket form. They
list every choice the ticket system has, not only those on the loaded tickets. The Agent list is every person who raised or is assigned to one of
the newest ~1000 tickets the agent may see (`POST /ticket-agents`: up to four pages of 250, kept 10 minutes per person; the ticket API has no list
of users). Picking an agent asks the ticket system for that person's tickets by id (`/ticket-list` with `agent`: `c=createdBy|is|<id>` or
`c=assignee|is|<id>`, falling back to `createdBy` alone), so an agent with nothing among the newest 100 still shows their tickets. A filter value
left over from another list that is no longer offered is ignored instead of hiding every ticket.

**Ticket list.** The Agent filter has "Me": the tickets the agent raised or is assigned to, asked of the ticket system itself
(`/ticket-list` with `mine`: `c=createdBy|is|me&c=assignee|is|me&match=any`, falling back to `createdBy` alone if the assignee condition is
refused), because the list otherwise holds only the 100 most recently updated tickets of everyone, which can hold few or none of the agent's own. Every row has a tick
box and "Select all" ticks everything shown (at most 60); with something ticked, choose a status and "Update N" sets it on each ticked ticket,
one `/ticket-update` after another (the ticket API has no bulk call), each guarded by the status the list showed. A ticket someone else changed
meanwhile is skipped and reported; a refusal that would repeat for every ticket (no permission, the key may not update, rate limit) stops the run.
The green "Ticket account found" line shows for 6 s when the account is first confirmed (or "Check again" is pressed) and then lives in Settings,
under "Ticket account"; a problem with the account stays on the Tickets tab.

In the Tickets tab a ticket's detail is always editable (raise-form fields plus department, market and assignees) and every edit is saved as
it is made: a choice when it is picked, typed text when the box is left or Enter is pressed, one request per edit, queued in order. A
refusal or a ticket someone else changed first shows its message and the box goes back to the real value. The detail refreshes every 30 s
(a copy older than a save just made is ignored). **Needs on the ticket side:** the API key's "Update tickets" access switched on (off on every key until an administrator ticks it; a
refusal shows as "This API key is not allowed to update tickets") and `tickets:update` on the role of each agent's ticket account. The Tickets
tab is still admin preview only (`DEPARTMENT_TABS_LIVE = false`), so nothing changes in the installed widget.

**Ticket account check (before the Tickets tab can be used).** When the Tickets tab is opened the widget asks `/ticket-account`, which
makes one small read (the market list) as the agent's ticket email (`onBehalfOf`) and so learns, without creating anything, whether the
ticket system knows them. Until the answer is "found" the tab shows only that screen: "Checking your ticket account…", then the result
("✓ Ticket account found: email (from your LiveChat email / your saved Ticket Email / the email you entered)", or "✗ not found" with the
email popup open at once, or why the key cannot act for them). The inbox and ticket calls wait for it. A failed check (ticket system
busy) does not lock anyone out. The answer is remembered for a minute per email on the server and five minutes in the widget; "Check
again" and entering an email check again. It only exists with `TICKETS_ON_BEHALF_OF=1`.

## Auto ticket on claim and the default market (admin preview only)

Claiming Top P&L, LTV, Grace Period or Risk Player first raises a ticket (department `PYM_MYR`, level VVIP, query type = the ticket query
type that contains the bonus keyword, amount = the amount claimed, random 32-character transaction id, status / gateway / remarks / manual
deposit left empty) and asks the agent for the proof; the claim only goes through once the ticket exists. It runs only in the admin preview
(`AUTO_TICKET_LIVE = false` in `app.js`; set it to `true` to roll out).

**Default market.** Add a text column **Default Market** to the Lark table "Livechat App Agent Logins" (once). The agent picks their market
the first time they claim; `/agent-market` saves its code on their row (and a second login of the same agent shares it). From then on only an
admin changes it, by editing that cell in Lark (the admin panel will do it later). Without the column the agent is asked every time.
