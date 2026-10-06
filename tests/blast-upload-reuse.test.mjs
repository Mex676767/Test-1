import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

const adapter = readFileSync(new URL('../blast/web-adapter.js', import.meta.url), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function blastRun({ reuse, chats = 3, concurrency = 1, failFirstUpload = false, image = PNG }) {
  const values = new Map([
    ['ca-livechat-agent-token:lc2', 'mock-agent-token'],
    ['ca-livechat-agent-token-expiry:lc2', String(Date.now() + 3600000)],
    ...(reuse ? [['ca-blast-reuse-upload', '1']] : []),
  ]);
  const storage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
  const calls = [];
  let time = Date.now(), uploads = 0;
  const browser = {
    location: { origin: 'https://widget.test', pathname: '/blast/index', search: '?account=lc2' },
    localStorage: storage, sessionStorage: storage, document: { getElementById: () => null }, addEventListener() {},
    open() { throw new Error('Blast must stay embedded'); },
    URL, URLSearchParams, Response, FormData, File, AbortSignal, crypto: webcrypto, atob,
    Date: class extends Date { static now() { time += 350; return time; } },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    async fetch(url, init = {}) {
      if (url === '/livechat-oauth-config') return Response.json({});
      const action = String(url).split('/').pop();
      // upload_file carries a FormData body (not JSON), so it must be handled before any JSON.parse
      const body = action === 'upload_file' ? {} : JSON.parse(init.body || '{}');
      if (url === '/livechat-chat-status') return Response.json({ ok: true, chatId: body.realChatId, isActive: false, accountKey: 'lc2', raw: { users: [] } });
      if (action === 'upload_file') {
        uploads += 1;
        calls.push({ action, body: {} });
        if (failFirstUpload && uploads === 1) return Response.json({ error: { message: 'file rejected', type: 'validation' } }, { status: 400 }); // non-retryable, so the chat really fails
        return Response.json({ url: `https://cdn.test/file-${uploads}.png` });
      }
      calls.push({ action, body });
      return Response.json(action === 'send_event' ? { event_id: 'mock-event' } : {});
    },
  };
  browser.window = browser; browser.parent = browser;
  vm.runInContext(adapter, vm.createContext(browser));
  const done = new Promise((resolve) => browser.chrome.runtime.onMessage.addListener((event) => { if (event.type === 'DONE') resolve(event); }));
  browser.chrome.runtime.sendMessage({ type: 'START', concurrency, delay: 0,
    jobs: Array.from({ length: chats }, (_, i) => ({ url: `https://my.livechatinc.com/chats/C${i}/T${i}`, messages: [`Hi ${i}`], imageDataUrl: image, imageFileName: 'promo.png' })) });
  const result = await done;
  const fileEvents = calls.filter((c) => c.action === 'send_event' && c.body.event?.type === 'file');
  return { result, uploads, fileEvents, calls };
}

test('default (flag off): the image is uploaded once per chat, exactly as before', async () => {
  const { uploads, fileEvents } = await blastRun({ reuse: false });
  assert.equal(uploads, 3);
  assert.deepEqual(fileEvents.map((c) => c.body.event.url), ['https://cdn.test/file-1.png', 'https://cdn.test/file-2.png', 'https://cdn.test/file-3.png']);
});

test('opt-in reuse: ONE upload per run, the same URL goes to every chat, and every chat still gets its own file event', async () => {
  const { result, uploads, fileEvents } = await blastRun({ reuse: true, chats: 5 });
  assert.equal(result.stopped, false);
  assert.equal(uploads, 1);
  assert.equal(fileEvents.length, 5);
  assert.equal(new Set(fileEvents.map((c) => c.body.chat_id)).size, 5, 'five different chats');
  assert.ok(fileEvents.every((c) => c.body.event.url === 'https://cdn.test/file-1.png' && c.body.event.alternative_text === 'promo.png'));
});

test('opt-in reuse with concurrent chats still uploads only once (they share the in-flight upload)', async () => {
  const { uploads, fileEvents } = await blastRun({ reuse: true, chats: 8, concurrency: 5 });
  assert.equal(uploads, 1);
  assert.equal(fileEvents.length, 8);
});

test('opt-in reuse: a failed upload is not cached, so a later chat uploads again', async () => {
  const { uploads, fileEvents } = await blastRun({ reuse: true, chats: 3, failFirstUpload: true });
  assert.equal(uploads, 2, 'first failed, the second succeeded and was reused');
  assert.equal(fileEvents.length, 2, 'the chat whose upload failed is reported failed, not silently skipped');
});

test('different images never share an upload when reuse is on', async () => {
  const a = await blastRun({ reuse: true, chats: 2, image: PNG });
  const b = await blastRun({ reuse: true, chats: 2, image: 'data:image/png;base64,QUJDREVGRw==' });
  assert.equal(a.uploads, 1);
  assert.equal(b.uploads, 1);
});

// ---- the reported bug: "upload image doesn't send any images" (storage quota) --------------------------
const QUOTA = 5_000_000; // ~5 MB of Web Storage per origin (characters)
function quotaStorage(initial = []) {
  const m = new Map(initial);
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const writes = [];
  return { _m: m, _writes: writes, getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k),
    setItem(k, v) {
      writes.push([k, String(v)]);
      const next = used() - (m.has(k) ? m.get(k).length + k.length : 0) + k.length + String(v).length;
      if (next > QUOTA) { const e = new Error('QuotaExceededError: setItem exceeded the quota'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    } };
}
async function quotaRun({ chats, imageKB, tweakJob }) {
  const image = 'data:image/png;base64,' + Buffer.alloc(imageKB * 1024, 7).toString('base64');
  const session = quotaStorage([['ca-livechat-agent-token:lc2', 'tok'], ['ca-livechat-agent-token-expiry:lc2', String(Date.now() + 3600000)]]);
  const events = [], calls = [];
  let time = Date.now();
  const browser = {
    location: { origin: 'https://w.test', pathname: '/blast/index', search: '?account=lc2' }, localStorage: quotaStorage(), sessionStorage: session,
    document: { getElementById: () => null }, addEventListener() {}, open() {}, URL, URLSearchParams, Response, FormData, File, AbortSignal, crypto: webcrypto, atob,
    Date: class extends Date { static now() { time += 350; return time; } }, setTimeout: (f) => setTimeout(f, 0), clearTimeout,
    async fetch(url, init = {}) {
      if (url === '/livechat-oauth-config') return Response.json({});
      const action = String(url).split('/').pop();
      if (url === '/livechat-chat-status') return Response.json({ ok: true, chatId: 'X', isActive: false, accountKey: 'lc2', raw: { users: [] } });
      calls.push(action);
      return Response.json(action === 'upload_file' ? { url: 'https://cdn/x.png' } : action === 'send_event' ? { event_id: 'e' } : {});
    },
  };
  browser.window = browser; browser.parent = browser;
  vm.runInContext(adapter, vm.createContext(browser));
  const done = new Promise((r) => browser.chrome.runtime.onMessage.addListener((e) => { events.push(e); if (e.type === 'DONE') r(e); }));
  const jobs = Array.from({ length: chats }, (_, i) => ({ url: `https://my.livechatinc.com/chats/C${i}/T${i}`, messages: ['hi'], imageDataUrl: image, imageFileName: 'promo.png' }));
  browser.chrome.runtime.sendMessage({ type: 'START', concurrency: 1, delay: 0, jobs: tweakJob ? jobs.map(tweakJob) : jobs });
  const result = await done;
  const firstWrite = (needle) => session._writes.find(([k]) => k.includes(needle))?.[1] || '';
  return { result, events, calls, image, session, journalWrite: firstWrite('queue:'), imagesWrite: firstWrite('queue-images:'), lastJournalWrite: [...session._writes].reverse().find(([k]) => k.includes('queue:'))?.[1] || '' };
}

test('a realistic image x many chats no longer overruns browser storage: every chat gets its text AND its image', async () => {
  const { result, events, calls } = await quotaRun({ chats: 120, imageKB: 100 });
  assert.equal(result.stopped, false);
  assert.equal(events.some((e) => e.type === 'ERROR'), false, 'no "Cannot save recoverable queue" error');
  assert.equal(calls.filter((c) => c === 'send_event').length, 240, '120 messages + 120 images');
  assert.equal(calls.filter((c) => c === 'upload_file').length, 120);
});

test('the image is saved ONCE under its own key, and every checkpoint of the queue stays small', async () => {
  const { journalWrite, imagesWrite, lastJournalWrite, image } = await quotaRun({ chats: 30, imageKB: 100 });
  const marker = image.slice(0, 200);
  assert.equal(imagesWrite.split(marker).length - 1, 1, 'one copy of the pixels in the images key');
  assert.equal(journalWrite.includes(marker), false, 'the journal holds no pixels');
  assert.equal(lastJournalWrite.includes(marker), false, 'and neither does any later checkpoint');
  assert.ok(lastJournalWrite.length < 100_000, `checkpoint is ${lastJournalWrite.length} chars, not hundreds of KB`);
  const saved = JSON.parse(journalWrite);
  assert.ok(saved.jobs.every((j) => j.imageId && !j.imageDataUrl), 'jobs carry a reference');
  assert.equal(Object.keys(JSON.parse(imagesWrite)).length, 1);
});

test('a job whose image reference cannot be resolved fails BEFORE any text is sent', async () => {
  const { events, calls } = await quotaRun({ chats: 1, imageKB: 10, tweakJob: (job) => ({ ...job, imageDataUrl: undefined, imageId: 'img-does-not-exist' }) });
  assert.equal(calls.filter((c) => c === 'send_event').length, 0, 'neither the message nor an image was sent');
  assert.ok(events.some((e) => /image for this queue is missing/i.test(JSON.stringify(e))));
});

test('jobs that still carry the image inline (older callers) keep working', async () => {
  const { calls } = await quotaRun({ chats: 3, imageKB: 20 });
  assert.equal(calls.filter((c) => c === 'upload_file').length, 3);
});

// ---- popup: the saved chat entries hold the image once too -----------------------------------------------
test('popup save() persists one copy of the image plus a reference per chat, and survives a storage error', () => {
  const popup = readFileSync(new URL('../blast/popup.js', import.meta.url), 'utf8');
  const NL = String.fromCharCode(10);
  const grab = (name) => { const start = popup.indexOf(`function ${name}(`); return popup.slice(start, popup.indexOf(NL + '}', start) + 2); };
  const saved = [], logs = [];
  let throwQuota = false;
  const context = vm.createContext({
    chatEntries: Array.from({ length: 50 }, (_, i) => ({ url: `u${i}`, messages: null, imageDataUrl: PNG, imageFileName: 'a.png' })).concat([{ url: 'no-image', messages: null }]),
    chrome: { storage: { local: { set: (v) => { if (throwQuota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } saved.push(v); } } } },
    addLog: (m, t) => logs.push([m, t]), Math, JSON,
  });
  vm.runInContext([grab('fnvHash'), grab('entryImageId'), grab('save')].join('\n'), context);
  vm.runInContext('save()', context);
  const { chatEntries, chatImages } = saved[0];
  assert.equal(Object.keys(chatImages).length, 1, 'one stored image');
  assert.equal(JSON.stringify(chatEntries).split(PNG).length - 1, 0, 'no entry carries the pixels');
  assert.ok(chatEntries.slice(0, 50).every((e) => e.imageId === Object.keys(chatImages)[0]));
  assert.equal(chatEntries[50].imageId, undefined);
  throwQuota = true;
  assert.doesNotThrow(() => vm.runInContext('save()', context));
  assert.match(logs.at(-1)[0], /image too large for browser storage/);
  // and the loader re-attaches the image from the shared store
  assert.match(popup, /imageDataUrl: entry\.imageDataUrl \|\| savedImages\[entry\.imageId\] \|\| null/);
});

test('a destroyed iframe mid-run is recovered WITH the image: every chat still gets its text and its image, queue + image store cleaned up', async () => {
  const values = new Map([
    ['ca-livechat-agent-token:lc2', 'mock-token'], ['ca-livechat-agent-token-expiry:lc2', String(Date.now() + 3600000)], ['ca-livechat-agent-account-id:lc2', 'agent'],
  ]);
  const storage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
  const chats = new Map(), calls = [];
  let destroyed = false, notifyDestroyed;
  const destruction = new Promise((resolve) => { notifyDestroyed = resolve; });
  function boot() {
    const events = {};
    let time = Date.now();
    const browser = {
      location: { origin: 'https://widget.test', pathname: '/blast/index', search: '?account=lc2' }, sessionStorage: storage, localStorage: storage,
      document: { getElementById: () => null }, addEventListener: (n, fn) => { events[n] = fn; },
      URL, URLSearchParams, Response, FormData, File, AbortSignal, crypto: webcrypto, atob,
      Date: class extends Date { static now() { time += 350; return time; } }, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
      async fetch(url, init = {}) {
        if (url === '/livechat-oauth-config') return Response.json({});
        const name = String(url).split('/').pop();
        if (name === 'upload_file') { calls.push({ name }); return Response.json({ url: 'https://cdn.test/recovered.png' }); }
        const body = JSON.parse(init.body || '{}');
        const id = body.realChatId || body.chat_id || body.chat?.id || body.id;
        const chat = chats.get(id) || { active: false, events: [] };
        chats.set(id, chat);
        if (url === '/livechat-chat-status') return Response.json({ ok: true, chatId: id, isActive: chat.active, accountKey: 'lc2', raw: { users: [{ id: 'agent' }] } });
        calls.push({ name, id });
        if (name === 'resume_chat') chat.active = true;
        if (name === 'send_event') chat.events.push(body.event);
        if (name === 'deactivate_chat') chat.active = false;
        if (!destroyed && name === 'send_event' && id === 'C2' && body.event.type === 'message') {   // the old document dies mid-run
          destroyed = true; events.pagehide(); notifyDestroyed(); return new Promise(() => {});
        }
        return Response.json(name === 'get_chat' ? { thread: { events: chat.events } } : { event_id: 'mock-event' });
      },
    };
    browser.window = browser; browser.parent = browser;
    vm.runInContext(adapter, vm.createContext(browser));
    return browser;
  }
  const first = boot();
  first.chrome.runtime.sendMessage({ type: 'START', concurrency: 1, delay: 0,
    jobs: Array.from({ length: 6 }, (_, i) => ({ url: `https://my.livechatinc.com/chats/C${i}/T${i}`, messages: [`Test ${i}`], imageDataUrl: PNG, imageFileName: 'promo.png' })) });
  await destruction;
  assert.ok(values.get('ca-livechat-engagement:queue:lc2'));
  assert.ok(values.get('ca-livechat-engagement:queue-images:lc2'), 'the image store survives the reload');
  const next = boot();
  const done = new Promise((resolve) => next.chrome.runtime.onMessage.addListener((event) => { if (event.type === 'DONE') resolve(event); }));
  next.__blastRestoreQueue();
  assert.equal((await done).stopped, false);
  for (let i = 0; i < 6; i += 1) {
    const types = chats.get(`C${i}`).events.map((e) => e.type);
    assert.deepEqual(types.sort(), ['file', 'message'], `chat C${i} got exactly one text and one image`);
  }
  assert.equal(values.get('ca-livechat-engagement:queue:lc2'), undefined);
  assert.equal(values.get('ca-livechat-engagement:queue-images:lc2'), undefined, 'image store is cleaned up with the queue');
});
