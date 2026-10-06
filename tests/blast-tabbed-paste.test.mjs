import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const popup = readFileSync(new URL('../blast/popup.js', import.meta.url), 'utf8');
const NL = String.fromCharCode(10);
const grab = (marker) => { const start = popup.indexOf(marker); return popup.slice(start, popup.indexOf(NL + '}', start) + 2); };

function harness({ links = '', m1 = '', m2 = '', m3 = '', img = '' } = {}) {
  const status = [], clicks = [], inputs = [];
  const box = (value) => ({ value, dispatchEvent: (event) => { inputs.push(event.type); return true; } });
  const context = vm.createContext({
    Event, Array, Math, String,
    bulkLinks: box(links), bulkMsg1: box(m1), bulkMsg2: box(m2), bulkMsg3: box(m3), bulkImgUrl: box(img),
    bulkMessageModeInputs: [{ value: 'same', checked: true }, { value: 'rows', checked: false }],
    syncBulkMessageMode() {}, updateCounter() {}, showBulkStatus: (m, t) => status.push([m, t]),
    imgSubUrl: { click: () => clicks.push('url-tab') },
  });
  vm.runInContext("const TABBED_BOX_NAMES = ['Links', 'Message 1', 'Message 2', 'Message 3', 'Image URL'];" + NL
    + 'const tabbedBoxes = () => [bulkLinks, bulkMsg1, bulkMsg2, bulkMsg3, bulkImgUrl];' + NL
    + grab('function isSpreadsheetPaste(') + NL + grab('function parseTabbedPaste('), context);
  const values = () => ({ links: context.bulkLinks.value, m1: context.bulkMsg1.value, m2: context.bulkMsg2.value, m3: context.bulkMsg3.value, img: context.bulkImgUrl.value });
  return { context, status, clicks, inputs, values, parse: (text, at) => vm.runInContext(`parseTabbedPaste(${JSON.stringify(text)}${at === undefined ? '' : ', ' + at})`, context),
    isSheet: (text) => vm.runInContext(`isSpreadsheetPaste(${JSON.stringify(text)})`, context) };
}

test('pasting 4 columns into Links behaves exactly as before (and leaves the image box alone)', () => {
  const h = harness({ img: 'https://keep.me/a.png' });
  h.parse('L1\tA1\tB1\tC1\nL2\tA2\tB2\tC2');
  assert.deepEqual(h.values(), { links: 'L1\nL2', m1: 'A1\nA2', m2: 'B1\nB2', m3: 'C1\nC2', img: 'https://keep.me/a.png' });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.context.bulkMessageModeInputs[1].checked, true, 'switched to "different per row"');
});

test('a header row is skipped, including Message / Image headers', () => {
  const h = harness();
  h.parse('Links\tMessage 1\tMessage 2\tMessage 3\nL1\tA1\tB1\tC1');
  assert.deepEqual(h.values(), { links: 'L1', m1: 'A1', m2: 'B1', m3: 'C1', img: '' });
  const g = harness();
  g.parse('Message 1\tMessage 2\nA1\tB1', 1);
  assert.equal(g.values().m1, 'A1');
});

test('pasting into Message 1 fills Message 1, 2, 3 and leaves the links alone', () => {
  const h = harness({ links: 'U1\nU2', m1: 'old', m2: 'old', m3: 'old' });
  h.parse('A1\tB1\tC1\nA2\tB2\tC2', 1);
  assert.deepEqual(h.values(), { links: 'U1\nU2', m1: 'A1\nA2', m2: 'B1\nB2', m3: 'C1\nC2', img: '' });
  assert.match(h.status.at(-1)[0], /2 rows.*starting at Message 1/);
});

test('pasting into Message 2 fills Message 2 and 3 only', () => {
  const h = harness({ links: 'U1', m1: 'keep' });
  h.parse('B1\tC1', 2);
  assert.deepEqual(h.values(), { links: 'U1', m1: 'keep', m2: 'B1', m3: 'C1', img: '' });
});

test('a paste into Image URL puts column 1 there, switches to the URL tab, and notes ignored columns', () => {
  const h = harness({ links: 'U1\nU2', m1: 'A1\nA2' });
  h.parse('https://i/1.png\thttps://ignored\nhttps://i/2.png\thttps://ignored', 4);
  assert.equal(h.values().img, 'https://i/1.png\nhttps://i/2.png');
  assert.equal(h.values().links, 'U1\nU2');
  assert.equal(h.values().m1, 'A1\nA2');
  assert.deepEqual(h.clicks, ['url-tab']);
  assert.match(h.status.at(-1)[0], /1 extra column was ignored/);
});

test('five columns pasted into Links also fill the Image URL box', () => {
  const h = harness();
  h.parse('L1\tA1\tB1\tC1\thttps://i/1.png\nL2\tA2\t\t\thttps://i/2.png');
  assert.deepEqual(h.values(), { links: 'L1\nL2', m1: 'A1\nA2', m2: 'B1\n', m3: 'C1\n', img: 'https://i/1.png\nhttps://i/2.png' });
  assert.deepEqual(h.clicks, ['url-tab']);
});

test('only real spreadsheet pastes are intercepted: every non-empty line needs a tab', () => {
  const h = harness();
  assert.equal(h.isSheet('a\tb\nc\td\n'), true, 'Excel adds a trailing newline');
  assert.equal(h.isSheet('a\tb'), true, 'a single row');
  assert.equal(h.isSheet('Hello\nworld'), false, 'plain lines');
  assert.equal(h.isSheet('Dear player,\n\tindented line\nthanks'), false, 'a message that merely has an indented line');
  assert.equal(h.isSheet(''), false);
});

test('wiring: message boxes and the Image URL box intercept a spreadsheet paste; Links keeps its old path', () => {
  assert.match(popup, /if \(ta !== bulkLinks\) \{[\s\S]*?parseTabbedPaste\(text, i\)/);
  assert.match(popup, /bulkImgUrl\.addEventListener\('paste'[\s\S]*?parseTabbedPaste\(text, 4\)/);
  assert.match(popup, /if \(ta === bulkLinks && ta\.value\.includes\('\\t'\)\) \{\s*parseTabbedPaste\(ta\.value\);/);
});
