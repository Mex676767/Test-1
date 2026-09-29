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

The ticket API currently supports list, read, and create. It does not expose an
update route, comment contents, comment posting, history, or log entries. The
app shows their counts and links to the dashboard, but those website features
cannot be replicated until matching REST endpoints are added.
