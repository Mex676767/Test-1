// Compat shim -- app.js calls /.netlify/functions/lark-pic-list unmodified
// on both hosts (see _redirects' header note); that file's rewrite rule
// wasn't taking effect on this project (confirmed live: this exact path
// was falling through to the SPA's index.html instead of the function),
// so this nested file gives Cloudflare Pages' own file-based routing a
// real route at the literal path instead, with no _redirects dependency.
export { onRequest } from "../../lark-pic-list.js";
