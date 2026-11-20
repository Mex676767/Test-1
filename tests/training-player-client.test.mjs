import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const block = app.match(/const TRAINING_USERNAME = "edwintest";[\s\S]*?\nwindow\.fetch = function trainingAwareFetch[\s\S]*?\n\};/)[0];

function world(chats = {}) {
  const sent = [];
  const window = { fetch: async (input, init) => { sent.push({ url: String(input), init }); return new Response(JSON.stringify({ ok: true, real: true })); } };
  const context = vm.createContext({
    window, location: { href: 'https://example.test/', origin: 'https://example.test' },
    URL, Request, Response, FormData, Promise, JSON, String, Object, Set, Date,
    selectedAgent: '96 Cara',
  });
  vm.runInContext(`${block}\nvar state = ${JSON.stringify(chats)};`, context);
  const post = (path, body) => context.window.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body) }).then((r) => r.json());
  return { sent, post, context };
}

test('saves for the training player never leave the widget and answer as a success', async () => {
  const w = world();
  assert.deepEqual(await w.post('/lark-record', { recordId: 'rectrainingcasexyz', inquiry: ['Grace Period'], status: 'Given' }), { ok: true, training: true });
  assert.deepEqual(await w.post('/lark-claim', { source: 'redeemCode', recordId: 'rectrainingredeem' }), { ok: true, training: true });
  assert.deepEqual(await w.post('/lark-delete-record', { recordId: 'rectrainingcasexyz', agentName: 'x' }), { ok: true, training: true });
  assert.equal((await w.post('/player-name', { recordId: 'rectrainingpnl', username: 'edwintest', name: 'Edwin T' })).customerName, 'Edwin T');
  const form = new FormData(); form.append('username', 'EdwinTest'); form.append('brand', 'LPK');
  assert.equal((await w.post('/birthday-bonus', form)).recordId, 'rectrainingbirthday');
  assert.equal((await w.post('/halloween-claim', { username: 'edwintest', brand: 'LPK' })).ok, false);
  assert.equal(w.sent.length, 0, 'nothing reached the network');
});

test('console notes for the training player are kept in the widget only', async () => {
  const w = world();
  assert.equal((await w.post('/console-note', { username: 'edwintest', brand: 'LPK', note: 'likes slots', type: 'relationship' })).saved, true);
  const listed = await w.post('/console-note', { username: 'edwintest', brand: 'LPK', list: true, type: 'relationship' });
  assert.equal(listed.notes[0].note, 'likes slots');
  assert.deepEqual((await w.post('/console-note', { username: 'edwintest', brand: 'LPK', list: true, type: 'action' })).notes, []);
  assert.equal(w.sent.length, 0);
});

test('chat-based logs of a training chat are not sent; other chats and real players still are', async () => {
  const w = world({ C1: { training: true, chatUrl: 'https://my.livechatinc.com/chats/C1/T1' }, C2: { training: false } });
  await w.post('/claim-log', { agentName: 'a', chatId: 'C1', threadId: 'T1', claim: { program: 'ltvTest' } });
  await w.post('/unknown-tick', { agentName: 'a', chatId: 'X', threadId: 'T1', ticked: true });
  assert.equal(w.sent.length, 0);
  await w.post('/claim-log', { agentName: 'a', chatId: 'C2', threadId: 'T2', claim: {} });
  await w.post('/lark-record', { recordId: 'recRealRow123', username: 'someone' });
  await w.post('/console-note', { username: 'edwintest2', brand: 'LPK', list: true });
  await w.context.window.fetch('/lark-search', { method: 'POST', body: JSON.stringify({ username: 'edwintest', brand: 'LPK' }) });
  assert.deepEqual(w.sent.map((s) => s.url), ['/claim-log', '/lark-record', '/console-note', '/lark-search']);
});
