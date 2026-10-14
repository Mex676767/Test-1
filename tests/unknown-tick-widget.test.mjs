import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

function widget({ previewMode = false, selectedAgent = '96 Alice', state = {}, failing = false } = {}) {
  const posts = [];
  const context = vm.createContext({
    previewMode, selectedAgent, state, String, JSON,
    fetch: (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return failing ? Promise.reject(new Error('offline')) : Promise.resolve({}); },
  });
  vm.runInContext(fn('reportUnknownTick'), context);
  return { posts, report: (...args) => vm.runInContext(`reportUnknownTick(${args.map((a) => JSON.stringify(a)).join(',')})`, context) };
}

test('ticking Unknown tells the server the thread and chat from the card\'s link, the agent, and whether it was automatic', () => {
  const w = widget({ state: { CHAT1: { chatUrl: 'https://my.livechatinc.com/chats/CHAT1/THREAD1' } } });
  w.report('CHAT1', true, false);
  w.report('CHAT1', false, false);
  w.report('CHAT1', true, true);
  assert.deepEqual(w.posts.map((p) => p.url), ['/unknown-tick', '/unknown-tick', '/unknown-tick']);
  assert.deepEqual(w.posts[0].body, { agentName: '96 Alice', ticked: true, source: 'manual', threadId: 'THREAD1', chatId: 'CHAT1' });
  assert.equal(w.posts[1].body.ticked, false);
  assert.equal(w.posts[2].body.source, 'auto');
});

test('an archived card is known by its thread id; a card with no link yet is sent by its own id only', () => {
  const archived = widget({ state: { T7: { chatUrl: 'https://my.livechatinc.com/archives/T7' } } });
  archived.report('T7', true, false);
  assert.deepEqual([archived.posts[0].body.threadId, archived.posts[0].body.chatId], ['T7', 'T7']);
  const noLink = widget({ state: { NEWCHAT: { chatUrl: '' } } });
  noLink.report('NEWCHAT', true, false);
  assert.deepEqual([noLink.posts[0].body.threadId, noLink.posts[0].body.chatId], ['', 'NEWCHAT']);
});

test('nothing is sent from the admin preview, without an agent name, or for a chat the widget does not know; a failed send changes nothing', async () => {
  const chat = { C: { chatUrl: '' } };
  const preview = widget({ previewMode: true, state: chat });
  const noAgent = widget({ selectedAgent: '', state: chat });
  const unknown = widget({ state: {} });
  preview.report('C', true, false); noAgent.report('C', true, false); unknown.report('C', true, false);
  assert.equal(preview.posts.length + noAgent.posts.length + unknown.posts.length, 0);
  const offline = widget({ failing: true, state: chat });
  assert.doesNotThrow(() => offline.report('C', true, false));
  await new Promise((resolve) => setTimeout(resolve, 5)); // the rejected send is swallowed, not an unhandled rejection
});

test('every way a chat becomes Unknown or stops being Unknown reports it: the tick, the auto-tick, a forced lookup and a failed forced lookup', () => {
  const setUnknown = app.slice(app.indexOf('function setUnknown'), app.indexOf('function setUnknown') + 400);
  assert.match(setUnknown, /s\.isUnknown = value;\s*\n\s*reportUnknownTick\(chatId, value, silent\);/);
  assert.match(app, /if \(forcing\) \{ s\.isUnknown = false; reportUnknownTick\(chatId, false, true\); \}/);
  assert.match(app, /if \(forcing\) \{ s\.isUnknown = true; reportUnknownTick\(chatId, true, true\); \}/);
});
