'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : !!force;
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor(document, classes = []) {
    this.ownerDocument = document;
    this.classList = new FakeClassList(classes);
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.isConnected = true;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, values = {}) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      ...values,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selected = true; }
}

function createDialogEnvironment() {
  const document = { activeElement: null };
  const elements = Object.fromEntries([
    'form', 'title', 'message', 'promptWrap', 'promptLabel', 'promptInput',
    'error', 'cancelButton', 'confirmButton', 'closeButton',
  ].map((name) => [name, new FakeElement(document)]));
  elements.promptWrap.classList.add('hidden');
  elements.error.classList.add('hidden');

  const selectors = {
    '#app-dialog-form': elements.form,
    '#app-dialog-title': elements.title,
    '#app-dialog-message': elements.message,
    '#app-dialog-prompt-wrap': elements.promptWrap,
    '#app-dialog-prompt-label': elements.promptLabel,
    '#app-dialog-input': elements.promptInput,
    '#app-dialog-error': elements.error,
    '#app-dialog-cancel': elements.cancelButton,
    '#app-dialog-confirm': elements.confirmButton,
    '#app-dialog-close': elements.closeButton,
  };
  const dialog = new FakeElement(document);
  dialog.open = false;
  dialog.querySelector = (selector) => selectors[selector];
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };

  const body = new FakeElement(document);
  document.body = body;
  document.querySelector = (selector) => selector === '#app-dialog' ? dialog : null;
  const trigger = new FakeElement(document);
  document.activeElement = trigger;

  const context = {
    document,
    window: {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => { callback(); return 1; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/ui-dialog.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'ui-dialog.js' });
  return { ...elements, body, dialog, trigger, AppDialog: context.window.AppDialog };
}

test('shared dialog safely ignores duplicate opens and restores focus', async () => {
  const env = createDialogEnvironment();
  const first = env.AppDialog.confirm({
    title: '刪除帳目',
    message: '確定刪除？',
    tone: 'danger',
  });

  assert.equal(env.dialog.open, true);
  assert.equal(env.body.dataset.dialogLocks, '1');
  assert.equal(env.body.classList.contains('app-dialog-open'), true);
  assert.equal(env.cancelButton.ownerDocument.activeElement, env.cancelButton);
  assert.equal(await env.AppDialog.confirm({ title: '重複操作' }), false);

  env.dialog.dispatch('cancel');
  assert.equal(await first, false);
  assert.equal(env.dialog.open, false);
  assert.equal(env.body.dataset.dialogLocks, '0');
  assert.equal(env.body.classList.contains('app-dialog-open'), false);
  assert.equal(env.trigger.ownerDocument.activeElement, env.trigger);
});

test('prompt keeps required validation inside the shared dialog', async () => {
  const env = createDialogEnvironment();
  const result = env.AppDialog.prompt({ title: '新增類別', label: '類別名稱' });

  env.form.dispatch('submit');
  assert.equal(env.dialog.open, true);
  assert.equal(env.promptInput.attributes.get('aria-invalid'), 'true');
  assert.equal(env.error.classList.contains('hidden'), false);

  env.promptInput.value = '咖啡';
  env.promptInput.dispatch('input');
  assert.equal(env.promptInput.attributes.has('aria-invalid'), false);
  env.form.dispatch('submit');
  assert.equal(await result, '咖啡');
  assert.equal(env.dialog.open, false);
});
