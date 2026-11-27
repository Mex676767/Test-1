import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const match = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n|function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `found ${name} in app.js`);
  return match[0];
};
const { isRiskInformed, riskInformedUser } = vm.runInContext(
  `${['riskInformedUser', 'isRiskInformed'].map(grab).join('\n')}\n({ isRiskInformed, riskInformedUser })`,
  vm.createContext({ String }),
);

test('a chat starts as not informed', () => {
  assert.equal(isRiskInformed({ username: 'Player1' }), false);
  assert.equal(isRiskInformed(undefined), false);
});

test('marking informed sticks to the player, ignoring case and spaces', () => {
  const s = { username: ' Player1 ' };
  s.riskInformedFor = riskInformedUser(s);
  assert.equal(isRiskInformed(s), true);
  s.username = 'player1';
  assert.equal(isRiskInformed(s), true);
});

test('a different player in the same chat is not shown as informed', () => {
  const s = { username: 'player1' };
  s.riskInformedFor = riskInformedUser(s);
  s.username = 'player2';
  assert.equal(isRiskInformed(s), false);
});

test('clearing the mark makes it not informed again', () => {
  const s = { username: 'player1', riskInformedFor: '' };
  assert.equal(isRiskInformed(s), false);
});

test('the mark is app-only: never part of what is saved to Lark or compared for changes', () => {
  const content = app.match(/const CASE_CONTENT_KEYS = \[[\s\S]*?\n\];/)[0];
  const keys = app.match(/const CASE_KEYS = \[[\s\S]*?\n\];/)[0];
  assert.doesNotMatch(content, /riskInformed/);
  assert.doesNotMatch(keys, /riskInformed/);
  for (const file of ['lark-record.js', 'lark-log.js']) {
    try { assert.doesNotMatch(readFileSync(new URL(`../functions/${file}`, import.meta.url), 'utf8'), /riskInformed/); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
});

test('the Risk Player card renders an Informed toggle that flips on click', () => {
  assert.match(app, /data-action="toggleRiskInformed"/);
  assert.match(app, /if \(btn\.dataset\.action === "toggleRiskInformed"\)/);
  assert.match(app, /"reactivateGracePeriod", "toggleRiskInformed"\]\.includes/);
});
