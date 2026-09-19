// Wraps each endpoint's plain handler -- `async (event) => ({ statusCode,
// body })`, kept simple and platform-agnostic -- as a Cloudflare Pages
// Function export. This is the live entry point: the deployed project
// ("test-1") is classic Pages, so each functions/*.js file's own onRequest
// export (built from this adapt()) is what actually runs per request.
// _worker.js is a dormant alternative for a Worker-style deployment, not
// currently used.
import { initEnv as initLarkEnv } from "./lark.js";
import { initEnv as initLivechatEnv } from "./livechat.js";

export function adapt(handler) {
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

    const result = await handler(event);
    return new Response(result.body, {
      status: result.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}
