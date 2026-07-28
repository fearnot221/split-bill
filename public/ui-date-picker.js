'use strict';

(() => {
  const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function makeDate(year, monthIndex, day) {
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, monthIndex, day);
    return date;
  }

  function parseIso(value) {
    const match = ISO_DATE.exec(String(value || ''));
    if (!match) return null;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = makeDate(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function toIso(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function normalizeIso(value) {
    const date = parseIso(value);
    return date ? toIso(date) : '';
  }

  function addDays(value, amount) {
    const date = parseIso(value);
    if (!date) return '';
    date.setDate(date.getDate() + amount);
    return toIso(date);
  }

  function shiftMonths(value, amount) {
    const date = parseIso(value);
    if (!date) return '';
    const day = date.getDate();
    const target = makeDate(date.getFullYear(), date.getMonth() + amount, 1);
    const lastDay = makeDate(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return toIso(target);
  }

  function buildMonthDays(year, month) {
    const first = makeDate(year, month - 1, 1);
    const start = makeDate(year, month - 1, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = makeDate(start.getFullYear(), start.getMonth(), start.getDate() + index);
      return toIso(date);
    });
  }

  function clampIso(value, min = '', max = '') {
    const normalized = normalizeIso(value);
    if (!normalized) return '';
    const lower = normalizeIso(min);
    const upper = normalizeIso(max);
    if (lower && normalized < lower) return lower;
    if (upper && normalized > upper) return upper;
    return normalized;
  }

  function keyboardTarget(value, key, shiftKey = false) {
    const date = parseIso(value);
    if (!date) return '';
    if (key === 'ArrowLeft') return addDays(value, -1);
    if (key === 'ArrowRight') return addDays(value, 1);
    if (key === 'ArrowUp') return addDays(value, -7);
    if (key === 'ArrowDown') return addDays(value, 7);
    if (key === 'Home') return addDays(value, -date.getDay());
    if (key === 'End') return addDays(value, 6 - date.getDay());
    if (key === 'PageUp') return shiftMonths(value, shiftKey ? -12 : -1);
    if (key === 'PageDown') return shiftMonths(value, shiftKey ? 12 : 1);
    return '';
  }

  const testApi = {
    addDays,
    buildMonthDays,
    clampIso,
    keyboardTarget,
    normalizeIso,
    parseIso,
    shiftMonths,
    toIso,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = testApi;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const dialog = document.querySelector('#date-picker-dialog');
  if (!dialog) return;

  const surface = dialog.querySelector('.date-picker-surface');
  const dialogTitle = dialog.querySelector('#date-picker-dialog-title');
  const closeButton = dialog.querySelector('#date-picker-close');
  const prevButton = dialog.querySelector('#date-picker-prev');
  const nextButton = dialog.querySelector('#date-picker-next');
  const monthLabel = dialog.querySelector('#date-picker-month');
  const daysContainer = dialog.querySelector('#date-picker-days');
  const clearButton = dialog.querySelector('#date-picker-clear');
  const todayButton = dialog.querySelector('#date-picker-today');
  const records = new Map();

  let active = null;
  let selectedIso = '';
  let focusedIso = '';
  let viewYear = 0;
  let viewMonth = 0;
  let minIso = '';
  let maxIso = '';
  let backdropPointerDown = false;

  function todayIso() {
    return toIso(new Date());
  }

  function fullDateLabel(value) {
    const date = parseIso(value);
    if (!date) return '';
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAYS[date.getDay()]}`;
  }

  function visibleDate(value) {
    return normalizeIso(value).replaceAll('-', '/');
  }

  function readConstraints(input) {
    const min = normalizeIso(input.min || input.getAttribute('min'));
    const max = normalizeIso(input.max || input.getAttribute('max'));
    if (min && max && min > max) return { min: max, max: min };
    return { min, max };
  }

  function isAllowed(value) {
    return !!value && (!minIso || value >= minIso) && (!maxIso || value <= maxIso);
  }

  function setBodyLock(locked) {
    const current = Number(document.body.dataset.dialogLocks || 0);
    const next = Math.max(0, current + (locked ? 1 : -1));
    document.body.dataset.dialogLocks = String(next);
    document.body.classList.toggle('app-dialog-open', next > 0);
  }

  function syncRecord(record) {
    if (!record) return;
    const value = normalizeIso(record.input.value);
    const label = record.input.dataset.datePickerLabel || '日期';
    record.display.textContent = value ? visibleDate(value) : (record.input.required ? '選擇日期' : label);
    record.trigger.setAttribute(
      'aria-label',
      `${label}，${value ? fullDateLabel(value) : '未選擇'}，開啟日期選單`
    );
    record.trigger.classList.toggle('has-value', !!value);
    if (value) record.trigger.removeAttribute('aria-invalid');
  }

  function resolveRecord(target) {
    if (!target) return null;
    if (typeof target === 'string') return records.get(target.replace(/^#/, '')) || null;
    if (target.input?.id) return records.get(target.input.id) || null;
    if (target.dataset?.datePickerFor) return records.get(target.dataset.datePickerFor) || null;
    return records.get(target.id) || null;
  }

  function monthHasAllowedDate(year, month) {
    const first = toIso(makeDate(year, month - 1, 1));
    const last = toIso(makeDate(year, month, 0));
    return (!minIso || last >= minIso) && (!maxIso || first <= maxIso);
  }

  function dayAccessibleLabel(value, { selected, today, adjacent }) {
    const details = [fullDateLabel(value)];
    if (today) details.push('今天');
    if (selected) details.push('已選取');
    if (adjacent) details.push('非本月');
    return details.join('，');
  }

  function render({ focusDay = false } = {}) {
    if (!active) return;
    const today = todayIso();
    monthLabel.textContent = `${viewYear} 年 ${viewMonth} 月`;
    todayButton.disabled = !isAllowed(today);
    prevButton.disabled = !monthHasAllowedDate(viewMonth === 1 ? viewYear - 1 : viewYear, viewMonth === 1 ? 12 : viewMonth - 1);
    nextButton.disabled = !monthHasAllowedDate(viewMonth === 12 ? viewYear + 1 : viewYear, viewMonth === 12 ? 1 : viewMonth + 1);

    const values = buildMonthDays(viewYear, viewMonth);
    const rows = [];
    for (let rowIndex = 0; rowIndex < 6; rowIndex += 1) {
      const row = document.createElement('div');
      row.className = 'date-picker__week';
      row.setAttribute('role', 'row');
      values.slice(rowIndex * 7, rowIndex * 7 + 7).forEach((value) => {
        const date = parseIso(value);
        const button = document.createElement('button');
        const adjacent = date.getMonth() + 1 !== viewMonth;
        const selected = value === selectedIso;
        const isToday = value === today;
        button.type = 'button';
        button.className = 'date-picker__day';
        button.dataset.date = value;
        button.textContent = String(date.getDate());
        button.disabled = !isAllowed(value);
        button.tabIndex = value === focusedIso ? 0 : -1;
        button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-selected', String(selected));
        button.setAttribute('aria-label', dayAccessibleLabel(value, { selected, today: isToday, adjacent }));
        button.classList.toggle('adjacent', adjacent);
        button.classList.toggle('selected', selected);
        button.classList.toggle('today', isToday);
        if (isToday) button.setAttribute('aria-current', 'date');
        row.append(button);
      });
      rows.push(row);
    }
    daysContainer.replaceChildren(...rows);

    if (focusDay) {
      requestAnimationFrame(() => {
        const day = [...daysContainer.querySelectorAll('.date-picker__day')]
          .find((button) => button.dataset.date === focusedIso);
        day?.focus({ preventScroll: true });
      });
    }
  }

  function pickInitialDate() {
    if (selectedIso && isAllowed(selectedIso)) return selectedIso;
    const today = todayIso();
    if (isAllowed(today)) return today;
    if (minIso && today < minIso) return minIso;
    if (maxIso && today > maxIso) return maxIso;
    return minIso || maxIso || today;
  }

  function openPicker(target) {
    const record = resolveRecord(target);
    if (!record || dialog.open || active) return false;
    active = record;
    selectedIso = normalizeIso(record.input.value);
    ({ min: minIso, max: maxIso } = readConstraints(record.input));
    focusedIso = pickInitialDate();
    const focusedDate = parseIso(focusedIso);
    viewYear = focusedDate.getFullYear();
    viewMonth = focusedDate.getMonth() + 1;
    dialogTitle.textContent = `選擇${record.input.dataset.datePickerLabel || '日期'}`;
    clearButton.classList.toggle('hidden', record.input.required);
    record.trigger.setAttribute('aria-expanded', 'true');
    render();
    dialog.showModal();
    setBodyLock(true);
    requestAnimationFrame(() => {
      const day = [...daysContainer.querySelectorAll('.date-picker__day')]
        .find((button) => button.dataset.date === focusedIso);
      day?.focus({ preventScroll: true });
    });
    return true;
  }

  function closePicker({ restoreFocus = true } = {}) {
    if (!active) return;
    const record = active;
    active = null;
    backdropPointerDown = false;
    if (dialog.open) dialog.close();
    record.trigger.setAttribute('aria-expanded', 'false');
    setBodyLock(false);
    if (restoreFocus && record.trigger.isConnected) {
      requestAnimationFrame(() => record.trigger.focus({ preventScroll: true }));
    }
  }

  function dispatchValue(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setValue(target, value, { dispatch = false } = {}) {
    const record = resolveRecord(target);
    if (!record) return '';
    record.input.value = normalizeIso(value);
    syncRecord(record);
    if (active === record) {
      selectedIso = record.input.value;
      ({ min: minIso, max: maxIso } = readConstraints(record.input));
      if (selectedIso && isAllowed(selectedIso)) {
        focusedIso = selectedIso;
        const selectedDate = parseIso(selectedIso);
        viewYear = selectedDate.getFullYear();
        viewMonth = selectedDate.getMonth() + 1;
      }
      render();
    }
    if (dispatch) dispatchValue(record.input);
    return record.input.value;
  }

  function commit(value) {
    if (!active) return;
    const record = active;
    const normalized = normalizeIso(value);
    if (normalized && !isAllowed(normalized)) return;
    if (!normalized && record.input.required) return;
    setValue(record, normalized);
    dispatchValue(record.input);
    closePicker();
  }

  function moveFocus(key, shiftKey) {
    const target = keyboardTarget(focusedIso, key, shiftKey);
    if (!target) return false;
    focusedIso = clampIso(target, minIso, maxIso);
    const date = parseIso(focusedIso);
    viewYear = date.getFullYear();
    viewMonth = date.getMonth() + 1;
    render({ focusDay: true });
    return true;
  }

  function shiftView(amount) {
    const target = clampIso(shiftMonths(focusedIso, amount), minIso, maxIso);
    if (!target) return;
    focusedIso = target;
    const date = parseIso(target);
    viewYear = date.getFullYear();
    viewMonth = date.getMonth() + 1;
    render();
  }

  function tabbableElements() {
    const focusedDay = [...daysContainer.querySelectorAll('.date-picker__day')]
      .find((button) => button.tabIndex === 0 && !button.disabled);
    return [closeButton, prevButton, nextButton, focusedDay, clearButton, todayButton]
      .filter((element) => element && !element.disabled && !element.classList.contains('hidden'));
  }

  document.querySelectorAll('[data-date-picker]').forEach((input) => {
    const trigger = [...document.querySelectorAll('[data-date-picker-for]')]
      .find((candidate) => candidate.dataset.datePickerFor === input.id);
    const display = trigger?.querySelector('[data-date-picker-display]');
    if (!trigger || !display || !input.id) return;
    const record = { input, trigger, display };
    records.set(input.id, record);
    if (input.required) trigger.setAttribute('aria-required', 'true');
    else trigger.removeAttribute('aria-required');
    trigger.addEventListener('click', () => openPicker(record));
    input.addEventListener('input', () => syncRecord(record));
    input.addEventListener('change', () => syncRecord(record));
    syncRecord(record);
  });

  prevButton.addEventListener('click', () => shiftView(-1));
  nextButton.addEventListener('click', () => shiftView(1));
  closeButton.addEventListener('click', () => closePicker());
  todayButton.addEventListener('click', () => {
    const today = todayIso();
    if (isAllowed(today)) commit(today);
  });
  clearButton.addEventListener('click', () => commit(''));

  daysContainer.addEventListener('click', (event) => {
    const button = event.target.closest('.date-picker__day');
    if (!button || button.disabled) return;
    commit(button.dataset.date);
  });
  daysContainer.addEventListener('keydown', (event) => {
    if (!event.target.closest('.date-picker__day')) return;
    if (moveFocus(event.key, event.shiftKey)) event.preventDefault();
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const elements = tabbableElements();
    if (!elements.length) return;
    const current = elements.indexOf(document.activeElement);
    if (event.shiftKey && current <= 0) {
      event.preventDefault();
      elements.at(-1).focus({ preventScroll: true });
    } else if (!event.shiftKey && (current === -1 || current === elements.length - 1)) {
      event.preventDefault();
      elements[0].focus({ preventScroll: true });
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePicker();
  });
  dialog.addEventListener('pointerdown', (event) => {
    backdropPointerDown = event.target === dialog;
  });
  dialog.addEventListener('pointerup', (event) => {
    if (backdropPointerDown && event.target === dialog) closePicker();
    backdropPointerDown = false;
  });
  dialog.addEventListener('pointercancel', () => {
    backdropPointerDown = false;
  });
  surface.addEventListener('pointerdown', (event) => event.stopPropagation());

  window.AppDatePicker = {
    close: () => closePicker(),
    getTrigger: (target) => resolveRecord(target)?.trigger || null,
    isOpen: () => !!active && dialog.open,
    open: openPicker,
    setValue,
    sync: (target) => {
      const record = resolveRecord(target);
      syncRecord(record);
      if (active === record) {
        selectedIso = normalizeIso(record.input.value);
        ({ min: minIso, max: maxIso } = readConstraints(record.input));
        if (selectedIso && isAllowed(selectedIso)) {
          focusedIso = selectedIso;
          const selectedDate = parseIso(selectedIso);
          viewYear = selectedDate.getFullYear();
          viewMonth = selectedDate.getMonth() + 1;
        } else {
          focusedIso = pickInitialDate();
          const focusedDate = parseIso(focusedIso);
          viewYear = focusedDate.getFullYear();
          viewMonth = focusedDate.getMonth() + 1;
        }
        render();
      }
      return record?.input.value || '';
    },
    syncAll: () => records.forEach(syncRecord),
  };
})();
