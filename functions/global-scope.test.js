import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Cloudflare refuses to publish a Function whose module, while loading, generates random values, sets a timer or calls fetch()
// ("Disallowed operation called within global scope"). Node allows all of that, so ordinary tests cannot see it: import every
// module with those operations made to throw, exactly as the platform does.
const root = dirname(fileURLToPath(import.meta.url));
const modules = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) modules.push(path);
  }
})(root);

test('no Function module generates random values, sets timers or calls fetch while it loads', async () => {
  assert.ok(modules.length > 10, 'found the modules');
  const real = { randomUUID: crypto.randomUUID, getRandomValues: crypto.getRandomValues, random: Math.random, setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, fetch: globalThis.fetch };
  const refuse = (what) => () => { throw new Error(`Disallowed operation called within global scope: ${what}`); };
  const failures = [];
  try {
    crypto.randomUUID = refuse('crypto.randomUUID');
    crypto.getRandomValues = refuse('crypto.getRandomValues');
    Math.random = refuse('Math.random');
    globalThis.setTimeout = refuse('setTimeout');
    globalThis.setInterval = refuse('setInterval');
    globalThis.fetch = refuse('fetch');
    for (const path of modules) {
      try { await import(`${pathToFileURL(path).href}?global-scope-check`); }
      catch (error) { failures.push(`${path.slice(root.length + 1)}: ${error.message}`); }
    }
  } finally {
    crypto.randomUUID = real.randomUUID; crypto.getRandomValues = real.getRandomValues; Math.random = real.random;
    globalThis.setTimeout = real.setTimeout; globalThis.setInterval = real.setInterval; globalThis.fetch = real.fetch;
  }
  assert.deepEqual(failures, []);
});
