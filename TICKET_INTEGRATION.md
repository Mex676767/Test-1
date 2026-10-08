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

## Each agent's own ticket account (optional, off until set up)

By default every ticket call uses the shared `TICKETS_API_KEY`, so comments are
posted by that account and start with `[Agent name via widget]`. With the setup
below an agent connects their own ticket account once and their tickets and
comments are made as them, so the ticket system notifies them itself.

How it works: the Connect button opens `https://tickets.96ghq.com/connect-widget`
(the ticket system's page, still to be built by its developer) in a popup. When
the agent is signed in there, that page sends the widget
`{ type: "tickets-widget-token", token: "tmk_…" }` with `postMessage`, to our
origin only; the widget accepts it only from `https://tickets.96ghq.com`. The
server checks the token with the ticket system, encrypts it, and keeps it
against the agent's verified LiveChat login (account + login id), in a
Cloudflare KV namespace. There is one namespace per team, because retention
and customer service are different teams. The team comes from the agent's
LiveChat groups, read on the server (the same check as
`/livechat-agent-department`: `Priority 96` / `Priority TC` is retention,
everyone else is customer service), never from anything the browser says.
Nothing is stored in Lark or next to any team's data, and the token is never
sent back to the browser.

Setup on the Pages project (Settings → Bindings / Variables):

- KV namespace binding `TICKET_CONNECTIONS_RTN` (retention) and another named
  `TICKET_CONNECTIONS_CS` (customer service). Create two namespaces and bind
  each one.
- Secret `TICKET_TOKEN_SECRET`: a long random string. Changing it makes every
  stored token unreadable, and agents are asked to connect again.
- Both LiveChat OAuth apps need the `agents--my:ro` scope (Read my agent
  profile), and agents need a fresh LiveChat login after it is added (bump
  `LIVECHAT_TOKEN_EPOCH` in `app.js` to make everyone sign in again).

It fails closed. Until both bindings and the secret exist the widget says
own-account sign-in is not set up and keeps using the shared account. If an
agent's team cannot be read (the scope is missing, or LiveChat is down) no
token is stored or read for them: a missing scope shows "not available" and
the shared account stays in use, and a LiveChat outage makes the ticket call
fail with a retry message rather than guess a team. Once the Tickets tab is
shown to real agents (it is admin preview only today) they must connect before
they can raise or comment; only the admin preview may use the shared account.

Locally: `wrangler pages dev . --kv TICKET_CONNECTIONS_RTN --kv TICKET_CONNECTIONS_CS`
and set `TICKET_TOKEN_SECRET` in `.dev.vars`.
