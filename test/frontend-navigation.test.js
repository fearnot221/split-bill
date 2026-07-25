'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const adminApp = fs.readFileSync(path.join(root, 'public/admin.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

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

test('shared dialogs replace native confirm and prompt calls', () => {
  const nativeDialogCall = /(^|[^.\w])(confirm|prompt)\s*\(/m;
  assert.doesNotMatch(app, nativeDialogCall);
  assert.doesNotMatch(adminApp, nativeDialogCall);

  for (const page of [html, adminHtml]) {
    assert.match(page, /<dialog id="app-dialog" class="app-dialog app-dialog--compact"/);
    assert.match(page, /id="app-dialog-title"/);
    assert.match(page, /id="app-dialog-message"/);
    assert.match(page, /id="app-dialog-confirm"/);
    assert.match(page, /id="app-dialog-form" class="app-dialog__form" novalidate/);
    assert.match(page, /src="ui-dialog\.js\?v=2"/);
  }
});

test('expense sheet, receipt viewer, and native selects use the current UI primitives', () => {
  assert.match(html, /<dialog id="modal-expense" class="app-dialog app-dialog--sheet"/);
  assert.match(html, /<dialog id="receipt-lightbox" class="app-dialog app-dialog--viewer receipt-lightbox"/);
  const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(selects.length, 2);
  assert.ok(selects.every((select) => /class="app-select"/.test(select)));
  assert.match(html, /<select id="exp-payer" class="app-select">/);
  assert.match(html, /<select id="exp-transfer-to" class="app-select"[^>]*>/);
  assert.match(html, /id="exp-categories"[^>]+role="group"[^>]+aria-labelledby="label-cats"/);
  assert.match(html, /id="ai-review-status"[^>]+role="status"/);
  assert.match(html, /id="modal-toast"[^>]+role="status"/);
});

test('managed forms and tooltips avoid browser-native mobile popovers', () => {
  for (const page of [html, adminHtml]) {
    const allForms = [...page.matchAll(/<form\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((form) => !/id="app-dialog-form"/.test(form));
    const managedForms = [...page.matchAll(/<form\b[^>]*data-app-form[^>]*>/g)]
      .map((match) => match[0]);
    assert.equal(managedForms.length, allForms.length);
    assert.ok(managedForms.every((form) => /\bnovalidate\b/.test(form)));
    assert.match(page, /src="ui-form\.js\?v=2"/);
    assert.doesNotMatch(page, /\stitle="/);
  }
  assert.match(app, /AppForm\.validate\(ev\.currentTarget/);
  assert.match(adminApp, /AppForm\.validate\(form/);
  assert.doesNotMatch(app.replace(/document\.title\s*=/g, ''), /\stitle="|\.title\s*=/);
  assert.doesNotMatch(adminApp, /\stitle="|\.title\s*=/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /\.modal-card \{ border-radius: 8px; max-height: 100%; \}/);
  assert.match(styles, /\.pill-btn\[aria-disabled="true"\]/);
  assert.match(styles, /select\.app-select\[aria-invalid="true"\]:focus-visible/);
  assert.match(styles, /\.stat-value\[data-tooltip\]:focus::after/);
});

test('static admin ID lookups resolve in the admin document', () => {
  const htmlIds = new Set([...adminHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const appIds = new Set(
    [...adminApp.matchAll(/\$\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)/g)].map((match) => match[1])
  );
  const missing = [...appIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('public surfaces no longer expose the legacy public-fund role', () => {
  const publicSurfaces = new Map([
    ['public/index.html', html],
    ['public/app.js', app],
    ['public/admin.html', adminHtml],
    ['public/admin.js', adminApp],
    ['README.md', readme],
  ]);

  for (const [filename, source] of publicSurfaces) {
    assert.doesNotMatch(
      source,
      /\bis_fund\b|\bpublic_fund\b|\bseedFund\b|公帳/,
      `${filename} still exposes the removed public-fund role`
    );
  }
});

test('transfer entry requires another member and blocks unsupported AI drafts', () => {
  const guardFunctions = app.match(
    /function hasTransferRecipient\(members = \[\]\) \{[\s\S]*?\n\}\n\nfunction aiDraftNeedsTransferMember\(draft, members = \[\]\) \{[\s\S]*?\n\}/
  );
  assert.ok(guardFunctions, 'transfer availability guards are missing');
  const sandbox = {};
  vm.runInNewContext(`${guardFunctions[0]}; results = {
    empty: hasTransferRecipient([]),
    twoMembers: hasTransferRecipient([{}, {}]),
    blockedTransfer: aiDraftNeedsTransferMember({ kind: 'transfer' }, [{}]),
    allowedTransfer: aiDraftNeedsTransferMember({ kind: 'transfer' }, [{}, {}]),
    normalExpense: aiDraftNeedsTransferMember({ kind: 'expense' }, [{}]),
  };`, sandbox);
  assert.equal(sandbox.results.empty, false);
  assert.equal(sandbox.results.twoMembers, true);
  assert.equal(sandbox.results.blockedTransfer, true);
  assert.equal(sandbox.results.allowedTransfer, false);
  assert.equal(sandbox.results.normalExpense, false);

  assert.match(app, /const transferAvailable = hasTransferRecipient\(members\);/);
  assert.match(app, /\$\('#kind-transfer'\)\.classList\.toggle\('hidden', !transferAvailable\);/);
  assert.match(app, /\$\('#kind-transfer'\)\.disabled = !transferAvailable;/);
  assert.match(
    app,
    /if \(aiDraftNeedsTransferMember\(draft, state\.data\?\.members\)\) \{[\s\S]*?showAddMember: true,[\s\S]*?return false;[\s\S]*?\}\n\n  openExpenseModal/
  );
  assert.match(app, /restoreInputFocus = !applyAiDraft\(result\);/);
  assert.match(
    app,
    /if \(transferAvailable && !\$\('#smart-add-member'\)\.classList\.contains\('hidden'\)\) \{\s*setSmartFeedback\(''\);\s*\}/
  );
  assert.match(html, /id="smart-add-member" class="pill-btn hidden" href="\/admin">新增成員<\/a>/);
  assert.match(styles, /\.smart-feedback-row \.pill-btn \{[\s\S]*?min-height: 44px;/);
});
