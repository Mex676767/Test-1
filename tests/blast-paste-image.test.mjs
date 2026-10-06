import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const popup = readFileSync(new URL('../blast/popup.js', import.meta.url), 'utf8');
const NL = String.fromCharCode(10);
const grab = (startMarker) => { const start = popup.indexOf(startMarker); return popup.slice(start, popup.indexOf(NL + '}', start) + 2); };
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

function harness({ running = false } = {}) {
  const logs = [], status = [];
  const listeners = {};
  const nodes = () => ({ style: {}, classList: { add() {}, remove() {} }, textContent: '', click() {} });
  const context = vm.createContext({
    File, Blob, Array, Date, String, running,
    bulkImgDataUrl: null, bulkImgFileName: null,
    imgFileInput: { value: 'x' }, imgFileName: nodes(), imgFileClear: nodes(), imgFileType: nodes(), imgPickBtn: nodes(), imgFileWrap: nodes(),
    document: { getElementById: () => nodes(), addEventListener: (name, fn) => { listeners[name] = fn; } },
    imgSubFile: { click() { context.switchedToFile = true; } }, switchedToFile: false,
    addLog: (m, t) => logs.push([m, t]), showBulkStatus: (m, t) => status.push([m, t]),
    FileReader: class { readAsDataURL(file) { file.arrayBuffer().then((b) => this.onload({ target: { result: 'data:' + file.type + ';base64,' + Buffer.from(b).toString('base64') } })); } },
  });
  vm.runInContext('const MAX_IMAGE_BYTES = 3 * 1024 * 1024;', context);
  vm.runInContext(grab('function loadImageFile(') + NL + grab('function imageFromClipboard('), context);
  const pasteBlock = popup.slice(popup.indexOf("document.addEventListener('paste'"));
  vm.runInContext(pasteBlock.slice(0, pasteBlock.indexOf(NL + '});') + 4), context);
  return { context, logs, status, paste: listeners.paste };
}

const clipboard = ({ text = '', files = [] } = {}) => ({
  getData: (type) => (type === 'text/plain' ? text : ''),
  items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('pasting an image fills the FILE tab with it, named by type, and stops the default paste', async () => {
  const h = harness();
  let prevented = false;
  h.paste({ clipboardData: clipboard({ files: [new File([PNG_BYTES], 'image.png', { type: 'image/png' })] }), preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.equal(h.context.switchedToFile, true, 'switched to FILE mode');
  assert.match(h.context.bulkImgFileName, /^pasted-image-\d+\.png$/);
  assert.match(h.context.bulkImgDataUrl, /^data:image\/png;base64,/);
  const jpeg = harness();
  jpeg.paste({ clipboardData: clipboard({ files: [new File([PNG_BYTES], 'image.png', { type: 'image/jpeg' })] }), preventDefault() {} });
  await settle();
  assert.match(jpeg.context.bulkImgFileName, /\.jpg$/);
});

test('text pastes (including spreadsheet cells that also carry an image preview) are left alone', async () => {
  const h = harness();
  let prevented = false;
  h.paste({ clipboardData: clipboard({ text: 'https://my.livechatinc.com/archives/X', files: [new File([PNG_BYTES], 'i.png', { type: 'image/png' })] }), preventDefault: () => { prevented = true; } });
  h.paste({ clipboardData: clipboard({}), preventDefault: () => { prevented = true; } });
  h.paste({ clipboardData: clipboard({ files: [new File(['x'], 'a.txt', { type: 'text/plain' })] }), preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(prevented, false);
  assert.equal(h.context.bulkImgDataUrl, null);
  assert.equal(h.context.switchedToFile, false);
});

test('a pasted image over 3 MB is refused with the same message as the picker; pasting while a run is active does nothing', async () => {
  const h = harness();
  h.paste({ clipboardData: clipboard({ files: [new File([Buffer.alloc(3 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })] }), preventDefault() {} });
  await settle();
  assert.equal(h.context.bulkImgDataUrl, null);
  assert.match(h.status[0][0], /too large/);
  const busy = harness({ running: true });
  busy.paste({ clipboardData: clipboard({ files: [new File([PNG_BYTES], 'a.png', { type: 'image/png' })] }), preventDefault() { throw new Error('must not intercept'); } });
  await settle();
  assert.equal(busy.context.bulkImgDataUrl, null);
});

test('the file picker uses the same loader, and the page tells agents they can paste', () => {
  assert.match(popup, /imgFileInput\.addEventListener\('change', \(e\) => loadImageFile\(e\.target\.files\[0\]\)\)/);
  assert.match(readFileSync(new URL('../blast/index.html', import.meta.url), 'utf8'), /paste an image with Ctrl\+V/);
});
