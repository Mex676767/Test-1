import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRunStart, checkRunEnd } from '../scripts/stress-guard.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/stress-lookup.mjs', import.meta.url));
const idle = { gapMs: 250, active: 0, queued: 0, limited: 0, retries429: 0, tokenLimited: 0 };
const okRuns = (n, extra = []) => [...Array.from({ length: n }, () => ({ status: 200 })), ...extra];

test('start rule: only an idle queue at its base gap may be tested', () => {
  assert.equal(checkRunStart(idle, 250).ok, true);
  const backedOff = checkRunStart({ ...idle, gapMs: 500 }, 250);
  assert.equal(backedOff.ok, false); assert.match(backedOff.reason, /gapMs is 500, not the base gap 250/);
  assert.equal(checkRunStart({ ...idle, active: 2 }, 250).ok, false);
  assert.equal(checkRunStart({ ...idle, queued: 1 }, 250).ok, false);
  assert.equal(checkRunStart(null, 250).ok, false, 'no snapshot -> cannot tell -> refuse');
  assert.equal(checkRunStart({ ...idle, gapMs: 300 }, 300).ok, true, 'the base gap is configurable');
});

test('end rule: more than 2 non-200, or any throttle counter going up, or a raised gap, stops the run', () => {
  assert.equal(checkRunEnd({ results: okRuns(25), before: idle, after: idle }).stop, false);
  assert.equal(checkRunEnd({ results: okRuns(25, [{ status: 500 }, { status: 0 }]), before: idle, after: idle }).stop, false, '2 non-200 are tolerated');
  const three = checkRunEnd({ results: okRuns(25, [{ status: 500 }, { status: 0 }, { status: 502 }]), before: idle, after: idle });
  assert.equal(three.stop, true); assert.match(three.reasons[0], /3 requests did not answer HTTP 200/);
  for (const key of ['limited', 'retries429', 'tokenLimited']) {
    const verdict = checkRunEnd({ results: okRuns(25), before: idle, after: { ...idle, [key]: 1 } });
    assert.equal(verdict.stop, true, key); assert.match(verdict.reasons.join(' '), new RegExp(`${key} went up by 1`));
  }
  const gap = checkRunEnd({ results: okRuns(25), before: idle, after: { ...idle, gapMs: 500 } });
  assert.equal(gap.stop, true); assert.match(gap.reasons.join(' '), /gapMs rose from 250 to 500/);
  assert.equal(checkRunEnd({ results: okRuns(25), before: { ...idle, limited: 4 }, after: { ...idle, limited: 4 } }).stop, false, 'only the DELTA counts, earlier throttles do not');
  assert.equal(checkRunEnd({ results: okRuns(25), before: null, after: null }).stop, false, 'without snapshots only the HTTP check applies');
});

// ---- the real script against a local fake (no production host, no Lark) --------------------------------------------------------
async function withFake(behaviour, run) {
  const seen = { lookups: 0, stats: 0, keys: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/lark-search') {
        const n = ++seen.lookups;
        const status = behaviour.lookupStatus?.(n) ?? 200;
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: status === 200, lookupWarnings: [] }));
      } else if (req.url === '/queue-stats') {
        seen.stats++; seen.keys.push(req.headers['x-stats-key']);
        const stats = behaviour.stats(seen);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ at: new Date().toISOString(), stats }));
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`, seen); } finally { await new Promise((resolve) => server.close(resolve)); }
}
function runScript(base, extraArgs = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--base', base, '--agents', '5', '--rounds', '2', ...extraArgs], { env: { ...process.env, QUEUE_STATS_KEY: 'test-key', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('script: a healthy queue runs every round, exits 0, and never prints the key', async () => {
  await withFake({ stats: () => idle }, async (base, seen) => {
    const r = await runScript(base);
    assert.equal(r.code, 0, r.err);
    assert.equal(seen.lookups, 10);
    assert.ok(seen.keys.every((k) => k === 'test-key'));
    assert.doesNotMatch(r.out + r.err, /test-key/);
  });
});

test('script: refuses to start while the queue is still backed off (gapMs 500): not one lookup is sent, exit non-zero', async () => {
  await withFake({ stats: () => ({ ...idle, gapMs: 500 }) }, async (base, seen) => {
    const r = await runScript(base);
    assert.notEqual(r.code, 0);
    assert.equal(seen.lookups, 0, 'no lookup was sent');
    assert.match(r.err, /refusing to start round 1/); assert.match(r.err, /gapMs is 500/);
    assert.match(r.err, /queue snapshots:/, 'the snapshots are printed');
    assert.doesNotMatch(r.err, /test-key/);
  });
});

test('script: stops after a round with more than 2 non-200 answers, prints the snapshots, exits non-zero, and does not start round 2', async () => {
  await withFake({ stats: () => idle, lookupStatus: (n) => (n <= 3 ? 500 : 200) }, async (base, seen) => {
    const r = await runScript(base);
    assert.equal(r.code, 1);
    assert.equal(seen.lookups, 5, 'only round 1 ran');
    assert.match(r.err, /3 requests did not answer HTTP 200/); assert.match(r.err, /queue snapshots:/);
  });
});

test('script: stops after a round in which Lark throttled (limited / retries429 delta), even if every answer was 200', async () => {
  await withFake({ stats: (seen) => (seen.stats >= 2 ? { ...idle, limited: 1, retries429: 1, gapMs: 500 } : idle) }, async (base, seen) => {
    const r = await runScript(base);
    assert.equal(r.code, 1);
    assert.equal(seen.lookups, 5, 'round 2 never started');
    assert.match(r.err, /limited went up by 1/); assert.match(r.err, /retries429 went up by 1/);
  });
});

test('script: against the production host the stats key is required, and nothing is sent without it', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--base', 'https://test-1-7wp.pages.dev', '--allow-production-reads', '--agents', '3'], { env: { ...process.env, QUEUE_STATS_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /Refusing to load-test production without the queue stats key/);
});
