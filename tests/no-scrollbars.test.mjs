import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const HIDE_ALL = /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{\s*scrollbar-width:\s*none/;
const HIDE_WEBKIT = /\*::-webkit-scrollbar\s*\{[^}]*display:\s*none/;

test('every stylesheet of the widget and its pages hides scrollbars for all elements', () => {
  for (const path of ['style.css', 'qa/qa.css', 'blast/settings.html', 'knowledge/knowledge.css']) {
    const text = read(path);
    assert.match(text, HIDE_ALL, `${path}: standard property`);
    assert.match(text, HIDE_WEBKIT, `${path}: webkit`);
  }
  assert.match(read('blast/index.html'), /::-webkit-scrollbar\s*\{\s*display:\s*none/);
});

test('no rule gives any element a visible scrollbar again (a class rule beats the * rule)', () => {
  for (const path of ['style.css', 'qa/qa.css', 'blast/settings.html', 'blast/index.html', 'knowledge/knowledge.css', 'bonus-admin.css']) {
    const text = read(path);
    assert.doesNotMatch(text, /scrollbar-width:\s*(thin|auto)/, `${path}: scrollbar-width`);
    assert.doesNotMatch(text, /::-webkit-scrollbar\s*\{\s*width:\s*[1-9]/, `${path}: a sized webkit scrollbar`);
    assert.doesNotMatch(text, /::-webkit-scrollbar-thumb\s*\{/, `${path}: a styled scrollbar thumb`);
  }
});
