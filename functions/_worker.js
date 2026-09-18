// Single Worker entry point -- this project was created as a Cloudflare
// Worker (not classic Pages), which doesn't understand the functions/
// directory's file-based routing or the _redirects file at all (both are
// Pages-only conventions). Everything else in this directory (the actual
// endpoint logic in lark-search.js, lark-claim.js, etc., and _lib/lark.js/
// _lib/livechat.js) is unchanged and reused directly here -- this file is
// just the routing table plus the static-asset fallback a Worker needs to
// serve index.html/app.js/style.css itself.
import { handler as larkSearch } from "./lark-search.js";
import { handler as larkClaim } from "./lark-claim.js";
import { handler as larkRecord } from "./lark-record.js";
import { handler as larkPicList } from "./lark-pic-list.js";
import { handler as larkBrandList } from "./lark-brand-list.js";
import { handler as larkLastUsername } from "./lark-last-username.js";
import { handler as larkEscalationOptions } from "./lark-escalation-options.js";
import { handler as larkEscalationSubmit } from "./lark-escalation-submit.js";
import { handler as larkDeleteRecord } from "./lark-delete-record.js";
import { handler as livechatChatStatus } from "./livechat-chat-status.js";
import { handler as livechatGroupName } from "./livechat-group-name.js";
import { handler as helloHandler } from "./hello.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";
import { initEnv as initLivechatEnv } from "./_lib/livechat.js";

const ROUTES = {
  "lark-search": larkSearch,
  "lark-claim": larkClaim,
  "lark-record": larkRecord,
  "lark-pic-list": larkPicList,
  "lark-brand-list": larkBrandList,
  "lark-last-username": larkLastUsername,
  "lark-escalation-options": larkEscalationOptions,
  "lark-escalation-submit": larkEscalationSubmit,
  "lark-delete-record": larkDeleteRecord,
  "livechat-chat-status": livechatChatStatus,
  "livechat-group-name": livechatGroupName,
  "hello": helloHandler,
};

export default {
  async fetch(request, env, ctx) {
    // A Worker's module evaluates once, before this fetch handler ever
    // runs -- so a top-level `const X = process.env.Y` in _lib/lark.js
    // would always capture undefined, no matter what env vars are bound in
    // Cloudflare's dashboard (confirmed live, 2026-09-18: a real "LARK_APP_ID
    // / LARK_APP_SECRET not set" error with the vars genuinely bound).
    // initEnv() sets those values fresh on every request instead; ES
    // module named exports are live bindings, so every file that imports
    // e.g. TABLE_PNL from _lib/lark.js sees the update with no changes
    // needed on their end.
    initLarkEnv(env);
    initLivechatEnv(env);

    const url = new URL(request.url);
    let path = url.pathname;
    // app.js calls /.netlify/functions/<name> everywhere, unchanged, so the
    // exact same static files work on either host without editing -- Pages
    // handled this via _redirects; a Worker has to do it itself here.
    const prefix = "/.netlify/functions/";
    if (path.startsWith(prefix)) path = "/" + path.slice(prefix.length);
    const name = path.replace(/^\/+/, "");

    const routeHandler = ROUTES[name];
    if (routeHandler) {
      let body = "";
      try {
        body = await request.text();
      } catch (_) { /* no body, e.g. a GET */ }
      const event = {
        httpMethod: request.method,
        body,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(request.headers),
      };
      try {
        const result = await routeHandler(event);
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Not one of our API routes -- serve the static site (index.html,
    // app.js, style.css) via the assets binding configured in wrangler.toml.
    return env.ASSETS.fetch(request);
  },
};
