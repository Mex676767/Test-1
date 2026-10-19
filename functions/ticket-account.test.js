import assert from "node:assert/strict";
import test from "node:test";
import { handler, resetTicketAccountCache } from "./ticket-account.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import { resetTicketRateLimit } from "./_lib/tickets.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKENS = { "tok-alice": { account_id: "uuid-alice", email: "alice@x.com", client_id: "c1" } };
const onEnv = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const author = { accountKey: "lc1", agentToken: "tok-alice" };

function network({ markets = [] } = {}) {
  const original = globalThis.fetch;
  const probes = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/v2/info")) {
      const info = TOKENS[String(options.headers.Authorization).replace("Bearer ", "")];
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url.includes("/markets")) { probes.push(new URL(url).searchParams.get("onBehalfOf")); return markets.shift() || reply({ ok: true, markets: [] }); }
    throw new Error(`unexpected ${url}`);
  };
  return { probes, restore: () => { globalThis.fetch = original; } };
}
const check = async (env = onEnv, input = { author }) => {
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1" });
  const result = await handler({ httpMethod: "POST", env, body: JSON.stringify(input) });
  return { status: result.statusCode, body: JSON.parse(result.body) };
};
const noAccount = () => reply({ ok: false, error: 'No active account has the email "alice@x.com", so nothing can be done on their behalf.' }, 400);

test("found: the ticket system acts as the agent's email; one small read, remembered for a minute", async () => {
  resetTicketAccountCache(); resetTicketRateLimit();
  const net = network();
  try {
    const first = await check();
    assert.deepEqual(first.body, { ok: true, enabled: true, status: "found", email: "alice@x.com", source: "livechat" });
    assert.deepEqual(net.probes, ["alice@x.com"]);
    await check();
    assert.equal(net.probes.length, 1, "the second check is answered from the minute's copy");
  } finally { net.restore(); }
});

test("not found, the key's missing permission and a senior account are told apart", async () => {
  for (const [reply1, expected] of [
    [noAccount(), "notFound"],
    [reply({ ok: false, error: "This API key's role may not act on behalf of other people (api-keys:act-on-behalf)." }, 403), "keyNeedsGrant"],
    [reply({ ok: false, error: '"alice@x.com" outranks the account this API key belongs to, so nothing can be done on their behalf.' }, 403), "outranks"],
    // The newer wording the ticket system uses for an email it has no usable account for (also deactivated, hidden, role-less, senior): ask for another email.
    [reply({ ok: false, error: '"alice@x.com" is not an account this API key can act for, so nothing can be done on their behalf. Check the address, or ask whoever issued the key.' }, 400), "notFound"],
    [reply({ ok: false, error: '"alice@x.com" is a service account — it only owns API keys, so nothing can be done on their behalf. Name the person the request is for.' }, 400), "notFound"],
  ]) {
    resetTicketAccountCache(); resetTicketRateLimit();
    const net = network({ markets: [reply1] });
    try { assert.equal((await check()).body.status, expected); } finally { net.restore(); }
  }
});

test("a typed email is what is checked; a wrong one that an admin saved is not something the agent can fix", async () => {
  resetTicketAccountCache(); resetTicketRateLimit();
  const net = network({ markets: [noAccount()] });
  try {
    const typed = await check(onEnv, { author: { ...author, ticketEmail: "Alice@Company.com" } });
    assert.deepEqual([typed.body.status, typed.body.email, typed.body.source], ["notFound", "alice@company.com", "entered"]);
    assert.deepEqual(net.probes, ["alice@company.com"]);
  } finally { net.restore(); }
});

test("switched off, signed out or not configured: no probe is made", async () => {
  resetTicketAccountCache(); resetTicketRateLimit();
  const net = network();
  try {
    assert.deepEqual((await check({ TICKETS_API_KEY: "k" })).body, { ok: true, enabled: false });
    assert.equal((await check(onEnv, { author: { accountKey: "lc1", agentToken: "tok-gone" } })).status, 401);
    assert.equal((await check(onEnv, {})).status, 401);
    assert.equal((await check({})).status, 503);
    assert.equal((await handler({ httpMethod: "GET", env: onEnv })).statusCode, 405);
    assert.equal(net.probes.length, 0);
  } finally { net.restore(); }
});

test("a refusal comes with the ticket system's own words, so it is clear which one it is; a found account has none", async () => {
  resetTicketAccountCache(); resetTicketRateLimit();
  const words = "This API key is not bound to a role, so it may not act on behalf of other people. Issue a key bound to a role.";
  let net = network({ markets: [reply({ ok: false, error: words }, 403)] });
  try {
    const refused = await check();
    assert.deepEqual([refused.body.status, refused.body.detail], ["keyNeedsGrant", words]);
  } finally { net.restore(); }
  resetTicketAccountCache(); resetTicketRateLimit();
  net = network();
  try { assert.equal("detail" in (await check()).body, false); } finally { net.restore(); }
});

test("a key the ticket system does not accept at all (401 Not signed in.) is its own status, with its words, not a failed check", async () => {
  resetTicketAccountCache(); resetTicketRateLimit();
  const net = network({ markets: [reply({ ok: false, error: "Not signed in." }, 401)] });
  try {
    const result = await check();
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.status, result.body.detail, result.body.email], ["keyRejected", "Not signed in.", "alice@x.com"]);
  } finally { net.restore(); }
});

test("every wording of 'there is no usable ticket account for that email' is recognised, so the agent is asked for their email instead of seeing an error", async () => {
  const { isOnBehalfRefusal } = await import("./_lib/ticket-actor.js");
  const refusal = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  assert.equal(isOnBehalfRefusal(refusal('No active account has the email "a@x.com", so nothing can be done on their behalf.')), true);
  assert.equal(isOnBehalfRefusal(refusal('"myrhans@protonmail.com" is not an account this API key can act for, so nothing can be done on their behalf. Check the address, or ask whoever issued the key.')), true);
  assert.equal(isOnBehalfRefusal(refusal('"bot@x.com" is a service account — it only owns API keys, so nothing can be done on their behalf. Name the person the request is for.')), true);
  assert.equal(isOnBehalfRefusal(refusal('"a@x.com" outranks the account this API key belongs to.', 403)), true);
  assert.equal(isOnBehalfRefusal(refusal("Status: Closed is not one of the choices")), false, "an ordinary validation error is not one");
  assert.equal(isOnBehalfRefusal(refusal("Rate limit exceeded", 429)), false);
});
