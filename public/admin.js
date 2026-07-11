/* ===== 管理面板 ===== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let overview = null;

/* ===== 工具 ===== */
function fmt(n) {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs)
    ? abs.toLocaleString()
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + s;
}

// SQLite datetime('now') 是 UTC，轉當地時間顯示
function fmtTime(sqlite) {
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return d.toLocaleString('zh-TW', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/admin/login') {
    showAuth('login');
    throw new Error(body.error || '請先登入');
  }
  if (!res.ok) throw new Error(body.error || '發生錯誤，請稍後再試');
  return body;
}

/* ===== 登入 / 首次設定 ===== */
function showAuth(mode) {
  $('#auth-section').classList.remove('hidden');
  $('#panel').classList.add('hidden');
  $('#auth-title').textContent = mode === 'setup' ? '首次使用：設定管理密碼' : '管理員登入';
  $('#auth-confirm-wrap').classList.toggle('hidden', mode !== 'setup');
  $('#auth-confirm').required = mode === 'setup';
  $('#auth-submit').textContent = mode === 'setup' ? '設定並登入' : '登入';
  $('#form-auth').dataset.mode = mode;
}

$('#form-auth').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const mode = ev.target.dataset.mode;
  const password = $('#auth-password').value;
  if (mode === 'setup' && password !== $('#auth-confirm').value) {
    return toast('兩次輸入的密碼不一致');
  }
  try {
    await api(`/api/admin/${mode === 'setup' ? 'setup' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    ev.target.reset();
    loadPanel();
  } catch (e) { toast(e.message); }
});

/* ===== 面板 ===== */
async function loadPanel() {
  overview = await api('/api/admin/overview');
  $('#auth-section').classList.add('hidden');
  $('#panel').classList.remove('hidden');
  const nameInput = $('#ledger-name');
  if (document.activeElement !== nameInput) nameInput.value = overview.group.name;
  renderMembers();
  renderCats();
  renderTrash();
}

function renderMembers() {
  $('#admin-members').innerHTML = overview.members.map((m) => {
    const records = m.paid_count + m.split_count;
    return `
      <li data-id="${m.id}">
        <span class="member-name-row">
          ${escapeHtml(m.name)}
          <span class="member-tag">${records} 筆紀錄</span>
        </span>
        <span class="admin-actions">
          <button type="button" class="pill-btn act-rename">改名</button>
          <button type="button" class="pill-btn danger act-del"
            ${records > 0 ? 'disabled title="有帳務紀錄，無法刪除"' : ''}>刪除</button>
        </span>
      </li>`;
  }).join('');

  $$('#admin-members .act-rename').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const member = overview.members.find((m) => m.id === li.dataset.id);
      const name = prompt(`把「${member.name}」改名為：`, member.name);
      if (!name || name.trim() === member.name) return;
      try {
        await api(`/api/admin/members/${member.id}/rename`, {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        toast('已改名');
        loadPanel();
      } catch (e) { toast(e.message); }
    });
  });

  $$('#admin-members .act-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const member = overview.members.find((m) => m.id === li.dataset.id);
      if (!confirm(`確定刪除成員「${member.name}」？`)) return;
      try {
        await api(`/api/groups/${overview.group.id}/members/${member.id}`, { method: 'DELETE' });
        toast('成員已刪除');
        loadPanel();
      } catch (e) { toast(e.message); }
    });
  });
}

function renderCats() {
  $('#admin-cats').innerHTML = overview.categories.map((c) => `
    <li data-id="${c.id}">
      <span class="member-name-row">
        ${escapeHtml(c.name)}
        <span class="member-tag">${c.used_count} 筆支出</span>
      </span>
      <span class="admin-actions">
        <button type="button" class="pill-btn danger act-cat-del"
          ${c.used_count > 0 || c.name === '其他' ? 'disabled title="使用中或備援類別，無法刪除"' : ''}>刪除</button>
      </span>
    </li>`).join('');

  $$('#admin-cats .act-cat-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const cat = overview.categories.find((c) => c.id === li.dataset.id);
      if (!confirm(`確定刪除類別「${cat.name}」？`)) return;
      try {
        await api(`/api/groups/${overview.group.id}/categories/${cat.id}`, { method: 'DELETE' });
        toast('類別已刪除');
        loadPanel();
      } catch (e) { toast(e.message); }
    });
  });
}

function renderTrash() {
  const list = $('#admin-trash');
  $('#trash-empty').classList.toggle('hidden', overview.deleted.length > 0);
  $('#btn-clear-trash').classList.toggle('hidden', overview.deleted.length === 0);
  list.innerHTML = overview.deleted.map((e) => `
    <li class="expense-item transfer" data-id="${e.id}">
      <div class="expense-info">
        <div class="expense-desc">${escapeHtml(e.description)}
          <span class="member-tag">${escapeHtml(e.category)}</span></div>
        <div class="expense-meta">${e.expense_date}｜${escapeHtml(e.payer_name)} ${e.kind === 'income' ? '收款' : '付款'} ${fmt(e.amount)}｜
          分攤：${escapeHtml(e.split_names.join('、'))}｜刪於 ${fmtTime(e.deleted_at)}</div>
        ${e.note ? `<div class="expense-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <span class="admin-actions">
        <button type="button" class="pill-btn act-restore">復原</button>
        <button type="button" class="pill-btn danger act-purge">永久刪除</button>
      </span>
    </li>`).join('');

  $$('#admin-trash .act-restore').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('li').dataset.id;
      try {
        await api(`/api/admin/expenses/${id}/restore`, { method: 'POST' });
        toast('已復原');
        loadPanel();
      } catch (e) { toast(e.message); }
    });
  });

  $$('#admin-trash .act-purge').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const exp = overview.deleted.find((e) => e.id === li.dataset.id);
      if (!confirm(`永久刪除「${exp.description}」？此動作無法復原。`)) return;
      try {
        await api(`/api/admin/expenses/${exp.id}`, { method: 'DELETE' });
        toast('已永久刪除');
        loadPanel();
      } catch (e) { toast(e.message); }
    });
  });
}

/* ===== 其他操作 ===== */
$('#form-admin-add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api(`/api/groups/${overview.group.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ name: $('#admin-new-name').value }),
    });
    ev.target.reset();
    toast('成員已新增');
    loadPanel();
  } catch (e) { toast(e.message); }
});

$('#form-admin-add-cat').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api(`/api/groups/${overview.group.id}/categories`, {
      method: 'POST',
      body: JSON.stringify({ name: $('#admin-new-cat').value }),
    });
    ev.target.reset();
    toast('類別已新增');
    loadPanel();
  } catch (e) { toast(e.message); }
});

$('#btn-clear-trash').addEventListener('click', async () => {
  if (!confirm(`清空回收桶？${overview.deleted.length} 筆紀錄將永久刪除，無法復原。`)) return;
  try {
    const r = await api('/api/admin/trash', { method: 'DELETE' });
    toast(`已永久刪除 ${r.deleted} 筆`);
    loadPanel();
  } catch (e) { toast(e.message); }
});

$('#form-rename').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api(`/api/groups/${overview.group.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: $('#ledger-name').value }),
    });
    toast('帳本名稱已更新');
    loadPanel();
  } catch (e) { toast(e.message); }
});

$('#form-password').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }),
    });
    ev.target.reset();
    toast('密碼已更新');
  } catch (e) { toast(e.message); }
});

$('#btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
    showAuth('login');
  } catch (e) { toast(e.message); }
});

/* ===== 初始化 ===== */
(async function init() {
  try {
    const st = await api('/api/admin/status');
    if (!st.setup) showAuth('setup');
    else if (!st.authed) showAuth('login');
    else await loadPanel();
  } catch (e) { toast(e.message); }
})();
