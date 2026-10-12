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
files are then stored in the bucket and the ticket gets their links (appended to the remarks, or to the field named by
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
