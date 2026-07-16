'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeControl {
  constructor(validity, label = '金額') {
    this.dataset = { validationLabel: label };
    this.validity = validity;
    this.willValidate = true;
    this.attributes = new Map();
    this.placeholder = '';
    this.min = '0.01';
    this.max = '999';
    this.minLength = 8;
    this.maxLength = 20;
  }

  getAttribute(name) { return this.attributes.get(name) || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus(options) { this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
}

class FakeForm {
  constructor(elements) {
    this.dataset = {};
    this.elements = elements;
    this.listeners = new Map();
    this.noValidate = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, target = this) {
    for (const listener of this.listeners.get(type) || []) listener({ target });
  }
}

function loadAppForm() {
  const context = {
    window: {
      matchMedia: () => ({ matches: false }),
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/ui-form.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'ui-form.js' });
  return context.window.AppForm;
}

test('shared form validation replaces native popovers and focuses the invalid field', () => {
  const AppForm = loadAppForm();
  const invalid = new FakeControl({ valid: false, valueMissing: true }, '金額');
  const valid = new FakeControl({ valid: true });
  const form = new FakeForm([invalid, valid]);
  const notices = [];

  AppForm.bind(form);
  assert.equal(form.noValidate, true);
  assert.equal(form.dataset.appValidationBound, 'true');
  assert.equal(AppForm.validate(form, { notify: (message) => notices.push(message) }), false);
  assert.deepEqual(notices, ['請填寫金額']);
  assert.equal(invalid.attributes.get('aria-invalid'), 'true');
  assert.equal(invalid.focusOptions.preventScroll, true);
  assert.equal(invalid.scrollOptions.block, 'center');
  assert.equal(invalid.scrollOptions.behavior, 'smooth');

  form.dispatch('input', invalid);
  assert.equal(invalid.attributes.has('aria-invalid'), false);
});

test('editing either member of a validation group clears its shared error state', () => {
  const AppForm = loadAppForm();
  const password = new FakeControl({ valid: true }, '新密碼');
  const confirmation = new FakeControl({ valid: true }, '確認新密碼');
  password.dataset.validationGroup = 'new-passwords';
  confirmation.dataset.validationGroup = 'new-passwords';
  const form = new FakeForm([password, confirmation]);

  AppForm.bind(form);
  confirmation.setAttribute('aria-invalid', 'true');
  form.dispatch('input', password);
  assert.equal(confirmation.attributes.has('aria-invalid'), false);
});

test('shared form validation clears stale state after correction and reset', () => {
  const AppForm = loadAppForm();
  const control = new FakeControl({ valid: false, tooShort: true }, '新密碼');
  const form = new FakeForm([control]);

  assert.equal(AppForm.validate(form), false);
  assert.equal(control.attributes.get('aria-invalid'), 'true');
  control.validity = { valid: true };
  assert.equal(AppForm.validate(form), true);
  assert.equal(control.attributes.has('aria-invalid'), false);

  control.setAttribute('aria-invalid', 'true');
  form.dispatch('reset');
  assert.equal(control.attributes.has('aria-invalid'), false);
});

test('shared custom validation handles cross-field errors without a native popup', () => {
  const AppForm = loadAppForm();
  const control = new FakeControl({ valid: true }, '確認密碼');
  const notices = [];

  assert.equal(AppForm.invalidate(
    control,
    '兩次輸入的密碼不一致',
    { notify: (message) => notices.push(message) }
  ), false);
  assert.equal(control.attributes.get('aria-invalid'), 'true');
  assert.equal(control.focusOptions.preventScroll, true);
  assert.deepEqual(notices, ['兩次輸入的密碼不一致']);
});
