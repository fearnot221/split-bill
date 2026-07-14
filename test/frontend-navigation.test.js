'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('bookkeeping is the standalone default tab', () => {
  const navTabs = [...html.matchAll(/class="tab-btn(?: active)?" data-tab="([^"]+)"/g)]
    .map((match) => match[1]);
  const panelTabs = [...html.matchAll(/<section id="tab-([^"]+)" class="tab-panel/g)]
    .map((match) => match[1]);

  assert.deepEqual(navTabs, ['entry', 'expenses', 'settle', 'stats']);
  assert.deepEqual(panelTabs, navTabs);
  assert.match(html, /class="tab-btn active" data-tab="entry" aria-current="page"/);
  assert.match(html, /id="tab-entry" class="tab-panel entry-panel">/);
  assert.match(html, /id="tab-expenses" class="tab-panel hidden">/);
  assert.match(html, /id="ledger-summary" class="stat-strip hidden">/);
  assert.match(html, /id="btn-add-expense" class="fab hidden"/);
});

test('entry and detail controls live in separate tab panels', () => {
  const entryStart = html.indexOf('<section id="tab-entry"');
  const expensesStart = html.indexOf('<section id="tab-expenses"');
  const settleStart = html.indexOf('<section id="tab-settle"');
  const entryPanel = html.slice(entryStart, expensesStart);
  const expensesPanel = html.slice(expensesStart, settleStart);

  assert.match(entryPanel, /class="smart-entry"/);
  assert.doesNotMatch(entryPanel, /id="filter-text"|id="expense-list"/);
  assert.match(expensesPanel, /id="filter-text"/);
  assert.match(expensesPanel, /id="expense-list"/);
  assert.doesNotMatch(expensesPanel, /class="smart-entry"/);
});

test('static app ID lookups still resolve after splitting the panels', () => {
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const appIds = new Set(
    [...app.matchAll(/\$\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)/g)].map((match) => match[1])
  );
  const missing = [...appIds].filter((id) => !htmlIds.has(id));

  assert.deepEqual(missing, []);
});
