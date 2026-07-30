'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const datePicker = fs.readFileSync(path.join(root, 'public/ui-date-picker.js'), 'utf8');
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

test('light and dark themes follow the operating system without a manual preference', () => {
  for (const page of [html, adminHtml]) {
    assert.match(page, /<meta name="color-scheme" content="light dark">/);
    assert.match(page, /<meta name="theme-color" content="#f5f3ee" media="\(prefers-color-scheme: light\)">/);
    assert.match(page, /<meta name="theme-color" content="#191813" media="\(prefers-color-scheme: dark\)">/);
    assert.match(page, /href="style\.css\?v=41"/);
  }
  assert.match(styles, /:root \{[\s\S]*?color-scheme: light dark;/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\) \{[\s\S]*?--paper: #191813;/);
  assert.match(styles, /--select-arrow: url\([^\n]+stroke='%236f695f'/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\) \{[\s\S]*?--select-arrow: url\([^\n]+stroke='%23a19b8d'/);
  assert.match(styles, /html \{ background: var\(--paper\);/);
  assert.match(styles, /select \{\s*background-image: var\(--select-arrow\);/);
  assert.match(styles, /\.date-picker__day\.adjacent \{ color: var\(--sub\); \}/);
  assert.doesNotMatch(styles, /\.date-picker__day\.adjacent[^\n]+opacity:/);
  assert.match(styles, /#expense-list \.expense-del \{[^}]*opacity: \.8;/);
  assert.doesNotMatch(styles, /\.expense-note \{[^}]*opacity:/);
  assert.match(readme, /深淺色模式會自動跟隨系統設定/);
});

test('all date fields use one accessible custom calendar dialog', () => {
  assert.doesNotMatch(html, /type="date"/);
  const dateInputs = [...html.matchAll(/<input\b[^>]*\bid="(stats-from|stats-to|exp-date)"[^>]*>/g)];
  assert.equal(dateInputs.length, 3);
  assert.ok(dateInputs.every((match) => /type="hidden"/.test(match[0])));
  assert.ok(dateInputs.every((match) => /\bdata-date-picker(?:\s|>)/.test(match[0])));
  assert.match(dateInputs.find((match) => match[1] === 'exp-date')[0], /\brequired\b/);
  assert.doesNotMatch(dateInputs.find((match) => match[1] === 'stats-from')[0], /\brequired\b/);
  assert.doesNotMatch(dateInputs.find((match) => match[1] === 'stats-to')[0], /\brequired\b/);

  const triggers = [...html.matchAll(/<button\b[^>]*\bdata-date-picker-for="([^"]+)"[^>]*>/g)];
  assert.deepEqual(triggers.map((match) => match[1]).sort(), ['exp-date', 'stats-from', 'stats-to']);
  assert.ok(triggers.every((match) => /aria-haspopup="dialog"/.test(match[0])));
  assert.ok(triggers.every((match) => /aria-expanded="false"/.test(match[0])));
  assert.ok(triggers.every((match) => /aria-controls="date-picker-dialog"/.test(match[0])));
  assert.match(triggers.find((match) => match[1] === 'exp-date')[0], /aria-required="true"/);

  const expenseStart = html.indexOf('<dialog id="modal-expense"');
  const expenseEnd = html.indexOf('</dialog>', expenseStart);
  const pickerStart = html.indexOf('<dialog id="date-picker-dialog"');
  const pickerEnd = html.indexOf('</dialog>', pickerStart);
  const receiptStart = html.indexOf('<dialog id="receipt-lightbox"');
  assert.ok(expenseEnd < pickerStart, 'date picker must be a sibling after the expense dialog');
  assert.ok(pickerEnd < receiptStart, 'date picker must not wrap the receipt dialog');
  assert.match(html, /id="date-picker-grid"[^>]+role="grid"[^>]+aria-labelledby="date-picker-month"/);
  assert.match(html, /id="date-picker-days"[^>]+role="rowgroup"/);
  assert.equal((html.match(/role="columnheader"/g) || []).length, 7);
  assert.match(html, /id="date-picker-month"[^>]+aria-live="polite"/);
  assert.match(html, /src="ui-date-picker\.js\?v=1"/);
  assert.ok(html.indexOf('ui-date-picker.js?v=1') < html.indexOf('app.js?v='));

  assert.match(datePicker, /Array\.from\(\{ length: 42 \}/);
  assert.match(datePicker, /keyboardTarget\(focusedIso, key, shiftKey\)/);
  assert.match(datePicker, /new Event\('input', \{ bubbles: true \}\)/);
  assert.match(datePicker, /new Event\('change', \{ bubbles: true \}\)/);
  assert.match(datePicker, /window\.AppDatePicker = \{/);
  assert.match(styles, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(styles, /grid-template-rows: repeat\(6, 44px\)/);
  assert.match(styles, /\.date-picker-surface \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.date-picker-trigger\[aria-invalid="true"\]/);
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]+\.date-picker-surface/);
});

test('date picker stays reachable in short viewports and keeps 44px targets at 320px', () => {
  const surfaceRule = styles.match(/\.date-picker-surface \{([^}]*)\}/)?.[1] || '';
  assert.match(surfaceRule, /max-height: min\(92%, 560px\);/);
  assert.match(surfaceRule, /overflow-y: auto;/);
  assert.match(surfaceRule, /overscroll-behavior: contain;/);
  assert.match(surfaceRule, /scroll-padding-block: 108px 72px;/);
  assert.match(styles, /\.date-picker__topbar \{[^}]*position: sticky;[^}]*top: 0;/);
  assert.match(styles, /\.date-picker__month-nav \{[^}]*position: sticky;[^}]*top: 48px;/);
  assert.match(styles, /\.date-picker__actions \{[^}]*position: sticky;[^}]*bottom: 0;/);
  assert.match(styles, /@media \(min-width: 768px\) and \(min-height: 600px\)/);
  assert.doesNotMatch(styles, /@media \(min-width: 768px\) \{/);

  const narrowSurfaceRule = styles.match(
    /@media \(max-width: 360px\)[\s\S]*?\.date-picker-surface \{([^}]*)\}/
  )?.[1] || '';
  const leftPadding = Number(/padding-left: max\((\d+)px,/.exec(narrowSurfaceRule)?.[1]);
  const rightPadding = Number(/padding-right: max\((\d+)px,/.exec(narrowSurfaceRule)?.[1]);
  const appSurfaceRule = styles.match(/\.app-dialog__surface \{([^}]*)\}/)?.[1] || '';
  const horizontalBorder = Number(/border: (\d+)px solid/.exec(appSurfaceRule)?.[1]) * 2;
  const dayWidthAt320 = (320 - leftPadding - rightPadding - horizontalBorder) / 7;

  assert.ok(Number.isFinite(dayWidthAt320));
  assert.ok(dayWidthAt320 >= 44, `320px date target is only ${dayWidthAt320}px wide`);
  assert.match(styles, /\.date-picker__day \{[^}]*min-height: 44px;/);
});

test('AI analysis keeps one permanent live status and an accessible cancel action', () => {
  assert.match(
    html,
    /id="smart-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/
  );
  const progressMarkup = html.match(/<div id="smart-progress"[^>]*>/)?.[0] || '';
  const feedbackMarkup = html.match(/<p id="smart-feedback"[^>]*>/)?.[0] || '';
  const smartStatusIndex = html.indexOf('id="smart-status"');
  const busyRegionIndex = html.indexOf('id="smart-input-wrap"');
  const hiddenFeedbackIndex = html.indexOf('class="smart-feedback-row"');
  assert.ok(smartStatusIndex >= 0 && smartStatusIndex < busyRegionIndex);
  assert.ok(smartStatusIndex < hiddenFeedbackIndex);
  assert.match(progressMarkup, /aria-hidden="true"/);
  assert.doesNotMatch(progressMarkup, /role="status"|aria-live=/);
  assert.doesNotMatch(feedbackMarkup, /role="status"|aria-live=/);
  assert.match(app, /\$\('#smart-status'\)\.textContent = `\$\{title\}。\$\{detail\}`;/);
  assert.match(app, /\$\('#smart-status'\)\.textContent = message;/);

  const analyzingFunction = app.match(
    /function setSmartAnalyzing\(analyzing\) \{[\s\S]*?\n\}\n\nfunction cancelSmartAnalysis/
  )?.[0] || '';
  const clearFeedbackIndex = analyzingFunction.indexOf("setSmartFeedback('');");
  const initialProgressIndex = analyzingFunction.indexOf('updateSmartProgress();');
  assert.ok(clearFeedbackIndex >= 0);
  assert.ok(initialProgressIndex >= 0);
  assert.ok(clearFeedbackIndex < initialProgressIndex);
  assert.match(
    analyzingFunction,
    /setTimeout\(\(\) => updateSmartProgress\(1\), 4500\)[\s\S]*?setTimeout\(\(\) => updateSmartProgress\(2\), 12000\)/
  );
  assert.match(analyzingFunction, /cancelButton\.focus\(\{ preventScroll: true \}\);/);
  assert.match(analyzingFunction, /cancelButton\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\);/);
  assert.doesNotMatch(analyzingFunction, /moveFocusToCancel/);
  assert.match(
    analyzingFunction,
    /if \(analyzing && smartSpeechRecognition\) \{\s*try \{ smartSpeechRecognition\.abort\(\); \} catch \{\}/
  );
  assert.match(
    app,
    /recognition\.onstart = \(\) => \{\s*if \(smartAnalyzing\) \{\s*recognition\.abort\(\);\s*return;/
  );
  assert.match(
    app,
    /recognition\.onresult = \(event\) => \{\s*if \(smartAnalyzing\) \{\s*recognition\.abort\(\);\s*return;/
  );
  assert.match(
    app,
    /if \(ev\.key === 'Escape' && smartAnalyzing && !modal\.open\) \{\s*ev\.preventDefault\(\);\s*cancelSmartAnalysis\(\);\s*return;/
  );
  assert.doesNotMatch(app, /setSmartFeedback\(`\$\{updateSmartProgress\(/);
  assert.match(app, /\.smart-entry'\)\.classList\.toggle\('is-analyzing', analyzing\)/);
  assert.match(app, /document\.body\.classList\.toggle\('smart-analysis-active', analyzing\)/);
  assert.match(
    styles,
    /\.smart-entry\.is-analyzing #smart-receipt,[\s\S]*?\.smart-entry\.is-analyzing \.smart-privacy \{ display: none; \}/
  );
  assert.match(
    styles,
    /\.smart-entry\.is-analyzing \.smart-actions > :not\(#btn-smart-analyze\) \{ display: none; \}/
  );
  assert.match(styles, /body\.smart-analysis-active \.tab-bar,/);
  assert.match(html, /src="app\.js\?v=64"/);
});

test('optional smart participants stay collapsed and summarize explicit selections', () => {
  assert.match(
    html,
    /id="btn-smart-participants-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="smart-participants-panel"/
  );
  assert.match(
    html,
    /id="smart-participants-panel" class="smart-participants-panel hidden" aria-hidden="true"/
  );
  assert.match(html, /id="smart-participants-summary">依分帳文字判斷<\/span>/);
  assert.match(app, /let smartParticipantsOpen = false;/);
  assert.match(
    app,
    /panel\.classList\.toggle\('hidden', !smartParticipantsOpen\);[\s\S]*?panel\.setAttribute\('aria-hidden', String\(!smartParticipantsOpen\)\);/
  );
  assert.match(
    app,
    /\$\('#btn-smart-participants-toggle'\)\.addEventListener\('click',[\s\S]*?smartParticipantsOpen = !smartParticipantsOpen;[\s\S]*?renderSmartParticipants\(\);/
  );
  assert.match(styles, /\.smart-participants-toggle \{[^}]*min-height: 48px;/);
  assert.match(styles, /#smart-participants-summary \{[^}]*text-overflow: ellipsis;/);
  assert.match(readme, /選填的分帳對象預設收合/);

  const summaryFunction = app.match(
    /function smartParticipantSelectionSummary\(people = \[\], selectedIds = new Set\(\)\) \{[\s\S]*?\n\}/
  );
  assert.ok(summaryFunction);
  const sandbox = {};
  vm.runInNewContext(`${summaryFunction[0]}; results = {
    none: smartParticipantSelectionSummary([{ id: 'a', name: '小明' }], new Set()),
    two: smartParticipantSelectionSummary([
      { id: 'a', name: '小明' }, { id: 'b', name: '小美' }
    ], new Set(['a', 'b'])),
    many: smartParticipantSelectionSummary([
      { id: 'a', name: '小明' }, { id: 'b', name: '小美' }, { id: 'c', name: '阿華' }
    ], new Set(['a', 'b', 'c'])),
  };`, sandbox);
  assert.equal(sandbox.results.none, '依分帳文字判斷');
  assert.equal(sandbox.results.two, '小明、小美');
  assert.equal(sandbox.results.many, '已選 3 位');
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

test('public surfaces model the wallet separately from real members', () => {
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
      /\bis_fund\b|\bpublic_fund\b|\bseedFund\b/,
      `${filename} still depends on the legacy public-fund member role`
    );
  }
  assert.match(html, /id="wallet-balance-card"/);
  assert.match(html, /id="wallet-balance-list"/);
  assert.match(adminHtml, /id="admin-wallet"/);
  assert.match(app, /function ledgerWallet\(\)/);
  assert.match(app, /function accountPayload\(account\) \{[\s\S]*?return normalized;\n\}/);
  assert.match(app, /const splitMembers = members;/);
  assert.match(app, /const \{ members \} = state\.data;/);
  assert.match(adminApp, /function renderWallet\(\)/);
  assert.match(adminApp, /overview\.members\.map/);
});

test('the wallet stays separate while shared wallet expenses may remain unallocated', () => {
  const guardFunctions = app.match(
    /function hasTransferRecipient\(members = \[\], wallet = null\) \{[\s\S]*?\n\}\n\nfunction aiDraftNeedsTransferMember\(draft, members = \[\], wallet = null\) \{[\s\S]*?\n\}/
  );
  assert.ok(guardFunctions, 'transfer availability guards are missing');
  const sandbox = {};
  vm.runInNewContext(`${guardFunctions[0]}; results = {
    empty: hasTransferRecipient([]),
    oneMember: hasTransferRecipient([{}]),
    oneMemberAndWallet: hasTransferRecipient([{}], {}),
    twoMembers: hasTransferRecipient([{}, {}]),
    blockedTransfer: aiDraftNeedsTransferMember({ kind: 'transfer' }, [{}]),
    walletTransfer: aiDraftNeedsTransferMember({ kind: 'transfer' }, [{}], {}),
    allowedTransfer: aiDraftNeedsTransferMember({ kind: 'transfer' }, [{}, {}]),
    normalExpense: aiDraftNeedsTransferMember({ kind: 'expense' }, [{}]),
  };`, sandbox);
  assert.equal(sandbox.results.empty, false);
  assert.equal(sandbox.results.oneMember, false);
  assert.equal(sandbox.results.oneMemberAndWallet, true);
  assert.equal(sandbox.results.twoMembers, true);
  assert.equal(sandbox.results.blockedTransfer, true);
  assert.equal(sandbox.results.walletTransfer, false);
  assert.equal(sandbox.results.allowedTransfer, false);
  assert.equal(sandbox.results.normalExpense, false);

  assert.match(app, /const transferAvailable = hasTransferRecipient\(members, wallet\);/);
  assert.match(app, /\$\('#kind-transfer'\)\.classList\.toggle\('hidden', !transferAvailable\);/);
  assert.match(app, /\$\('#kind-transfer'\)\.disabled = !transferAvailable;/);
  assert.match(
    app,
    /if \(aiDraftNeedsTransferMember\(draft, state\.data\?\.members, ledgerWallet\(\)\)\) \{[\s\S]*?showAddMember: true,[\s\S]*?return false;[\s\S]*?\}\n\n  openExpenseModal/
  );
  assert.match(app, /restoreInputFocus = !applyAiDraft\(result\);/);
  assert.match(
    app,
    /if \(transferAvailable && !\$\('#smart-add-member'\)\.classList\.contains\('hidden'\)\) \{\s*setSmartFeedback\(''\);\s*\}/
  );
  assert.match(html, /id="smart-add-member" class="pill-btn hidden" href="\/admin">新增成員<\/a>/);
  assert.match(styles, /\.smart-feedback-row \.pill-btn \{[\s\S]*?min-height: 44px;/);
  assert.match(app, /<optgroup label="帳本帳戶"><option[^>]*>帳本錢包<\/option>/);
  assert.match(app, /const disallowNone = expenseKind === 'income' && selectedSourceAccount\(\)\?\.type === 'wallet';/);
  assert.match(
    app,
    /if \(mode === 'none' && expenseKind === 'income'[\s\S]*?selectedSourceAccount\(\)\?\.type === 'wallet'\) mode = 'equal';/
  );
  assert.match(app, /splits = source\.type === 'wallet' \? \[\] : \[\{ memberId: source\.id, amount \}\];/);
  assert.match(app, /source\?\.type === 'wallet' && expense\.splits\.length === 0/);
  assert.match(app, /這筆會列為共同支出，不會計入任何成員的結餘/);
  assert.match(app, /const sharedBalance = Number\(wallet\.sharedBalance\) \|\| 0;/);
  assert.doesNotMatch(app, /帳本錢包付款必須分攤給實際成員/);
});

test('unresolved AI accounts stay blank until the user explicitly selects them', () => {
  const setOptionsSource = app.match(
    /function setAccountOptions\(select, optionsHtml,[\s\S]*?\n\}/
  );
  const renderTargetsSource = app.match(
    /(function renderTransferTargets\(selected,[\s\S]*?\n\})\n\n\$\('#exp-payer'/
  );
  assert.ok(setOptionsSource, 'account select helper is missing');
  assert.ok(renderTargetsSource, 'transfer target renderer is missing');

  function fakeSelect() {
    let markup = '';
    return {
      dataset: {},
      options: [],
      value: '',
      get innerHTML() { return markup; },
      set innerHTML(value) {
        markup = value;
        this.options = [...value.matchAll(/<option\b([^>]*)>/g)].map((match) => ({
          value: match[1].match(/\bvalue="([^"]*)"/)?.[1] || '',
          selected: /\bselected\b/.test(match[1]),
        }));
        this.value = this.options.find((option) => option.selected)?.value
          ?? this.options[0]?.value
          ?? '';
      },
    };
  }

  const payer = fakeSelect();
  const target = fakeSelect();
  payer.value = 'member:a';
  const accounts = [
    { type: 'member', id: 'a' },
    { type: 'member', id: 'b' },
    { type: 'wallet', id: 'wallet' },
  ];
  const sandbox = {
    escapeHtml: (value) => String(value),
    accountKey: (account) => account ? `${account.type}:${account.id}` : '',
    accountOptionsHtml: ({ exclude = '' } = {}) => accounts
      .map((account) => `${account.type}:${account.id}`)
      .filter((key) => key !== exclude)
      .map((key) => `<option value="${key}">${key}</option>`)
      .join(''),
    $: (selector) => selector === '#exp-payer' ? payer : target,
    syncAiReviewSummary: () => {},
  };
  vm.runInNewContext(`${setOptionsSource[0]}\n${renderTargetsSource[1]}`, sandbox);

  sandbox.setAccountOptions(payer, sandbox.accountOptionsHtml(), {
    selected: '',
    placeholder: '請選擇款項來源',
  });
  assert.equal(payer.value, '', 'an unresolved AI source must replace the browser default');
  assert.match(payer.innerHTML, /<option value="" disabled selected>請選擇款項來源<\/option>/);
  sandbox.setAccountOptions(payer, sandbox.accountOptionsHtml(), {
    selected: 'member:a',
    placeholder: '請選擇款項來源',
  });

  sandbox.renderTransferTargets(undefined, { requireSelection: false });
  assert.equal(target.value, 'member:b', 'ordinary transfer keeps its existing default');

  sandbox.renderTransferTargets(null, { requireSelection: true });
  assert.equal(target.value, '', 'an unresolved AI target must replace the browser default');
  assert.equal(target.dataset.requireSelection, 'true');
  assert.match(target.innerHTML, /<option value="" disabled selected>請選擇轉入對象<\/option>/);

  payer.value = 'member:b';
  sandbox.renderTransferTargets();
  assert.equal(target.value, '', 'changing the source must not auto-select a target');

  target.value = 'wallet:wallet';
  sandbox.renderTransferTargets();
  assert.equal(target.value, 'wallet:wallet', 'an explicit valid target is preserved');
  payer.value = 'wallet:wallet';
  sandbox.renderTransferTargets();
  assert.equal(target.value, '', 'a target excluded by the new source returns to the placeholder');

  assert.match(
    app,
    /setAccountOptions\(\$\('#exp-payer'\), accountOptionsHtml\(\), \{[\s\S]*?placeholder: '請選擇款項來源'/
  );
  assert.match(app, /renderTransferTargets\(draft.target, \{ requireSelection: true \}\);/);
  assert.match(app, /payerSelect\.required = true;/);
  assert.match(app, /if \(!source\) return toast\('請選擇款項來源'\);/);
  assert.match(app, /if \(!target\) return toast\('請選擇轉入對象'\);/);
});
