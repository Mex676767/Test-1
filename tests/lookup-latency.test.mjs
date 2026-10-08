import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/lookup-latency.mjs', import.meta.url));
const idle = { gapMs: 250, active: 0, queued: 0, limited: 0, retries429: 0, tokenLimited: 0, upstream: 0, startsByClass: { token: 0, read: 0, write: 0 }, location: { colo: 'SIN', loc: 'MY' }, burst: { size: 1, effective: 1, offUntil: null } };

async function withFake(behaviour, run) {
  const seen = { lookups: [], stats: 0, keys: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/lark-search') {
        seen.lookups.push(JSON.parse(body));
        const status = behaviour.lookupStatus?.(seen.lookups.length) ?? 200;
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: status === 200, lookupWarnings: [] }));
      } else if (req.url === '/queue-stats') {
        seen.stats++; seen.keys.push(req.headers['x-stats-key']);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ at: new Date().toISOString(), stats: behaviour.stats(seen) }));
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`, seen); } finally { await new Promise((resolve) => server.close(resolve)); }
}
function runScript(base, extraArgs = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--base', base, '--count', '3', '--spacing-ms', '20', ...extraArgs], { env: { ...process.env, QUEUE_STATS_KEY: 'test-key', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('sends single preview lookups one at a time, prints each time, p50/p95 and the snapshots, and never the key', async () => {
  await withFake({ stats: () => idle }, async (base, seen) => {
    const r = await runScript(base);
    assert.equal(r.code, 0, r.err);
    assert.equal(seen.lookups.length, 3);
    assert.ok(seen.lookups.every((b) => b.preview === true && /^zzlat\d{3}$/.test(b.username) && !('link' in b)), 'read-only, zz usernames, no chat link');
    assert.match(r.out, /lookup  1: .* s  HTTP 200/); assert.match(r.out, /p50 .* s   p95 .* s/);
    assert.match(r.out, /queue runs in: SIN \(MY\)/);
    assert.match(r.out, /queue snapshots: .*"label":"before".*"label":"after"/);
    assert.ok(seen.keys.every((k) => k === 'test-key'));
    assert.doesNotMatch(r.out + r.err, /test-key/);
  });
});

test('real lookups (with a case row) need a second explicit flag', async () => {
  await withFake({ stats: () => idle }, async (base, seen) => {
    const refused = await runScript(base, ['--with-case-row']);
    assert.equal(refused.code, 2); assert.equal(seen.lookups.length, 0);
    assert.match(refused.err, /i-understand-this-creates-rows/);
    const ok = await runScript(base, ['--with-case-row', '--i-understand-this-creates-rows']);
    assert.equal(ok.code, 0, ok.err);
    assert.ok(seen.lookups.every((b) => b.preview === false && /^https:\/\/my\.livechatinc\.com\/chats\/ZZLATC\d+\/ZZLATT\d+$/.test(b.link)));
  });
});

test('refuses to start while the queue is backed off or busy: not one lookup is sent', async () => {
  for (const stats of [{ ...idle, gapMs: 500 }, { ...idle, active: 2 }]) {
    await withFake({ stats: () => stats }, async (base, seen) => {
      const r = await runScript(base);
      assert.notEqual(r.code, 0); assert.equal(seen.lookups.length, 0);
      assert.match(r.err, /refusing to start/); assert.match(r.err, /queue snapshots:/);
    });
  }
});

test('stops, prints the snapshots and exits non-zero when Lark throttles while it runs, or lookups fail', async () => {
  await withFake({ stats: (seen) => (seen.lookups.length >= 1 ? { ...idle, limited: 1, retries429: 1, gapMs: 500 } : idle) }, async (base, seen) => {
    const r = await runScript(base);
    assert.equal(r.code, 1); assert.equal(seen.lookups.length, 1, 'stopped after the first lookup');
    assert.match(r.err, /limited went up by 1/); assert.match(r.err, /queue snapshots:/);
  });
  await withFake({ stats: () => idle, lookupStatus: () => 500 }, async (base, seen) => {
    const r = await runScript(base, ['--count', '6']);
    assert.equal(r.code, 1); assert.equal(seen.lookups.length, 3, 'stops after the third non-200 (limit 2)');
  });
});

test('production needs --allow-production-reads and the stats key; nothing is sent without them', async () => {
  const run = (extra, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--base', 'https://test-1-7wp.pages.dev', ...extra], { env: { ...process.env, QUEUE_STATS_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
  const a = await run([], {});
  assert.equal(a.code, 2); assert.match(a.err, /Refusing to run against test-1-7wp\.pages\.dev/);
  const b = await run(['--allow-production-reads'], {});
  assert.equal(b.code, 2); assert.match(b.err, /without the queue stats key/);
});
