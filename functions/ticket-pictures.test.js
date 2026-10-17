import assert from "node:assert/strict";
import test from "node:test";
import { handler as comment } from "./ticket-comment.js";
import { handler as create } from "./ticket-create.js";
import { handler as attachment } from "./ticket-attachment.js";
import { fileMatchesType } from "./_lib/ticket-images.js";
import { resetTicketRateLimit } from "./_lib/tickets.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 1, 2];
const file = (bytes, name, type) => new File([new Uint8Array(bytes)], name, { type });
const env = { TICKETS_API_KEY: "k" };
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function bucket() {
  const puts = [];
  const deleted = [];
  return { puts, deleted, put: async (key, _body, options) => { puts.push([key, options.httpMetadata.contentType]); }, delete: async (keys) => { deleted.push(...keys); } };
}
function ticketApi(handle) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return handle(String(url), options); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const commentWith = (files, input = { ref: "TK2610170001", body: "see attached" }) => {
  const formData = new FormData();
  formData.append("comment", JSON.stringify(input));
  for (const item of files) formData.append("file", item, item.name);
  return comment({ httpMethod: "POST", env: { ...env, TICKET_IMAGES: bucket(), ...(input.env || {}) }, headers: { host: "app.test" }, formData });
};

test("file bytes decide what a file is: a renamed text file is not an image or PDF", async () => {
  assert.equal(await fileMatchesType(file(PNG, "a.png", "image/png")), true);
  assert.equal(await fileMatchesType(file(PDF, "a.pdf", "application/pdf")), true);
  assert.equal(await fileMatchesType(file([0xff, 0xd8, 0xff, 0xe0], "a.jpg", "image/jpeg")), true);
  assert.equal(await fileMatchesType(file([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")], "a.webp", "image/webp")), true);
  assert.equal(await fileMatchesType(file([...Buffer.from("<script>alert(1)</script>")], "a.png", "image/png")), false);
  assert.equal(await fileMatchesType(file(PNG, "a.pdf", "application/pdf")), false, "an image labelled as a PDF");
  assert.equal(await fileMatchesType(file(PNG, "a.svg", "image/svg+xml")), false);
});

test("a comment with a picture: the picture goes to the bucket and the comment carries its link; a PDF is attached", async () => {
  resetTicketRateLimit();
  const net = ticketApi(() => reply({ ok: true, comment: { id: 9 } }, 201));
  const store = bucket();
  try {
    const formData = new FormData();
    formData.append("comment", JSON.stringify({ ref: "TK2610170001", body: "here is the slip" }));
    formData.append("file", file(PNG, "slip.png", "image/png"), "slip.png");
    formData.append("file", file(PDF, "slip.pdf", "application/pdf"), "slip.pdf");
    const result = await comment({ httpMethod: "POST", env: { ...env, TICKET_IMAGES: store }, headers: { host: "app.test" }, formData });
    assert.equal(result.statusCode, 201);
    assert.equal(JSON.parse(result.body).images, 1);
    assert.deepEqual(store.puts.map((put) => put[1]), ["image/png"]);
    const sent = net.calls[0].options.body;
    assert.ok(sent instanceof FormData, "a PDF makes the comment multipart");
    const posted = JSON.parse(sent.get("comment"));
    assert.match(posted.body, /^here is the slip\n\nImages:\nhttps:\/\/app\.test\/ticket-image\?k=tickets%2F/);
    assert.equal(sent.get("file").name, "slip.pdf");
  } finally { net.restore(); }
});

test("a picture alone is a comment; only pictures means a plain JSON comment with the link", async () => {
  resetTicketRateLimit();
  const net = ticketApi(() => reply({ ok: true, comment: { id: 9 } }, 201));
  try {
    const result = await commentWith([file(PNG, "p.png", "image/png")], { ref: "TK2610170001", body: "" });
    assert.equal(result.statusCode, 201);
    const sent = JSON.parse(net.calls[0].options.body);
    assert.match(sent.body, /^Images:\nhttps:\/\/app\.test\/ticket-image\?k=/);
  } finally { net.restore(); }
});

test("a comment refuses a file that is not what it says, too many files, and no text with no file; a refused comment leaves no picture behind", async () => {
  resetTicketRateLimit();
  const net = ticketApi(() => reply({ ok: false, error: "nope" }, 404));
  try {
    assert.equal((await commentWith([file([...Buffer.from("hello world")], "x.png", "image/png")])).statusCode, 400);
    assert.equal((await commentWith(Array.from({ length: 5 }, (_, i) => file(PNG, `p${i}.png`, "image/png")))).statusCode, 400);
    assert.equal((await commentWith([], { ref: "TK2610170001", body: "" })).statusCode, 400);
    assert.equal(net.calls.length, 0, "nothing reached the ticket system");
    const store = bucket();
    const formData = new FormData();
    formData.append("comment", JSON.stringify({ ref: "TK2610170001", body: "x" }));
    formData.append("file", file(PNG, "p.png", "image/png"), "p.png");
    const refused = await comment({ httpMethod: "POST", env: { ...env, TICKET_IMAGES: store }, headers: { host: "app.test" }, formData });
    assert.equal(refused.statusCode, 404);
    assert.equal(store.deleted.length, 1, "the stored picture is removed again");
  } finally { net.restore(); }
});

test("a ticket's attached picture is read through the key as the agent and returned only if it is really an image", async () => {
  resetTicketRateLimit();
  const png = new Uint8Array(PNG);
  const net = ticketApi((url) => (url.includes("/api/attachments/") ? new Response(png, { headers: { "Content-Type": "image/png" } }) : reply({ ok: false }, 404)));
  try {
    const result = await attachment({ httpMethod: "POST", env, body: JSON.stringify({ path: "2026-09/21/3f9a-c1.png" }) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual([...result.bytes], PNG);
    assert.equal(result.headers["Content-Type"], "image/png");
    assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(net.calls[0].url, "https://tickets.96ghq.com/api/attachments/2026-09/21/3f9a-c1.png");
    assert.equal(net.calls[0].options.headers.Authorization, "Bearer k");
    assert.equal(net.calls[0].options.redirect, "manual");
  } finally { net.restore(); }
});

test("the picture reader cannot be pointed elsewhere or at other files, and a page, a redirect or fake image bytes are refused", async () => {
  resetTicketRateLimit();
  const html = ticketApi(() => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
  try {
    for (const path of ["../secret.png", "/etc/passwd.png", "a//b.png", "2026-09/21/x.pdf", "https://evil.test/x.png", "x.png/../../y.png", ""]) {
      assert.equal((await attachment({ httpMethod: "POST", env, body: JSON.stringify({ path }) })).statusCode, 400, path);
    }
    assert.equal(html.calls.length, 0, "no request for a bad path");
    assert.equal((await attachment({ httpMethod: "POST", env, body: JSON.stringify({ path: "a/b.png" }) })).statusCode, 415, "a page is not a picture");
    assert.equal((await attachment({ httpMethod: "GET", env })).statusCode, 405);
  } finally { html.restore(); }
  const fake = ticketApi(() => new Response("not a png at all", { headers: { "Content-Type": "image/png" } }));
  try { assert.equal((await attachment({ httpMethod: "POST", env, body: JSON.stringify({ path: "a/b.png" }) })).statusCode, 415, "fake image bytes"); } finally { fake.restore(); }
  const redirect = ticketApi(() => new Response(null, { status: 307, headers: { Location: "/login" } }));
  try { assert.notEqual((await attachment({ httpMethod: "POST", env, body: JSON.stringify({ path: "a/b.png" }) })).statusCode, 200, "a login redirect"); } finally { redirect.restore(); }
});

test("a refused duplicate carries the ticket it duplicates", async () => {
  resetTicketRateLimit();
  const net = ticketApi(() => reply({ ok: false, error: "A ticket with the same details was raised today.", duplicateOf: "TK2610170009" }, 409));
  try {
    const result = await create({ httpMethod: "POST", env, body: JSON.stringify({ fields: { toDepartment: "CS", member_id: "x" } }) });
    assert.equal(result.statusCode, 409);
    assert.equal(JSON.parse(result.body).duplicateOf, "TK2610170009");
  } finally { net.restore(); }
});
