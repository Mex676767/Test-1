import { initEnv as initLarkEnv, runWithRequestStart, flushCountersThrottled } from "./lark.js";
import { initEnv as initLivechatEnv } from "./livechat.js";

export function adapt(handler) {
  return async (context) => {
    initLarkEnv(context.env);
    initLivechatEnv(context.env);

    let body = "";
    let formData = null;
    try {
      const contentType = context.request.headers.get("content-type") || "";
      if (/^multipart\/form-data\b/i.test(contentType)) formData = await context.request.formData();
      else body = await context.request.text();
    } catch (_) { }

    const url = new URL(context.request.url);
    const event = {
      httpMethod: context.request.method,
      body,
      formData,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(context.request.headers),
      env: context.env,
      waitUntil: (promise) => { try { context.waitUntil?.(promise); } catch (_) { } },
    };

    const result = await runWithRequestStart(() => handler(event));
    try { context.waitUntil?.(flushCountersThrottled()); } catch (_) { }
    return new Response(result.bytes ?? result.body, {
      status: result.statusCode,
      headers: { "Content-Type": "application/json", ...(result.headers || {}) },
    });
  };
}
