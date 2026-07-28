'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  addDays,
  buildMonthDays,
  clampIso,
  keyboardTarget,
  normalizeIso,
  parseIso,
  shiftMonths,
  toIso,
} = require('../public/ui-date-picker.js');

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

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = !!options.bubbles;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.shiftKey = false;
    this.key = '';
  }

  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function dataName(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

class FakeElement {
  constructor(document, tagName = 'div', { id = '', classes = [] } = {}) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.value = '';
    this.required = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.min = '';
    this.max = '';
    this.open = false;
    this.isConnected = true;
  }

  set className(value) {
    this.classList = new FakeClassList(String(value).split(/\s+/).filter(Boolean));
  }

  get className() { return [...this.classList.values].join(' '); }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && !event.propagationStopped && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }

  dispatch(type, values = {}) {
    const event = new FakeEvent(type, values);
    Object.assign(event, values);
    this.dispatchEvent(event);
    return event;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[dataName(name)] = String(value);
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }

  append(...elements) {
    elements.forEach((element) => {
      element.parentElement = this;
      this.children.push(element);
    });
  }

  replaceChildren(...elements) {
    this.children.forEach((element) => { element.parentElement = null; });
    this.children = [];
    this.append(...elements);
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    if (attribute?.startsWith('data-')) return dataName(attribute) in this.dataset;
    return false;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      element.children.forEach((child) => {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let element = this;
    while (element) {
      if (element.matches(selector)) return element;
      element = element.parentElement;
    }
    return null;
  }

  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function createBrowserEnvironment() {
  const document = {
    activeElement: null,
    createElement(tagName) { return new FakeElement(document, tagName); },
  };
  const body = new FakeElement(document, 'body');
  document.body = body;
  document.querySelectorAll = (selector) => body.querySelectorAll(selector);
  document.querySelector = (selector) => body.querySelector(selector);

  const make = (tagName, id, classes = []) => new FakeElement(document, tagName, { id, classes });
  const dialog = make('dialog', 'date-picker-dialog', ['app-dialog', 'date-picker-dialog']);
  const surface = make('section', '', ['date-picker-surface']);
  const title = make('h2', 'date-picker-dialog-title');
  const close = make('button', 'date-picker-close', ['icon-btn']);
  const prev = make('button', 'date-picker-prev', ['icon-btn']);
  const next = make('button', 'date-picker-next', ['icon-btn']);
  const month = make('p', 'date-picker-month');
  const days = make('div', 'date-picker-days', ['date-picker__days']);
  const clear = make('button', 'date-picker-clear', ['btn', 'hidden']);
  const today = make('button', 'date-picker-today', ['btn']);
  surface.append(title, close, prev, month, next, days, clear, today);
  dialog.append(surface);
  body.append(dialog);

  const addField = (id, label, { required = false, value = '' } = {}) => {
    const input = make('input', id);
    input.dataset.datePicker = '';
    input.dataset.datePickerLabel = label;
    input.required = required;
    input.value = value;
    const trigger = make('button', `${id}-trigger`, ['date-picker-trigger']);
    trigger.dataset.datePickerFor = id;
    trigger.setAttribute('aria-expanded', 'false');
    const display = make('span');
    display.dataset.datePickerDisplay = '';
    trigger.append(display);
    body.append(input, trigger);
    return { input, trigger, display };
  };

  const expense = addField('exp-date', '日期', { required: true, value: '2026-07-28' });
  const stats = addField('stats-from', '起始日');
  const context = {
    document,
    window: {},
    Event: FakeEvent,
    requestAnimationFrame: (callback) => callback(),
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/ui-date-picker.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'ui-date-picker.js' });
  return { body, clear, context, days, dialog, expense, stats };
}

test('ISO helpers reject impossible dates and preserve local calendar days', () => {
  assert.equal(normalizeIso('2024-02-29'), '2024-02-29');
  assert.equal(normalizeIso('2023-02-29'), '');
  assert.equal(normalizeIso('2026-13-01'), '');
  assert.equal(normalizeIso('07/28/2026'), '');
  assert.equal(parseIso(''), null);
  assert.equal(toIso(parseIso('2026-07-28')), '2026-07-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('calendar months always contain six complete weeks with selectable adjacent dates', () => {
  const july = buildMonthDays(2026, 7);
  assert.equal(july.length, 42);
  assert.equal(new Set(july).size, 42);
  assert.equal(july[0], '2026-06-28');
  assert.equal(july[3], '2026-07-01');
  assert.equal(july.at(-1), '2026-08-08');

  const leapFebruary = buildMonthDays(2024, 2);
  assert.equal(leapFebruary.length, 42);
  assert.equal(leapFebruary[0], '2024-01-28');
  assert.ok(leapFebruary.includes('2024-02-29'));
  assert.equal(leapFebruary.at(-1), '2024-03-09');
});

test('month and year movement clamps to the last valid day', () => {
  assert.equal(shiftMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(shiftMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(shiftMonths('2026-12-31', 1), '2027-01-31');
});

test('calendar keyboard targets follow grid, month, and year navigation', () => {
  const date = '2026-07-28';
  assert.equal(keyboardTarget(date, 'ArrowLeft'), '2026-07-27');
  assert.equal(keyboardTarget(date, 'ArrowRight'), '2026-07-29');
  assert.equal(keyboardTarget(date, 'ArrowUp'), '2026-07-21');
  assert.equal(keyboardTarget(date, 'ArrowDown'), '2026-08-04');
  assert.equal(keyboardTarget(date, 'Home'), '2026-07-26');
  assert.equal(keyboardTarget(date, 'End'), '2026-08-01');
  assert.equal(keyboardTarget(date, 'PageUp'), '2026-06-28');
  assert.equal(keyboardTarget(date, 'PageDown'), '2026-08-28');
  assert.equal(keyboardTarget(date, 'PageUp', true), '2025-07-28');
  assert.equal(keyboardTarget(date, 'PageDown', true), '2027-07-28');
  assert.equal(keyboardTarget(date, 'Enter'), '');
});

test('date constraints clamp keyboard destinations at both boundaries', () => {
  assert.equal(clampIso('2026-07-01', '2026-07-10', '2026-07-20'), '2026-07-10');
  assert.equal(clampIso('2026-07-15', '2026-07-10', '2026-07-20'), '2026-07-15');
  assert.equal(clampIso('2026-07-31', '2026-07-10', '2026-07-20'), '2026-07-20');
  assert.equal(clampIso('not-a-date', '2026-07-10', '2026-07-20'), '');
});

test('custom picker opens on the selected day and commits an adjacent-month day', () => {
  const env = createBrowserEnvironment();
  const events = [];
  env.expense.input.addEventListener('input', () => events.push('input'));
  env.expense.input.addEventListener('change', () => events.push('change'));

  env.expense.trigger.dispatch('click');
  const dayButtons = env.days.querySelectorAll('.date-picker__day');
  assert.equal(env.dialog.open, true);
  assert.equal(env.expense.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(env.expense.trigger.getAttribute('aria-required'), 'true');
  assert.equal(env.body.dataset.dialogLocks, '1');
  assert.equal(dayButtons.length, 42);
  assert.equal(dayButtons.filter((button) => button.classList.contains('selected')).length, 1);
  assert.equal(env.expense.input.value, '2026-07-28');
  assert.equal(env.expense.trigger.ownerDocument.activeElement.dataset.date, '2026-07-28');
  assert.equal(env.clear.classList.contains('hidden'), true);

  const adjacent = dayButtons.find((button) => button.dataset.date === '2026-08-02');
  assert.equal(adjacent.classList.contains('adjacent'), true);
  adjacent.dispatch('click', { bubbles: true });

  assert.equal(env.expense.input.value, '2026-08-02');
  assert.equal(env.expense.display.textContent, '2026/08/02');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(env.dialog.open, false);
  assert.equal(env.expense.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(env.body.dataset.dialogLocks, '0');
  assert.equal(env.expense.trigger.ownerDocument.activeElement, env.expense.trigger);
});

test('keyboard navigation is roving and Escape cancels without changing the value', () => {
  const env = createBrowserEnvironment();
  env.expense.trigger.dispatch('click');
  const selected = env.expense.trigger.ownerDocument.activeElement;

  selected.dispatch('keydown', { bubbles: true, key: 'ArrowRight' });
  assert.equal(env.expense.trigger.ownerDocument.activeElement.dataset.date, '2026-07-29');
  assert.equal(env.expense.input.value, '2026-07-28');

  env.dialog.dispatch('cancel');
  assert.equal(env.dialog.open, false);
  assert.equal(env.expense.input.value, '2026-07-28');
  assert.equal(env.expense.trigger.ownerDocument.activeElement, env.expense.trigger);
});

test('optional fields expose Clear and public API syncs external updates', () => {
  const env = createBrowserEnvironment();
  const { AppDatePicker } = env.context.window;
  let changes = 0;
  env.stats.input.addEventListener('change', () => { changes += 1; });

  assert.equal(AppDatePicker.setValue('#stats-from', '2026-07-15'), '2026-07-15');
  assert.equal(env.stats.display.textContent, '2026/07/15');
  assert.equal(changes, 0);
  assert.equal(AppDatePicker.getTrigger('stats-from'), env.stats.trigger);

  AppDatePicker.open(env.stats.input);
  assert.equal(AppDatePicker.isOpen(), true);
  assert.equal(env.clear.classList.contains('hidden'), false);
  AppDatePicker.setValue('stats-from', '2026-08-10');
  assert.equal(
    env.days.querySelectorAll('.date-picker__day')
      .find((button) => button.classList.contains('selected')).dataset.date,
    '2026-08-10'
  );
  env.clear.dispatch('click');
  assert.equal(env.stats.input.value, '');
  assert.equal(env.stats.display.textContent, '起始日');
  assert.equal(changes, 1);
  assert.equal(AppDatePicker.isOpen(), false);

  env.expense.trigger.setAttribute('aria-invalid', 'true');
  AppDatePicker.setValue('exp-date', '2026-08-03', { dispatch: false });
  assert.equal(env.expense.trigger.getAttribute('aria-invalid'), null);
  AppDatePicker.open('exp-date');
  AppDatePicker.close();
  assert.equal(AppDatePicker.isOpen(), false);
  assert.equal(env.expense.trigger.ownerDocument.activeElement, env.expense.trigger);
});
