import { adapt } from "./_lib/adapt.js";

async function handler() {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      message: "Cloudflare Pages Function is working! This is where your Lark App Secret lives safely — never in app.js.",
    }),
  };
}

export const onRequest = adapt(handler);
