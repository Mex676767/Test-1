import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../blast/web-adapter.js', import.meta.url), 'utf8');
const origin = 'https://widget.test';
const jobs = (count) => Array.from({ length: count }, (_, i) => ({ url: `https://my.livechatinc.com/chats/CHAT${i}/THREAD${i}`, messages: [`Message ${i}`] }));

function harness({ blocked = false, send, partitioned = false } = {}) {
  const shared = new Map();
  const popupStore = partitioned ? new Map() : shared;
  const contexts = [];
  const calls = [];
  const windows = [];
  let time = Date.now();
  function make(runner = false, opener = null, ref = null) {
    const store = runner ? popupStore : shared;
    const listeners = new Map();
    const session = new Map([
      ['ca-livechat-agent-token:lc1', 'test-agent-token'],
      ['ca-livechat-agent-token-expiry:lc1', String(time + 3600000)],
    ]);
    const area = (map, notify = false) => ({
      getItem: (key) => map.get(key) ?? null,
      setItem(key, value) {
        const previous = map.get(key) ?? null;
        map.set(key, String(value));
        if (notify) for (const peer of contexts) if (peer !== browser && peer.alive && peer.store === store) peer.dispatch('storage', { key, oldValue: previous, newValue: String(value) });
      },
      removeItem: (key) => map.delete(key),
    });
    const browser = {
      alive: true,
      store,
      location: { origin, pathname: runner ? '/blast/runner.html' : '/blast/index.html', search: '?account=lc1', href: `${origin}/blast/${runner ? 'runner' : 'index'}.html?account=lc1` },
      sessionStorage: area(session), localStorage: area(store, true),
      document: { getElementById: () => null },
      opener,
      parent: { sessionStorage: area(session) },
      addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
      dispatch(name, event) { if (browser.alive) for (const fn of listeners.get(name) || []) fn(event); },
      open(url, name) {
        if (blocked) return null;
        const existing = windows.find((w) => w.name === name);
        if (existing) { existing.postSource = browser.selfRef; return existing; }
        const handle = { name, postSource: browser.selfRef, location: { href: url, pathname: '/blast/runner.html' }, focus() {}, postMessage(data) { handle.browser.dispatch('message', { origin, data: structuredClone(data), source: handle.postSource }); } };
        windows.push(handle);
        return handle;
      },
      crypto: webcrypto, URL, URLSearchParams, AbortSignal, File, FormData, Response, console,
      Date: class extends Date { static now() { time += 350; return time; } },
      setTimeout(fn, delay) { return delay >= 10000 ? { pending: fn } : setTimeout(fn, 0); },
      clearTimeout(timer) { if (typeof timer?.pending !== 'function') clearTimeout(timer); },
      async fetch(url, init = {}) {
        if (url === '/livechat-oauth-config') return Response.json({});
        const body = init.body ? JSON.parse(init.body) : {};
        if (url === '/livechat-chat-status') return Response.json({ ok: true, chatId: body.realChatId, isActive: false, accountKey: 'lc1', raw: { users: [] } });
        const action = String(url).split('/').pop();
        calls.push({ action, body });
        assert.ok(init.signal, 'outbound actions have a bounded deadline');
        if (action === 'send_event') {
          if (send) await send(body);
          return Response.json({ event_id: `${body.chat_id}-event` });
        }
        return Response.json({});
      },
    };
    browser.window = browser;
    browser.selfRef = { postMessage(data) { browser.dispatch('message', { origin, data: structuredClone(data), source: windows.at(-1) }); } };
    vm.runInContext(source, vm.createContext(browser));
    contexts.push(browser);
    if (ref) ref.browser = browser;
    return browser;
  }
  const parent = make();
  function start(list) {
    parent.chrome.runtime.sendMessage({ type: 'START', jobs: list, concurrency: 5, delay: 0 });
    if (blocked) return null;
    const ref = windows.at(-1);
    const opener = parent.selfRef;
    const runner = make(true, opener, ref);
    const events = [];
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    runner.chrome.runtime.onMessage.addListener((event) => { events.push(event); if (event.type === 'DONE') done(event); });
    opener.postMessage({ type: 'BLAST_RUNNER_READY' });
    return { runner, events, finished };
  }
  return { parent, start, make, calls, windows, shared };
}

test('151-chat delivery survives destroying and recreating the widget', async () => {
  let release;
  let observed;
  const reached = new Promise((resolve) => { observed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ send: async () => { observed(); await gate; } });
  const { finished } = h.start(jobs(151));
  await reached;
  h.parent.alive = false;
  const reloadedWidget = h.make();
  assert.equal(reloadedWidget.__blastRunState().running, true);
  const events = [];
  reloadedWidget.chrome.runtime.onMessage.addListener((event) => events.push(event));
  release();
  const result = await finished;
  assert.equal(result.sent, 151);
  assert.equal(result.failed, 0);
  assert.equal(new Set(h.calls.filter((c) => c.action === 'send_event').map((c) => c.body.chat_id)).size, 151);
  assert.equal(h.calls.filter((c) => c.action === 'deactivate_chat').length, 151);
  assert.equal(reloadedWidget.__blastRunState().running, false);
  assert.ok(events.some((event) => event.type === 'DONE'));
});

test('a failed send is cleaned up and does not abandon the rest of a 151-chat queue', async () => {
  const h = harness({ send: async (body) => { if (body.chat_id === 'CHAT1') throw new TypeError('Failed to fetch'); } });
  const result = await h.start(jobs(151)).finished;
  assert.equal(result.sent, 150);
  assert.equal(result.failed, 1);
  // A lost send response is ambiguous: never blindly resend customer messages.
  assert.equal(h.calls.filter((c) => c.action === 'send_event' && c.body.chat_id === 'CHAT1').length, 1);
  assert.equal(h.calls.filter((c) => c.action === 'deactivate_chat').length, 151);
  const history = JSON.parse(h.shared.get('ca-livechat-engagement:local')).failureLog;
  assert.equal(history[0].stage, 'Send message 1');
});

test('Stop from a reloaded widget reaches the delivery window and finishes cleanup', async () => {
  let release;
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ send: async () => { reached(); await gate; } });
  const { finished } = h.start(jobs(151));
  await waiting;
  h.parent.alive = false;
  const reloaded = h.make();
  reloaded.chrome.runtime.sendMessage({ type: 'STOP' });
  release();
  const result = await finished;
  assert.equal(result.stopped, true);
  assert.ok(h.calls.filter((c) => c.action === 'send_event').length <= 5);
  assert.equal(h.calls.filter((c) => c.action === 'deactivate_chat').length, h.calls.filter((c) => c.action === 'resume_chat').length);
  assert.equal(reloaded.__blastRunState().running, false);
});

test('blocked delivery pop-up fails before opening or messaging any chat', () => {
  const h = harness({ blocked: true });
  const events = [];
  h.parent.chrome.runtime.onMessage.addListener((event) => events.push(event));
  h.start(jobs(151));
  assert.equal(h.calls.length, 0);
  assert.ok(events.some((event) => event.type === 'ERROR' && /pop-ups/.test(event.text)));
  assert.ok(events.some((event) => event.type === 'DONE' && event.stopped));
});

test('partitioned iframe storage reconnects through the delivery window without replaying the queue', async () => {
  let release;
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ partitioned: true, send: async () => { reached(); await gate; } });
  const { finished } = h.start(jobs(151));
  await waiting;
  h.parent.alive = false;
  const replacement = h.make();
  replacement.__blastFocusRunner();
  const events = [];
  replacement.chrome.runtime.onMessage.addListener((event) => events.push(event));
  release();
  assert.equal((await finished).sent, 151);
  assert.equal(replacement.__blastRunState().running, false);
  assert.equal(events.filter((event) => event.type === 'DONE').length, 1);
  assert.equal(h.calls.filter((c) => c.action === 'send_event').length, 151);
  assert.ok(![...h.shared.values()].some((value) => value.includes('test-agent-token')));
});
