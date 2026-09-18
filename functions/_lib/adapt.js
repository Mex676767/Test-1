// Wraps an existing Netlify-style handler -- `async (event) => ({ statusCode,
// body })` -- as a Cloudflare Pages Function export. Every endpoint's actual
// business logic (Lark field mapping, LiveChat calls, etc.) stays
// byte-for-byte identical to its Netlify version; only this thin adapter
// differs per platform, specifically so the migration doesn't also become a
// rewrite of logic that already works and has been fixed field-by-field
// against real data over many rounds.
//
// NOT currently the live entry point -- this project (a Cloudflare Worker,
// not classic Pages) routes through _worker.js instead, which calls
// _lib/lark.js's/_lib/livechat.js's initEnv() directly. Kept working here
// too in case this ever runs under classic Pages' own file-based routing
// instead, where each functions/*.js file's own onRequest export (built
// from this adapt()) would be the real entry point per request.
import { initEnv as initLarkEnv } from "./lark.js";
import { initEnv as initLivechatEnv } from "./livechat.js";

export function adapt(netlifyHandler) {
  return async (context) => {
    // A Worker's (or Pages Function's) module evaluates once, before any
    // request handler runs -- _lib/lark.js and _lib/livechat.js no longer
    // read process.env at module top-level for exactly this reason (see
    // their own header notes); initEnv() sets their values fresh here,
    // every request.
    initLarkEnv(context.env);
    initLivechatEnv(context.env);

    let body = "";
    try {
      body = await context.request.text();
    } catch (_) { /* no body, e.g. a GET */ }

    const url = new URL(context.request.url);
    const event = {
      httpMethod: context.request.method,
      body,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(context.request.headers),
    };

    const result = await netlifyHandler(event);
    return new Response(result.body, {
      status: result.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}
