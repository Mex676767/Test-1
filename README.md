# Retention Console

A LiveChat Agent App widget for CS retention teams. An agent types a player
username, sees that player's available bonuses (pulled from Lark Base),
claims one, and the whole interaction is logged back to Lark automatically —
replacing a manual copy-paste workflow.

## How it's built

- **Frontend** — static HTML/CSS/JS (`index.html`, `style.css`, `app.js`).
  No build step, no framework.
- **Backend** — [Netlify Functions](https://docs.netlify.com/functions/overview/)
  that proxy requests to the Lark Bitable API. Functions live in
  `netlify/functions/`; shared Lark API helpers (auth, search, create,
  update, list, and a field-value normalizer) live in
  `netlify/functions/lib/lark.js`.
- **Data source** — a Lark Base, read/written through Lark's Bitable REST API.

## Project layout

```
index.html                                 Widget shell
style.css                                   Theme tokens, layout, ticket styling
app.js                                      Widget logic, theme toggle, event handlers
netlify.toml                                Netlify config (functions dir, publish dir)
netlify/functions/
  lib/lark.js                               Shared Lark API client
  lark-search.js                            "Look Up" — creates a case row, reads back resolved bonus data
  lark-record.js                            "Record to Lark Base" — writes the final case details
  lark-claim.js                             Instant claim for Ang Pao / Redeem Code bonuses
  lark-pic-list.js                          Agent list for the settings dropdown
  hello.js                                  Placeholder/test function
```

## Setup

1. Create a Lark app (Bot feature enabled, `bitable:app` permission) and
   grant it access to the target Lark Base.
2. In the Netlify site's environment variables, set:

   | Key | Purpose |
   |---|---|
   | `LARK_APP_ID` | Lark app ID |
   | `LARK_APP_SECRET` | Lark app secret |
   | `LARK_BASE_APP_TOKEN` | Target Lark Base's app token |
   | `LARK_TABLE_CUSTOMER_APPROACHING` | "Customer Approaching" table ID |
   | `LARK_TABLE_ANG_PAO` | "Reload - Ang Pao" table ID |
   | `LARK_TABLE_REDEEM_CODE` | "Redeem Code" table ID |
   | `LARK_TABLE_AGENT_LIST` | Agent List table ID |

3. Deploy from GitHub — Netlify picks up `netlify.toml`
   (`functions = "netlify/functions"`, `publish = "."`) automatically.
4. Environment variables only take effect after a redeploy.

## Notes for contributors

- Only push changed files — each deploy consumes Netlify build credits.
- Keep `lark-pic-list.js` a single-page read (no pagination loop); Netlify
  Functions have a 10s execution limit on the free tier.
- This is an internal tool with no automated test suite yet — verify changes
  manually against the widget before merging.
