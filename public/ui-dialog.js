'use strict';

(() => {
  const dialog = document.querySelector('#app-dialog');
  if (!dialog) return;

  const form = dialog.querySelector('#app-dialog-form');
  const title = dialog.querySelector('#app-dialog-title');
  const message = dialog.querySelector('#app-dialog-message');
  const promptWrap = dialog.querySelector('#app-dialog-prompt-wrap');
  const promptLabel = dialog.querySelector('#app-dialog-prompt-label');
  const promptInput = dialog.querySelector('#app-dialog-input');
  const error = dialog.querySelector('#app-dialog-error');
  const cancelButton = dialog.querySelector('#app-dialog-cancel');
  const confirmButton = dialog.querySelector('#app-dialog-confirm');
  const closeButton = dialog.querySelector('#app-dialog-close');
  const focusTargets = [promptInput, cancelButton, confirmButton];

  form.noValidate = true;

  let active = null;
  let backdropPointerDown = false;

  function setBodyLock(locked) {
    const current = Number(document.body.dataset.dialogLocks || 0);
    const next = Math.max(0, current + (locked ? 1 : -1));
    document.body.dataset.dialogLocks = String(next);
    document.body.classList.toggle('app-dialog-open', next > 0);
  }

  function finish(value) {
    if (!active || active.settling || dialog.classList.contains('closing')) return;
    const session = active;
    session.settling = true;
    dialog.classList.add('closing');
    const closeDelay = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 0 : 150;
    setTimeout(() => {
      if (dialog.open) dialog.close();
      dialog.classList.remove('closing');
      dialog.removeAttribute('data-tone');
      focusTargets.forEach((target) => target.removeAttribute('autofocus'));
      promptInput.removeAttribute('aria-errormessage');
      setBodyLock(false);
      active = null;
      if (session.returnFocus?.isConnected) session.returnFocus.focus({ preventScroll: true });
      session.resolve(value);
    }, closeDelay);
  }

  function submit() {
    if (!active) return;
    if (active.mode === 'prompt') {
      const value = promptInput.value.trim();
      if (active.required && !value) {
        promptInput.setAttribute('aria-invalid', 'true');
        promptInput.setAttribute('aria-errormessage', 'app-dialog-error');
        error.textContent = active.requiredMessage;
        error.classList.remove('hidden');
        promptInput.focus();
        return;
      }
      finish(value || null);
      return;
    }
    finish(true);
  }

  function open(mode, options = {}) {
    if (active || dialog.open) return Promise.resolve(mode === 'confirm' ? false : null);
    const returnFocus = document.activeElement;
    const isPrompt = mode === 'prompt';
    const tone = options.tone === 'danger' ? 'danger' : 'default';
    const required = isPrompt && options.required !== false;
    const initialFocus = isPrompt
      ? promptInput
      : tone === 'danger' ? cancelButton : confirmButton;

    title.textContent = options.title || (isPrompt ? '輸入資料' : '確認操作');
    message.textContent = options.message || '';
    message.classList.toggle('hidden', !options.message);
    if (options.message) dialog.setAttribute('aria-describedby', 'app-dialog-message');
    else dialog.removeAttribute('aria-describedby');
    promptWrap.classList.toggle('hidden', !isPrompt);
    promptLabel.textContent = options.label || '名稱';
    promptInput.value = isPrompt ? String(options.value || '') : '';
    promptInput.placeholder = options.placeholder || '';
    promptInput.maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 200;
    promptInput.required = required;
    if (required) promptInput.setAttribute('aria-required', 'true');
    else promptInput.removeAttribute('aria-required');
    promptInput.removeAttribute('aria-invalid');
    promptInput.removeAttribute('aria-errormessage');
    error.textContent = '';
    error.classList.add('hidden');
    cancelButton.textContent = options.cancelLabel || '取消';
    confirmButton.textContent = options.confirmLabel || (isPrompt ? '確認' : '繼續');
    confirmButton.classList.toggle('btn-danger-solid', tone === 'danger');
    confirmButton.classList.toggle('btn-primary', tone !== 'danger');
    dialog.dataset.tone = tone;

    focusTargets.forEach((target) => target.removeAttribute('autofocus'));
    initialFocus.setAttribute('autofocus', '');
    dialog.showModal();
    setBodyLock(true);

    return new Promise((resolve) => {
      active = {
        mode,
        resolve,
        returnFocus,
        required,
        requiredMessage: options.requiredMessage || '請輸入內容',
      };
      requestAnimationFrame(() => {
        initialFocus.focus({ preventScroll: true });
        if (isPrompt) promptInput.select();
      });
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  cancelButton.addEventListener('click', () => finish(active?.mode === 'confirm' ? false : null));
  closeButton.addEventListener('click', () => finish(active?.mode === 'confirm' ? false : null));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish(active?.mode === 'confirm' ? false : null);
  });
  dialog.addEventListener('pointerdown', (event) => {
    backdropPointerDown = event.target === dialog;
  });
  dialog.addEventListener('pointerup', (event) => {
    if (backdropPointerDown && event.target === dialog) {
      finish(active?.mode === 'confirm' ? false : null);
    }
    backdropPointerDown = false;
  });
  dialog.addEventListener('pointercancel', () => {
    backdropPointerDown = false;
  });
  promptInput.addEventListener('input', () => {
    if (!promptInput.value.trim()) return;
    promptInput.removeAttribute('aria-invalid');
    promptInput.removeAttribute('aria-errormessage');
    error.textContent = '';
    error.classList.add('hidden');
  });

  window.AppDialog = {
    confirm: (options) => open('confirm', typeof options === 'string' ? { message: options } : options),
    prompt: (options) => open('prompt', options),
  };
})();
