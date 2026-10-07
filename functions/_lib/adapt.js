// Wraps each endpoint's plain handler -- `async (event) => ({ statusCode,
// body })`, kept simple and platform-agnostic -- as a Cloudflare Pages
// Function export. This is the live entry point: the deployed project
// ("test-1") is classic Pages, so each functions/*.js file's own onRequest
// export (built from this adapt()) is what actually runs per request.
import { initEnv as initLarkEnv, runWithRequestStart, flushCounters } from "./lark.js";
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
    let formData = null;
    try {
      const contentType = context.request.headers.get("content-type") || "";
      if (/^multipart\/form-data\b/i.test(contentType)) formData = await context.request.formData();
      else body = await context.request.text();
    } catch (_) { /* no body, e.g. a GET */ }

    const url = new URL(context.request.url);
    const event = {
      httpMethod: context.request.method,
      body,
      formData,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(context.request.headers),
      env: context.env,
      // Work that must not delay the response (e.g. cleaning up a twin row) but should still finish after it.
      waitUntil: (promise) => { try { context.waitUntil?.(promise); } catch (_) { /* no execution context: the work is simply best effort */ } },
    };

    // Everything this request asks of the shared Lark queue is stamped with this moment (the queue orders by request age).
    const result = await runWithRequestStart(() => handler(event));
    // Counters this request noted go to the queue's stats after the response is on its way (best effort, never blocks it).
    try { context.waitUntil?.(flushCounters()); } catch (_) { /* no execution context */ }
    return new Response(result.body, {
      status: result.statusCode,
      headers: { "Content-Type": "application/json", ...(result.headers || {}) },
    });
  };
}
