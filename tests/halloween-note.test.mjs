import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = app.match(/async function addHalloweenActionNote\(chatId, claim\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(source, 'found addHalloweenActionNote in app.js');

function run({ claim, answer, blocker = '' }) {
  const calls = { posted: [], status: [], painted: 0 };
  const ui = { notes: ['old'] };
  const context = vm.createContext({
    state: { A: { username: 'alice', brand: 'EZ', halloweenDeposit: '350' } },
    consoleNoteBlocker: () => blocker,
    postConsoleNote: async (_s, extra) => { calls.posted.push(extra); return answer; },
    noteUi: () => ui,
    paintNoteSection: () => { calls.painted++; },
    setStatus: (text, kind) => calls.status.push({ text, kind }),
  });
  vm.runInContext(source, context);
  return context.addHalloweenActionNote('A', claim).then(() => ({ calls, ui }));
}

test('RM300+ Day 1 claim writes an Action log note that says Day 2 and Day 3 are open', async () => {
  const { calls, ui } = await run({ claim: { choice: 'TRICK', deposit: 350, amount: 120, track: 'RM300+' }, answer: { ok: true, saved: true } });
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0].type, 'action', 'goes to the Action log, not the Relationship notes');
  assert.equal(calls.posted[0].note, 'Halloween Day 1: deposited RM350 (RM300 or more), eligible for Day 2 and Day 3.');
  assert.equal(ui.notes, null, 'the shown note list is refreshed');
  assert.deepEqual(calls.status.map((item) => item.kind), ['success']);
});

test('a deposit below RM300 says the player is not eligible for Day 2 and Day 3', async () => {
  const { calls } = await run({ claim: { choice: 'TREAT', deposit: 200, amount: 30, track: 'Below RM300' }, answer: { ok: true, saved: true } });
  assert.equal(calls.posted[0].note, 'Halloween Day 1: deposited RM200 (below RM300), not eligible for Day 2 and Day 3.');
});

test('the deposit typed in the card is used if the server does not return one', async () => {
  const { calls } = await run({ claim: { choice: 'TRICK', amount: 120, track: 'RM300+' }, answer: { ok: true, saved: true } });
  assert.match(calls.posted[0].note, /deposited RM350 /);
});

test('a note that cannot be saved only warns the agent; nothing is undone', async () => {
  const { calls } = await run({ claim: { choice: 'TRICK', deposit: 350, amount: 120, track: 'RM300+' }, answer: { ok: false, error: 'Connect LiveChat first.' } });
  assert.equal(calls.status.length, 1);
  assert.equal(calls.status[0].kind, 'error');
  assert.match(calls.status[0].text, /Day 1 is claimed, but the Action log note was not saved: Connect LiveChat first\./);
});

test('nothing is posted when notes are not possible for this player', async () => {
  const { calls } = await run({ claim: { choice: 'TRICK', deposit: 350, amount: 120, track: 'RM300+' }, answer: { ok: true, saved: true }, blocker: 'Unknown player' });
  assert.equal(calls.posted.length, 0);
  assert.equal(calls.status.length, 0);
});
