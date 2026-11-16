import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = name => source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
function harness({ preview = false, fail = false, pending } = {}) {
  const state = { c1: { username: '115257', brand: 'JOM', matchedRow: { pnlRecordId: 'recPlayer123', customerName: 'Mr. Wong' } } };
  const requests = [];
  const context = vm.createContext({ state, previewMode: preview, COPY_ICON_SVG: '',
    chatListEl: { querySelector: () => ({ innerHTML: '' }) }, saveState() {}, setStatus() {},
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (pending) await pending;
      return { ok: !fail, json: async () => fail ? { ok: false, error: 'Write refused' } : { ok: true, customerName: 'Mr. Tan' } };
    }
  });
  const api = vm.runInContext(['const playerNameEdits = new Map();', ...['escapeHtml', 'playerNameEditor', 'refreshPlayerName', 'savePlayerName', 'renderPlayerInfo'].map(fn), '({ playerNameEdits, playerNameEditor, savePlayerName, renderPlayerInfo })'].join('\n'), context);
  const edit = { row: state.c1.matchedRow, username: '115257', brand: 'JOM', original: 'Mr. Wong', draft: 'Mr. Tan', busy: false, error: '' };
  api.playerNameEdits.set('c1', edit);
  return { ...api, state, requests, edit };
}
test('saving updates the displayed name only after the server confirms it', async () => {
  let release;
  const h = harness({ pending: new Promise(resolve => { release = resolve; }) });
  const saving = h.savePlayerName('c1');
  assert.equal(h.state.c1.matchedRow.customerName, 'Mr. Wong');
  assert.match(h.renderPlayerInfo('c1'), /Saving…/);
  await h.savePlayerName('c1');
  assert.equal(h.requests.length, 1, 'double-save is ignored');
  release(); await saving;
  assert.equal(h.state.c1.matchedRow.customerName, 'Mr. Tan');
  assert.equal(h.requests[0].body.expectedName, 'Mr. Wong');
  assert.equal(h.playerNameEditor('c1'), null);
});
test('failed saves keep the original name and editable draft', async () => {
  const h = harness({ fail: true });
  await h.savePlayerName('c1');
  assert.equal(h.state.c1.matchedRow.customerName, 'Mr. Wong');
  assert.equal(h.edit.draft, 'Mr. Tan');
  assert.match(h.renderPlayerInfo('c1'), /Write refused/);
  assert.equal(h.edit.busy, false);
});
test('preview changes stay local, and input is escaped', async () => {
  const h = harness({ preview: true });
  h.edit.draft = '<img src=x onerror=alert(1)>';
  assert.match(h.renderPlayerInfo('c1'), /&lt;img/);
  assert.match(h.renderPlayerInfo('c1'), /Preview only/);
  await h.savePlayerName('c1');
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.c1.matchedRow.customerName, h.edit.draft);
});
test('switching player during a save cannot rename the new player', async () => {
  let release;
  const h = harness({ pending: new Promise(resolve => { release = resolve; }) });
  const saving = h.savePlayerName('c1');
  h.state.c1 = { username: 'other', brand: 'JOM', matchedRow: { pnlRecordId: 'recOther123', customerName: 'Other Player' } };
  release(); await saving;
  assert.equal(h.state.c1.matchedRow.customerName, 'Other Player');
});
test('blank names and changed identities do not send updates', async () => {
  const h = harness();
  h.edit.draft = ' ';
  await h.savePlayerName('c1');
  assert.match(h.edit.error, /Enter a name/);
  h.edit.draft = 'New name'; h.state.c1.brand = 'LPK';
  await h.savePlayerName('c1');
  assert.equal(h.requests.length, 0);
});
