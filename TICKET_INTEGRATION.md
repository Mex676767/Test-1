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

The ticket API supports list, read (with the comment thread), create, and
comment. The widget shows the thread (replies one level deep, mentions
highlighted, files as links into the ticket system) and posts comments and
replies through `/ticket-comment?ref=TK…`, with up to 4 PNG/JPG/WEBP/PDF files
under 1MB each (paste works). The key's role needs `tickets:comment` and the key
needs the "Comment on tickets" access option; without them the widget shows the
service's refusal. Each key is limited to 120 requests a minute; a refusal for
that shows as "Rate limit exceeded".

Until the ticket system can sign each agent in, every comment is posted by the
key's owner, so the widget starts each one with `[Agent name via widget]` (the
agent's name from the LiveChat login) and will not post without a name.

The API has no update route, history or log entries, and no way to edit or
delete a comment, add files to an existing ticket, or react. Those stay in the
ticket system's own dashboard. The widget has no @mention picker yet: a name
typed as `@Name` is plain text and notifies nobody.
