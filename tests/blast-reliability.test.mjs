import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

function boot({chats, identity, failures = {}}) {
  const values = new Map([
    ['ca-livechat-agent-token:lc2', 'mock-token'],
    ['ca-livechat-agent-token-expiry:lc2', String(Date.now() + 3600000)],
    ['ca-livechat-agent-account-id:lc2', 'uuid-login'],
  ]);
  const storage = {getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k)};
  const calls = [];
  const sent = {};
  const counters = {};
  let time = Date.now();
  const browser = {
    location: {origin: 'https://widget.test', pathname: '/blast/index', search: '?account=lc2'},
    sessionStorage: storage, localStorage: storage, document: {getElementById: () => null},
    addEventListener() {},
    URL, URLSearchParams, Response, FormData, File, AbortSignal, atob, crypto: webcrypto,
    Date: class extends Date { static now() { time += 350; return time; } },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    async fetch(url, init = {}) {
      if (url === '/livechat-oauth-config') return Response.json({});
      const body = JSON.parse(init.body && typeof init.body === 'string' ? init.body : '{}');
      if (url === '/livechat-agent-identity') { calls.push({name: 'identity'}); return Response.json(identity); }
      if (url === '/livechat-chat-status') {
        const chat = chats[body.realChatId];
        return Response.json({ok: true, chatId: body.realChatId, isActive: chat.active, accountKey: 'lc2', raw: {users: chat.users}});
      }
      const name = String(url).split('/').pop();
      const id = body.chat_id || body.chat?.id || body.id;
      counters[name] = (counters[name] || 0) + 1;
      const failure = failures[name]?.(counters[name], body);
      calls.push({name, id, body});
      if (failure === 'lost-before') throw new TypeError('Failed to fetch');
      if (name === 'upload_file') return Response.json({url: 'https://cdn.test/img.png'});
      if (name === 'add_user_to_chat') {
        if (!String(body.user_id).includes('@')) return Response.json({error: {type: 'validation', message: '`user_id` not found'}}, {status: 422});
        chats[id].users.push({id: body.user_id, type: 'agent'});
        chats[id].active = true;
        return Response.json({});
      }
      if (name === 'resume_chat') { chats[id].active = true; return Response.json({}); }
      if (name === 'remove_user_from_chat') return Response.json({});
      if (name === 'deactivate_chat') { chats[id].active = false; return Response.json({}); }
      if (name === 'get_chat') return Response.json({thread: {active: chats[id].active, events: sent[id] || []}});
      if (name === 'send_event') {
        (sent[id] ||= []).push(body.event);
        if (failure === 'lost-after') throw new TypeError('Failed to fetch');
        return Response.json({event_id: 'e'});
      }
      return Response.json({});
    },
  };
  browser.window = browser; browser.parent = browser;
  vm.runInContext(readFileSync(new URL('../blast/web-adapter.js', import.meta.url), 'utf8'), vm.createContext(browser));
  const messages = [];
  const done = new Promise((resolve) => browser.chrome.runtime.onMessage.addListener((event) => { messages.push(event); if (event.type === 'DONE') resolve(event); }));
  return {browser, calls, sent, done, messages, failureLog: () => JSON.parse(storage.getItem('ca-livechat-engagement:local') || '{}').failureLog || []};
}

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const job = (n) => ({url: `https://my.livechatinc.com/chats/C${n}/T${n}`, messages: ['Hi', 'Reload and claim'], imageDataUrl: IMAGE, imageFileName: 'a.png'});
const summary = (events) => events.map((e) => e.type === 'message' ? e.text : e.type);

test('an open chat gets the agent added with their email, not the login UUID, and receives both messages and the image', async () => {
  const chats = {C1: {active: true, users: [{id: 'customer-1', type: 'customer'}]}};
  const t = boot({chats, identity: {ok: true, login: 'uuid-login', email: 'agent@example.com'}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.deepEqual(summary(t.sent.C1), ['Hi', 'Reload and claim', 'file']);
  assert.equal(t.calls.find((c) => c.name === 'add_user_to_chat').body.user_id, 'agent@example.com');
  assert.equal(t.calls.find((c) => c.name === 'remove_user_from_chat').body.user_id, 'agent@example.com');
  assert.equal(t.failureLog().length, 0);
});

test('when the email cannot be read, the login id is still tried and a refusal is reported (nothing half-sent)', async () => {
  const chats = {C1: {active: true, users: [{id: 'customer-1', type: 'customer'}]}};
  const t = boot({chats, identity: {ok: false, error: 'no email'}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.equal(t.sent.C1, undefined);
  assert.equal(t.failureLog().length, 1);
  assert.match(t.failureLog()[0].reason, /user_id/);
});

test('an agent already in the open chat (listed by email) is not added again', async () => {
  const chats = {C1: {active: true, users: [{id: 'customer-1', type: 'customer'}, {id: 'Agent@Example.com', type: 'agent'}]}};
  const t = boot({chats, identity: {ok: true, login: 'uuid-login', email: 'agent@example.com'}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.equal(t.calls.filter((c) => c.name === 'add_user_to_chat').length, 0);
  assert.deepEqual(summary(t.sent.C1), ['Hi', 'Reload and claim', 'file']);
});

test('a lost connection while sending a message that never arrived is retried and all three items arrive once', async () => {
  const chats = {C1: {active: false, users: [{id: 'customer-1', type: 'customer'}]}};
  const t = boot({chats, identity: {ok: false}, failures: {send_event: (n) => n === 2 ? 'lost-before' : ''}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.deepEqual(summary(t.sent.C1), ['Hi', 'Reload and claim', 'file']);
  assert.equal(t.failureLog().length, 0);
});

test('a lost answer for a message that DID arrive is recognised and the message is not sent twice', async () => {
  const chats = {C1: {active: false, users: [{id: 'customer-1', type: 'customer'}]}};
  const t = boot({chats, identity: {ok: false}, failures: {send_event: (n) => n === 2 ? 'lost-after' : ''}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.deepEqual(summary(t.sent.C1), ['Hi', 'Reload and claim', 'file']);
  assert.equal(t.failureLog().length, 0);
});

test('a chat that fails with a lost connection while resuming is tried again and the chat is closed afterwards', async () => {
  const chats = {C1: {active: false, users: [{id: 'customer-1', type: 'customer'}]}};
  const t = boot({chats, identity: {ok: false}, failures: {resume_chat: (n) => n === 1 ? 'lost-before' : ''}});
  t.browser.chrome.runtime.sendMessage({type: 'START', concurrency: 1, delay: 0, jobs: [job(1)]});
  await t.done;
  assert.deepEqual(summary(t.sent.C1), ['Hi', 'Reload and claim', 'file']);
  assert.equal(chats.C1.active, false);
});
