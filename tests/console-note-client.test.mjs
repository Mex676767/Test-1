import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const line = (re) => app.match(re)[0];

const SOURCE = [
  line(/const CONSOLE_NOTE_MAX = \d+;/),
  line(/const noteUiByChat = new Map\(\);[^\n]*/),
  line(/const CONSOLE_NOTE_TYPES = \{[\s\S]*?\n\};/),
  ...['noteUi', 'consoleNoteBlocker', 'renderNoteSection', 'paintNoteSection', 'postConsoleNote', 'saveConsoleNote', 'loadConsoleNotes'].map(fn),
  '({ noteUi, consoleNoteBlocker, renderNoteSection, saveConsoleNote, loadConsoleNotes, noteUiByChat })',
].join('\n');

// The note box driven with fakes: no server, no LiveChat, no console.
function harness({ state = {}, tokens = { lc1: 'tok' }, account = 'lc1', reply, previewMode = true } = {}) {
  const posted = [];
  const slot = { innerHTML: '' };
  const context = vm.createContext({
    JSON, Promise, Map, String, Array, Boolean, AbortSignal,
    state, previewMode, currentLiveChatAccount: account,
    liveChatAgentTokens: () => tokens,
    escapeHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    chatListEl: { querySelector: () => slot },
    fetch: async (url, options) => {
      posted.push({ url, body: JSON.parse(options.body), signal: options.signal });
      const r = typeof reply === 'function' ? reply(posted.length) : reply;
      if (r instanceof Error) throw r;
      return { json: async () => r };
    },
  });
  const api = vm.runInContext(SOURCE, context);
  return { ...api, posted, slot, state };
}
const looked = (extra = {}) => ({ c1: { username: 'SweCin', brand: 'SPIN321', matchedRow: { tier: 'VVIP' }, isUnknown: false, ...extra } });

test('the note box appears only after a player has been looked up', () => {
  const h = harness({ state: { c1: { username: '', brand: 'SPIN321', matchedRow: null } } });
  assert.equal(h.renderNoteSection('c1'), '');
  assert.equal(h.renderNoteSection('nope'), '');
  const shown = harness({ state: looked() }).renderNoteSection('c1');
  assert.match(shown, /note-input/);
  assert.match(shown, /data-action="saveNote"/);
});

test('for now the box is in the admin preview only: the installed widget (not preview) shows nothing', () => {
  const installed = harness({ state: looked(), previewMode: false });
  assert.equal(installed.renderNoteSection('c1'), '');
  assert.match(harness({ state: looked(), previewMode: true }).renderNoteSection('c1'), /note-input/);
});

test('without a username or brand, or for an unknown player, the box is disabled and says why', () => {
  for (const extra of [{ username: '' }, { brand: '' }, { brand: '  ' }]) {
    const html = harness({ state: looked(extra) }).renderNoteSection('c1');
    assert.match(html, /<textarea[^>]* disabled/);
    assert.match(html, /username and brand/);
    assert.match(html, /data-action="saveNote"[^>]* disabled/);
  }
  const unknown = harness({ state: looked({ isUnknown: true }) }).renderNoteSection('c1');
  assert.match(unknown, /Unknown player/);
  assert.match(unknown, /<textarea[^>]* disabled/);
});

test('a note is sent with the LiveChat login and no agent name; Saved clears the draft', async () => {
  const h = harness({ state: looked(), reply: { ok: true, saved: true } });
  h.noteUi('c1').draft = '  Wants a call back  ';
  await h.saveConsoleNote('c1');
  assert.equal(h.posted.length, 1);
  const { url, body, signal } = h.posted[0];
  assert.equal(url, '/console-note');
  assert.deepEqual(body, { accountKey: 'lc1', agentToken: 'tok', username: 'SweCin', brand: 'SPIN321', note: 'Wants a call back', type: 'relationship' });
  assert.ok(!('agent' in body) && !('author' in body) && !('agentName' in body), 'the browser never names the author');
  assert.ok(signal, 'the browser gives up on a stuck server');
  assert.equal(h.noteUi('c1').draft, '');
  assert.equal(h.noteUi('c1').msg, 'Saved to the Relationship notes');
  assert.match(h.slot.innerHTML, /note-ok">Saved/);
});

test('an error keeps the typed note and shows the server\'s plain message', async () => {
  const h = harness({ state: looked(), reply: { ok: false, error: 'This player is not in the console, so the note was not saved.' } });
  h.noteUi('c1').draft = 'keep me';
  await h.saveConsoleNote('c1');
  assert.equal(h.noteUi('c1').draft, 'keep me');
  assert.match(h.slot.innerHTML, /note-error">This player is not in the console/);
  assert.equal(h.noteUi('c1').busy, false, 'the button works again');
});

test('a server that cannot be reached never throws and says the note may or may not be saved', async () => {
  const h = harness({ state: looked(), reply: new Error('network') });
  h.noteUi('c1').draft = 'hello';
  await h.saveConsoleNote('c1');
  assert.equal(h.noteUi('c1').draft, 'hello');
  assert.match(h.noteUi('c1').msg, /may or may not have been saved/);
});

test('nothing is sent for an empty note, a note over 2000 characters, a missing LiveChat login or a double click', async () => {
  const h = harness({ state: looked(), reply: { ok: true, saved: true } });
  h.noteUi('c1').draft = '   ';
  await h.saveConsoleNote('c1');
  assert.match(h.noteUi('c1').msg, /Write the note first/);
  h.noteUi('c1').draft = 'x'.repeat(2001);
  await h.saveConsoleNote('c1');
  assert.match(h.noteUi('c1').msg, /too long/);
  assert.equal(h.posted.length, 0);

  const noLogin = harness({ state: looked(), tokens: {}, reply: { ok: true, saved: true } });
  noLogin.noteUi('c1').draft = 'hi';
  await noLogin.saveConsoleNote('c1');
  assert.equal(noLogin.posted.length, 0);
  assert.match(noLogin.noteUi('c1').msg, /Connect LiveChat/);

  const slow = harness({ state: looked(), reply: { ok: true, saved: true } });
  slow.noteUi('c1').draft = 'once';
  const first = slow.saveConsoleNote('c1');
  const second = slow.saveConsoleNote('c1');
  await Promise.all([first, second]);
  assert.equal(slow.posted.length, 1, 'a second click while saving sends nothing');
});

test('existing console notes are shown escaped, and a failure only shows a message', async () => {
  const h = harness({ state: looked(), reply: { ok: true, notes: [{ note: '<b>hi</b>', by: 'raven (widget)', at: '2026-10-18 09:00' }] } });
  await h.loadConsoleNotes('c1');
  assert.equal(h.posted[0].body.list, true);
  assert.match(h.slot.innerHTML, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.ok(!h.slot.innerHTML.includes('<b>hi</b>'));
  const failing = harness({ state: looked(), reply: { ok: false, error: 'The console did not answer. Notes are not shown right now.' } });
  await failing.loadConsoleNotes('c1');
  assert.match(failing.slot.innerHTML, /Notes are not shown right now/);
});

test('the note box is wired in beside the case, and claiming, looking up and recording never wait on it', () => {
  const card = app.slice(app.indexOf('function renderExpandedCard'), app.indexOf('function renderAdminTicketWorkspace'));
  assert.ok(card.indexOf('player-info-slot') < card.indexOf('note-slot'), 'under the customer lookup');
  assert.ok(card.indexOf('note-slot') < card.indexOf('Available bonuses'), 'still inside the Customer section');
  assert.match(app, /btn\.dataset\.action === "saveNote" \|\| btn\.dataset\.action === "loadNotes"/);
  for (const name of ['runLookup', 'submitCase', 'recordCase']) {
    const m = app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (m) assert.ok(!/ConsoleNote|noteUi/.test(m[0]), `${name} does not touch notes`);
  }
  const claim = app.slice(app.indexOf('if (btn.dataset.action === "claim")'), app.indexOf('if (btn.dataset.action === "unclaim")'));
  assert.ok(!/ConsoleNote|noteUi/.test(claim), 'claiming does not touch notes');
});

test('the box offers Relationship note and Action log; the choice decides where the note is sent', async () => {
  const h = harness({ state: looked(), reply: { ok: true, saved: true } });
  const html = h.renderNoteSection('c1');
  assert.match(html, /data-type="relationship"[^>]*>Relationship note</);
  assert.match(html, /data-type="action"[^>]*>Action log</);
  assert.match(html, /note-type-btn active" data-action="noteType" data-type="relationship"/, 'relationship is the default');
  h.noteUi('c1').type = 'action';
  h.noteUi('c1').draft = 'Call back Friday';
  assert.match(h.renderNoteSection('c1'), /Add action/);
  await h.saveConsoleNote('c1');
  assert.deepEqual(h.posted[0].body.type, 'action');
  assert.equal(h.posted[0].body.note, 'Call back Friday');
  assert.equal(h.noteUi('c1').msg, 'Saved to the Action log');
});

test('the type buttons are part of the box, and listing follows the chosen type', async () => {
  const h = harness({ state: looked(), reply: { ok: true, notes: [{ note: 'x', by: 'raven (widget)', at: '' }] } });
  h.noteUi('c1').type = 'action';
  assert.match(h.renderNoteSection('c1'), /Show action log/);
  await h.loadConsoleNotes('c1');
  assert.deepEqual({ list: h.posted[0].body.list, type: h.posted[0].body.type }, { list: true, type: 'action' });
  assert.match(app, /btn\.dataset\.action === "noteType"/);
});
