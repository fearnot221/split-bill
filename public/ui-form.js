'use strict';

(() => {
  function validationMessage(control) {
    const label = control.dataset.validationLabel
      || control.getAttribute?.('aria-label')
      || control.placeholder
      || '此欄位';
    const validity = control.validity || {};
    if (validity.valueMissing) return `請填寫${label}`;
    if (validity.tooShort) return `${label}至少需要 ${control.minLength} 個字元`;
    if (validity.tooLong) return `${label}最多只能有 ${control.maxLength} 個字元`;
    if (validity.rangeUnderflow) return `${label}不得小於 ${control.min}`;
    if (validity.rangeOverflow) return `${label}不得大於 ${control.max}`;
    if (validity.stepMismatch || validity.badInput || validity.typeMismatch
      || validity.patternMismatch) return `請輸入有效的${label}`;
    return control.dataset.validationMessage || `請檢查${label}`;
  }

  function clearInvalid(control) {
    if (!control?.removeAttribute) return;
    control.removeAttribute('aria-invalid');
  }

  function bind(form) {
    if (!form || form.dataset.appValidationBound === 'true') return;
    form.noValidate = true;
    form.dataset.appValidationBound = 'true';
    const clear = (event) => {
      clearInvalid(event.target);
      const group = event.target?.dataset?.validationGroup;
      if (!group) return;
      Array.from(form.elements || [])
        .filter((control) => control?.dataset?.validationGroup === group)
        .forEach(clearInvalid);
    };
    form.addEventListener('input', clear);
    form.addEventListener('change', clear);
    form.addEventListener('reset', () => {
      Array.from(form.elements || []).forEach(clearInvalid);
    });
  }

  function invalidate(control, message, { notify } = {}) {
    if (!control) return false;
    control.setAttribute('aria-invalid', 'true');
    if (typeof notify === 'function') notify(message);
    control.focus?.({ preventScroll: true });
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    control.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    return false;
  }

  function validate(form, { notify } = {}) {
    if (!form) return false;
    bind(form);
    const controls = Array.from(form.elements || []);
    const invalid = controls.find((control) =>
      control?.willValidate !== false && control?.validity && !control.validity.valid);
    if (!invalid) {
      controls.forEach(clearInvalid);
      return true;
    }

    controls.forEach(clearInvalid);
    return invalidate(invalid, validationMessage(invalid), { notify });
  }

  window.AppForm = { bind, invalidate, validate };
})();
