// Wraps an existing Netlify-style handler -- `async (event) => ({ statusCode,
// body })` -- as a Cloudflare Pages Function export. Every endpoint's actual
// business logic (Lark field mapping, LiveChat calls, etc.) stays
// byte-for-byte identical to its Netlify version; only this thin adapter
// differs per platform, specifically so the migration doesn't also become a
// rewrite of logic that already works and has been fixed field-by-field
// against real data over many rounds.
//
// Also copies context.env onto process.env before calling the handler --
// this project's `nodejs_compat` compatibility flag (see wrangler.toml)
// should already populate process.env from the Pages project's bound
// environment variables, but doing it explicitly here too removes any doubt
// and costs nothing. lib/lark.js and lib/livechat.js read process.env.X as
// module-level consts, unchanged from their Netlify versions -- if that
// population is ever incomplete, every endpoint fails immediately and
// loudly (e.g. "LARK_APP_ID / LARK_APP_SECRET not set"), not silently.
export function adapt(netlifyHandler) {
  return async (context) => {
    try {
      Object.assign(process.env, context.env);
    } catch (_) { /* non-fatal -- falls through to whatever process.env already has */ }

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
