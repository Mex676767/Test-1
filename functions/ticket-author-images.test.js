import assert from "node:assert/strict";
import test from "node:test";
import { handler as createHandler } from "./ticket-create.js";
import { onRequest as imageOnRequest } from "./ticket-image.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";

// A fake R2 bucket and a fake network: LiveChat's token info, the ticket API. Nothing real is called.
function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    put: async (key, value, options) => { objects.set(key, { body: value, httpMetadata: options?.httpMetadata }); },
    get: async (key) => objects.get(key) || null,
    delete: async (keys) => { for (const key of [].concat(keys)) objects.delete(key); },
  };
}

function fakeNetwork({ ticketOk = true, tokens = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } } } = {}) {
  const original = global.fetch;
  const tickets = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = tokens[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.includes("/tickets")) {
      tickets.push(options.body);
      return ticketOk
        ? Response.json({ ok: true, id: 1, ref: "TK2610120001" }, { status: 201 })
        : Response.json({ ok: false, error: "Ticket service says no" }, { status: 422 });
    }
    throw new Error("unexpected " + url);
  };
  return { tickets, restore: () => { global.fetch = original; } };
}

const baseEnv = { TICKETS_API_KEY: "k" };
const png = (name = "a.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
const pdf = () => new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });
function multipart(fields, files, author) {
  const form = new FormData();
  form.append("ticket", JSON.stringify({ fields, author }));
  for (const file of files) form.append("attachment", file, file.name);
  return form;
}
const call = (env, formData, headers = { host: "test-1-7wp.pages.dev" }) => createHandler({ httpMethod: "POST", env, headers, formData });
const sentFields = (body) => JSON.parse(typeof body === "string" ? body : body.get("ticket")).fields;

test("images go to R2 and the ticket gets their links; PDFs stay attachments", async () => {
  const net = fakeNetwork();
  const bucket = fakeBucket();
  try {
    const result = await call({ ...baseEnv, TICKET_IMAGES: bucket }, multipart({ toDepartment: "PYM_MYR", remarks: "slip attached" }, [png(), pdf()]));
    assert.equal(result.statusCode, 201);
    assert.equal(JSON.parse(result.body).images, 1);
    assert.equal(bucket.objects.size, 1);
    const [[key, stored]] = [...bucket.objects];
    assert.match(key, /^tickets\/\d{8}\/[0-9a-f-]{36}\.png$/);
    assert.equal(stored.httpMetadata.contentType, "image/png");
    const fields = sentFields(net.tickets[0]);
    assert.equal(fields.remarks, `slip attached\n\nImages:\nhttps://test-1-7wp.pages.dev/ticket-image?k=${encodeURIComponent(key)}`);
    assert.equal(net.tickets[0].get("attachment").name, "a.pdf"); // only the PDF is attached
    assert.equal(net.tickets[0].getAll("attachment").length, 1);
  } finally { net.restore(); }
});

test("only images: the ticket is sent as plain JSON; a public bucket address and another links field are honoured", async () => {
  const net = fakeNetwork();
  const bucket = fakeBucket();
  try {
    const env = { ...baseEnv, TICKET_IMAGES: bucket, TICKET_IMAGES_PUBLIC_URL: "https://img.example.com/", TICKETS_IMAGE_LINKS_FIELD: "image_links" };
    await call(env, multipart({ toDepartment: "PYM_MYR" }, [png(), png("b.png")]));
    assert.equal(typeof net.tickets[0], "string");
    const links = sentFields(net.tickets[0]).image_links.split("\n").slice(1);
    assert.equal(links.length, 2);
    for (const link of links) assert.match(link, /^https:\/\/img\.example\.com\/tickets\/\d{8}\/[0-9a-f-]{36}\.png$/);
  } finally { net.restore(); }
});

test("without the bucket binding images are attached as before", async () => {
  const net = fakeNetwork();
  try {
    await call(baseEnv, multipart({ toDepartment: "PYM_MYR" }, [png()]));
    assert.ok(net.tickets[0] instanceof FormData);
    assert.equal(net.tickets[0].get("attachment").name, "a.png");
    assert.equal("remarks" in sentFields(net.tickets[0]), false);
  } finally { net.restore(); }
});

test("a ticket the service refuses leaves no image behind", async () => {
  const net = fakeNetwork({ ticketOk: false });
  const bucket = fakeBucket();
  try {
    const result = await call({ ...baseEnv, TICKET_IMAGES: bucket }, multipart({ toDepartment: "PYM_MYR" }, [png()]));
    assert.equal(result.statusCode, 422);
    assert.equal(bucket.objects.size, 0);
  } finally { net.restore(); }
});

const authorEnv = { ...baseEnv, TICKETS_AUTHOR_ID_FIELD: "livechat_id", TICKETS_AUTHOR_EMAIL_FIELD: "livechat_email", LIVECHAT_CLIENT_ID: "c1" };

test("the ticket carries the LiveChat id and email LiveChat gives for the agent's token, not what the browser says", async () => {
  const net = fakeNetwork();
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
  try {
    const result = await createHandler({
      httpMethod: "POST", env: authorEnv,
      body: JSON.stringify({ fields: { toDepartment: "PYM_MYR", livechat_email: "boss@x.com" }, author: { accountKey: "lc1", agentToken: "tok-alice" } }),
    });
    assert.equal(result.statusCode, 201);
    const fields = sentFields(net.tickets[0]);
    assert.equal(fields.livechat_id, "uuid-alice");
    assert.equal(fields.livechat_email, "alice@x.com");
    assert.equal("author" in JSON.parse(net.tickets[0]), false);
  } finally { net.restore(); }
});

test("with author fields set, a ticket without a valid LiveChat login is refused and nothing is stored or sent", async () => {
  const net = fakeNetwork();
  const bucket = fakeBucket();
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
  try {
    const env = { ...authorEnv, TICKET_IMAGES: bucket };
    const none = await call(env, multipart({ toDepartment: "PYM_MYR" }, [png()]));
    assert.equal(none.statusCode, 401);
    const stale = await call(env, multipart({ toDepartment: "PYM_MYR" }, [png()], { accountKey: "lc1", agentToken: "tok-gone" }));
    assert.equal(stale.statusCode, 401);
    assert.equal(JSON.parse(stale.body).loginExpired, true);
    assert.equal(net.tickets.length, 0);
    assert.equal(bucket.objects.size, 0);
  } finally { net.restore(); }
});

test("without author fields set nothing about the agent is needed or sent", async () => {
  const net = fakeNetwork();
  try {
    const result = await createHandler({ httpMethod: "POST", env: baseEnv, body: JSON.stringify({ fields: { toDepartment: "PYM_MYR" } }) });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(sentFields(net.tickets[0]), { toDepartment: "PYM_MYR" });
  } finally { net.restore(); }
});

test("the image endpoint serves only keys this site wrote, as an image", async () => {
  const bucket = fakeBucket();
  const key = "tickets/20261012/0b9f6a3e-1c7d-4a52-9e0b-2f4d8c1a7b66.png";
  bucket.objects.set(key, { body: new Uint8Array([1, 2, 3]), httpMetadata: { contentType: "image/png" } });
  bucket.objects.set("secret.txt", { body: "x", httpMetadata: { contentType: "text/plain" } });
  const get = (k, env = { TICKET_IMAGES: bucket }) => imageOnRequest({ env, request: new Request(`https://x.test/ticket-image?k=${encodeURIComponent(k)}`) });

  const ok = await get(key);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await get("secret.txt")).status, 404);
  assert.equal((await get("../secret.txt")).status, 404);
  assert.equal((await get("tickets/20261012/00000000-0000-4000-8000-000000000000.png")).status, 404);
  assert.equal((await get(key, {})).status, 404);
  const post = await imageOnRequest({ env: { TICKET_IMAGES: bucket }, request: new Request(`https://x.test/ticket-image?k=${key}`, { method: "POST" }) });
  assert.equal(post.status, 405);
});

test("with the bucket an image may be up to 5MB; a PDF, or an image without the bucket, stays under 1MB", async () => {
  const net = fakeNetwork();
  const big = (type, name) => new File([new Uint8Array(3 * 1024 * 1024)], name, { type });
  const huge = new File([new Uint8Array(5 * 1024 * 1024)], "huge.png", { type: "image/png" });
  try {
    const withBucket = { ...baseEnv, TICKET_IMAGES: fakeBucket() };
    assert.equal((await call(withBucket, multipart({ toDepartment: "PYM_MYR" }, [big("image/png", "ok.png")]))).statusCode, 201);
    const tooBig = await call(withBucket, multipart({ toDepartment: "PYM_MYR" }, [huge]));
    assert.equal(tooBig.statusCode, 400);
    assert.match(JSON.parse(tooBig.body).error, /under 5MB/);
    const pdfBig = await call(withBucket, multipart({ toDepartment: "PYM_MYR" }, [big("application/pdf", "a.pdf")]));
    assert.match(JSON.parse(pdfBig.body).error, /under 1MB/);
    const noBucket = await call(baseEnv, multipart({ toDepartment: "PYM_MYR" }, [big("image/png", "ok.png")]));
    assert.match(JSON.parse(noBucket.body).error, /under 1MB/);
  } finally { net.restore(); }
});
