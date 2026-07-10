/* ===== 狀態 ===== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const TRANSFER_CAT = '還款';
const SPEND_CATS = ['餐飲', '交通', '住宿', '購物', '娛樂', '其他'];

const CATEGORY_KEYS = {
  '餐飲': 'food', '交通': 'transport', '住宿': 'lodging',
  '購物': 'shopping', '娛樂': 'fun', '其他': 'other', '還款': 'transfer',
};

const svgWrap = (paths, sw = 1.8) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  food: svgWrap('<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>'),
  transport: svgWrap('<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>'),
  lodging: svgWrap('<path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M2 17h20"/>'),
  shopping: svgWrap('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>'),
  fun: svgWrap('<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'),
  other: svgWrap('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  transfer: svgWrap('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  trash: svgWrap('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
  x: svgWrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: svgWrap('<path d="M20 6 9 17l-5-5"/>', 2.2),
};

function catIcon(cat, cls = 'expense-icon') {
  const key = CATEGORY_KEYS[cat] || 'other';
  return `<span class="${cls} cat-${key}">${ICONS[key]}</span>`;
}

let state = {
  groupId: null,
  memberId: null,
  data: null,          // 伺服器回傳的帳本資料
  filterText: '',
  filterCat: '全部',
  statsMonth: 'all',
  editingId: null,     // 正在編輯的支出 id（null = 新增）
  pollTimer: null,
};

/* ===== 工具 ===== */
function fmt(n) {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs)
    ? abs.toLocaleString()
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + s;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  const yearPart = y === new Date().getFullYear() ? '' : `${y} 年 `;
  return `${yearPart}${m} 月 ${d} 日・週${wd}`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '發生錯誤，請稍後再試');
  return body;
}

function memberName(id) {
  const m = state.data?.members.find((m) => m.id === id);
  return m ? m.name : '?';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const isTransfer = (e) => e.category === TRANSFER_CAT;

async function refresh() {
  if (!state.groupId) return;
  state.data = await api(`/api/groups/${state.groupId}`);
  renderAll();
}

/* ===== 渲染 ===== */
function renderAll() {
  const { group, members, expenses, balances, settlements, total } = state.data;

  $('#group-name').textContent = group.name;
  document.title = `${group.name} — 分帳趣`;

  // 帳本設定的名稱欄位（輸入中不覆蓋）
  const nameInput = $('#ledger-name');
  if (document.activeElement !== nameInput) nameInput.value = group.name;

  // 摘要列
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthTotal = expenses.reduce(
    (sum, e) => (!isTransfer(e) && e.expense_date.startsWith(monthKey) ? sum + e.amount : sum), 0);
  $('#month-total').textContent = fmt(monthTotal);
  $('#total-amount').textContent = fmt(total);

  const myBal = balances[state.memberId] ?? 0;
  const balEl = $('#my-balance');
  balEl.textContent = fmt(myBal);
  balEl.className = 'stat-value ' + (myBal > 0.01 ? 'positive' : myBal < -0.01 ? 'negative' : '');

  renderExpenses();
  renderBalances(members, balances);
  renderSettlements(settlements);
  renderStats();
  renderMembers(members);
}

/* ===== 支出列表（含搜尋 / 分類篩選） ===== */
function matchesFilter(e) {
  if (state.filterCat !== '全部' && e.category !== state.filterCat) return false;
  const q = state.filterText.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    e.description,
    memberName(e.payer_id),
    ...e.splits.map((s) => memberName(s.member_id)),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function expenseItemHtml(e) {
  const meta = isTransfer(e)
    ? `${escapeHtml(memberName(e.payer_id))} 還款給 ${escapeHtml(e.splits.map((s) => memberName(s.member_id)).join('、'))}`
    : `${escapeHtml(memberName(e.payer_id))} 付款｜分攤：${escapeHtml(e.splits.map((s) => memberName(s.member_id)).join('、'))}`;
  return `
    <li class="expense-item${isTransfer(e) ? ' transfer' : ''}" data-id="${e.id}">
      ${catIcon(e.category)}
      <div class="expense-info">
        <div class="expense-desc">${escapeHtml(e.description)}</div>
        <div class="expense-meta">${meta}</div>
      </div>
      <span class="expense-amount">${fmt(e.amount)}</span>
      <button class="expense-del" title="刪除">${ICONS.trash}</button>
    </li>`;
}

function renderExpenses() {
  const expenses = state.data.expenses.filter(matchesFilter);
  const list = $('#expense-list');
  const empty = $('#expense-empty');
  empty.classList.toggle('hidden', expenses.length > 0);
  empty.textContent = state.data.expenses.length === 0
    ? '還沒有任何支出，點右下角「＋」新增第一筆吧！'
    : '沒有符合條件的支出';

  // 依日期分組
  const days = [];
  for (const e of expenses) {
    const last = days[days.length - 1];
    if (!last || last.date !== e.expense_date) days.push({ date: e.expense_date, items: [e] });
    else last.items.push(e);
  }

  list.innerHTML = days.map((day) => {
    const dayTotal = day.items.reduce((s, e) => (isTransfer(e) ? s : s + e.amount), 0);
    return `
    <li class="expense-day">
      <div class="expense-date-header">
        <span>${fmtDate(day.date)}</span>
        ${dayTotal > 0 ? `<span>${fmt(dayTotal)}</span>` : ''}
      </div>
      <ul class="day-group">${day.items.map(expenseItemHtml).join('')}</ul>
    </li>`;
  }).join('');

  list.querySelectorAll('.expense-item').forEach((item) => {
    const expense = state.data.expenses.find((e) => e.id === item.dataset.id);

    item.querySelector('.expense-del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`確定刪除「${expense.description}」？`)) return;
      try {
        await api(`/api/groups/${state.groupId}/expenses/${expense.id}`, { method: 'DELETE' });
        toast('已刪除');
        refresh();
      } catch (e) { toast(e.message); }
    });

    // 點擊項目編輯（還款只能刪除）
    if (!isTransfer(expense)) {
      item.addEventListener('click', () => openExpenseModal(expense));
    }
  });
}

/* ===== 結算 ===== */
function renderBalances(members, balances) {
  $('#balance-list').innerHTML = members.map((m) => {
    const bal = balances[m.id] ?? 0;
    const cls = bal > 0.01 ? 'positive' : bal < -0.01 ? 'negative' : 'zero';
    const note = bal > 0.01 ? '應收' : bal < -0.01 ? '應付' : '結清';
    return `
      <li>
        <span class="member-name-row">${escapeHtml(m.name)}</span>
        <span class="balance-amount ${cls}">${note} ${fmt(Math.abs(bal))}</span>
      </li>`;
  }).join('');
}

function renderSettlements(settlements) {
  $('#settle-empty').classList.toggle('hidden', settlements.length > 0);
  $('#settlement-list').innerHTML = settlements.map((s, i) => `
    <li>
      ${escapeHtml(memberName(s.from))}
      <span class="settle-arrow">→</span>
      ${escapeHtml(memberName(s.to))}
      <span class="settle-amount">${fmt(s.amount)}</span>
      <button class="settle-done" data-i="${i}">${ICONS.check}已還款</button>
    </li>`).join('');

  $$('#settlement-list .settle-done').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const s = settlements[Number(btn.dataset.i)];
      const fromName = memberName(s.from);
      const toName = memberName(s.to);
      if (!confirm(`確認 ${fromName} 已把 ${fmt(s.amount)} 還給 ${toName}？`)) return;
      try {
        await api(`/api/groups/${state.groupId}/expenses`, {
          method: 'POST',
          body: JSON.stringify({
            payerId: s.from,
            description: `還款給 ${toName}`,
            amount: s.amount,
            category: TRANSFER_CAT,
            expenseDate: new Date().toISOString().slice(0, 10),
            splits: [{ memberId: s.to, amount: s.amount }],
          }),
        });
        toast('已記錄還款');
        refresh();
      } catch (e) { toast(e.message); }
    });
  });
}

/* ===== 統計 ===== */
function renderStats() {
  const real = state.data.expenses.filter((e) => !isTransfer(e));

  // 月份選單（保留目前選擇）
  const months = [...new Set(real.map((e) => e.expense_date.slice(0, 7)))].sort().reverse();
  if (state.statsMonth !== 'all' && !months.includes(state.statsMonth)) state.statsMonth = 'all';
  const sel = $('#stats-month');
  sel.innerHTML = '<option value="all">全部時間</option>' + months.map((m) => {
    const [y, mo] = m.split('-');
    return `<option value="${m}">${y} 年 ${Number(mo)} 月</option>`;
  }).join('');
  sel.value = state.statsMonth;

  const filtered = state.statsMonth === 'all'
    ? real
    : real.filter((e) => e.expense_date.startsWith(state.statsMonth));

  const total = filtered.reduce((s, e) => s + e.amount, 0);
  $('#stat-total').textContent = fmt(total);
  $('#stat-count').textContent = filtered.length;
  $('#stat-avg').textContent = filtered.length ? fmt(total / filtered.length) : '$0';

  $('#stats-empty').classList.toggle('hidden', filtered.length > 0);

  // 分類統計
  const byCat = {};
  for (const e of filtered) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $('#cat-stats').innerHTML = cats.map(([cat, amt]) => {
    const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
    return `
      <li>
        <div class="bar-row">
          <span class="bar-name">${catIcon(cat, 'bar-icon')}${escapeHtml(cat)}</span>
          <span class="bar-val">${fmt(amt)} <em>${pct}%</em></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </li>`;
  }).join('');

  // 成員統計：付了多少、應分攤多少
  const { members } = state.data;
  const paid = {}, share = {};
  for (const e of filtered) {
    paid[e.payer_id] = (paid[e.payer_id] || 0) + e.amount;
    for (const s of e.splits) share[s.member_id] = (share[s.member_id] || 0) + s.amount;
  }
  const maxPaid = Math.max(...members.map((m) => paid[m.id] || 0), 1);
  $('#member-stats').innerHTML = members.map((m) => {
    const p = paid[m.id] || 0;
    const sh = share[m.id] || 0;
    const pct = Math.round((p / maxPaid) * 100);
    return `
      <li>
        <div class="bar-row">
          <span class="bar-name">${escapeHtml(m.name)}</span>
          <span class="bar-val">${fmt(p)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">付款 ${fmt(p)}｜應分攤 ${fmt(sh)}</div>
      </li>`;
  }).join('');
}

/* ===== 成員 ===== */
function renderMembers(members) {
  $('#member-list').innerHTML = members.map((m) => `
    <li data-id="${m.id}">
      <span class="member-name-row">
        ${escapeHtml(m.name)}
        ${m.id === state.memberId ? '<span class="member-tag">我</span>' : ''}
      </span>
      ${m.id === state.memberId ? '' : `<button class="member-del" title="刪除成員">${ICONS.x}</button>`}
    </li>`).join('');

  $$('#member-list .member-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const name = memberName(li.dataset.id);
      if (!confirm(`確定刪除成員「${name}」？（有帳務紀錄的成員無法刪除）`)) return;
      try {
        await api(`/api/groups/${state.groupId}/members/${li.dataset.id}`, { method: 'DELETE' });
        toast('成員已刪除');
        refresh();
      } catch (e) { toast(e.message); }
    });
  });
}

/* ===== 分類 chips（篩選列與 Modal 共用同一套產生邏輯） ===== */
const chipHtml = (cat) =>
  `<button type="button" class="chip" data-cat="${cat}"><span>${cat}</span></button>`;

$('#filter-cats').innerHTML =
  '<button type="button" class="chip active" data-cat="全部"><span>全部</span></button>'
  + [...SPEND_CATS, TRANSFER_CAT].map(chipHtml).join('');

$('#exp-categories').innerHTML = SPEND_CATS.map(chipHtml).join('');

/* ===== 分頁切換 ===== */
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
    $('#btn-add-expense').classList.toggle('hidden', tab !== 'expenses');
  });
});

/* ===== 搜尋 / 篩選 ===== */
$('#filter-text').addEventListener('input', (ev) => {
  state.filterText = ev.target.value;
  renderExpenses();
});
$$('#filter-cats .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('#filter-cats .chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.filterCat = chip.dataset.cat;
    renderExpenses();
  });
});

/* ===== 統計操作 ===== */
$('#stats-month').addEventListener('change', (ev) => {
  state.statsMonth = ev.target.value;
  renderStats();
});
$('#btn-export').addEventListener('click', () => {
  location.href = `/api/groups/${state.groupId}/export`;
});

/* ===== 成員 / 帳本設定 ===== */
$('#form-add-member').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('#new-member-name').value;
  try {
    await api(`/api/groups/${state.groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    ev.target.reset();
    toast('成員已新增');
    refresh();
  } catch (e) { toast(e.message); }
});

$('#form-rename').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('#ledger-name').value;
  try {
    await api(`/api/groups/${state.groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    toast('帳本名稱已更新');
    refresh();
  } catch (e) { toast(e.message); }
});

/* ===== 新增 / 編輯支出 Modal ===== */
let splitMode = 'equal';

function setSplitMode(mode) {
  splitMode = mode;
  $('#split-equal').classList.toggle('active', mode === 'equal');
  $('#split-custom').classList.toggle('active', mode === 'custom');
  $$('#split-members .split-amount-input').forEach((i) => i.classList.toggle('hidden', mode === 'equal'));
  $$('#split-members .split-amount-label').forEach((l) => l.classList.toggle('hidden', mode === 'custom'));
  updateSplitPreview();
}

function openExpenseModal(expense = null) {
  const { members } = state.data;
  state.editingId = expense?.id || null;
  $('#modal-title').textContent = expense ? '編輯支出' : '新增支出';

  $('#form-expense').reset();
  $('#exp-desc').value = expense?.description || '';
  $('#exp-amount').value = expense ? expense.amount : '';
  $('#exp-date').value = expense?.expense_date || new Date().toISOString().slice(0, 10);

  const cat = expense?.category || '餐飲';
  $$('#exp-categories .chip').forEach((c) => c.classList.toggle('active', c.dataset.cat === cat));

  $('#exp-payer').innerHTML = members.map((m) =>
    `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  $('#exp-payer').value = expense?.payer_id || state.memberId;

  const splitMap = new Map((expense?.splits || []).map((s) => [s.member_id, s.amount]));
  $('#split-members').innerHTML = members.map((m) => `
    <li data-id="${m.id}">
      <input type="checkbox" ${!expense || splitMap.has(m.id) ? 'checked' : ''}>
      <span class="split-name">${escapeHtml(m.name)}</span>
      <span class="split-amount-label">—</span>
      <input type="number" class="split-amount-input hidden" min="0" step="0.01"
        inputmode="decimal" placeholder="0" value="${splitMap.get(m.id) ?? ''}">
    </li>`).join('');

  $('#split-members').querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', updateSplitPreview);
    inp.addEventListener('change', updateSplitPreview);
  });

  // 編輯時判斷原本是均分還是自訂
  let mode = 'equal';
  if (expense) {
    const checkedIds = members.filter((m) => splitMap.has(m.id)).map((m) => m.id);
    const shares = equalSplit(expense.amount, checkedIds.length);
    const isEqual = checkedIds.every((id, i) => Math.abs(splitMap.get(id) - shares[i]) < 0.011);
    mode = isEqual ? 'equal' : 'custom';
  }
  setSplitMode(mode);

  $('#modal-expense').classList.remove('hidden');
  setTimeout(() => $('#exp-desc').focus(), 50);
}

function closeExpenseModal() {
  $('#modal-expense').classList.add('hidden');
  state.editingId = null;
}

// 均分並把餘數分給前面的人（避免 0.01 誤差）
function equalSplit(amount, n) {
  if (n === 0) return [];
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / n);
  const extra = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}

function updateSplitPreview() {
  const amount = Number($('#exp-amount').value) || 0;
  const rows = [...$('#split-members').children];
  const checkedRows = rows.filter((r) => r.querySelector('input[type=checkbox]').checked);

  if (splitMode === 'equal') {
    const shares = equalSplit(amount, checkedRows.length);
    rows.forEach((r) => {
      const label = r.querySelector('.split-amount-label');
      const checked = r.querySelector('input[type=checkbox]').checked;
      if (checked) {
        const idx = checkedRows.indexOf(r);
        label.textContent = fmt(shares[idx] ?? 0);
      } else {
        label.textContent = '—';
      }
    });
    $('#split-remain').classList.add('hidden');
  } else {
    let assigned = 0;
    rows.forEach((r) => {
      const checked = r.querySelector('input[type=checkbox]').checked;
      const inp = r.querySelector('.split-amount-input');
      if (checked) assigned += Number(inp.value) || 0;
    });
    const remain = Math.round((amount - assigned) * 100) / 100;
    const el = $('#split-remain');
    el.classList.remove('hidden');
    el.textContent = remain === 0
      ? '分攤金額剛好等於總金額'
      : remain > 0
        ? `還有 ${fmt(remain)} 未分配`
        : `超出總金額 ${fmt(-remain)}`;
  }
}

$('#exp-amount').addEventListener('input', updateSplitPreview);
$('#split-equal').addEventListener('click', () => setSplitMode('equal'));
$('#split-custom').addEventListener('click', () => setSplitMode('custom'));

$$('#exp-categories .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('#exp-categories .chip').forEach((c) => c.classList.toggle('active', c === chip));
  });
});

$('#btn-add-expense').addEventListener('click', () => openExpenseModal());
$('#btn-close-modal').addEventListener('click', closeExpenseModal);
$('#modal-expense').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) closeExpenseModal();
});

$('#form-expense').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = Number($('#exp-amount').value);
  const rows = [...$('#split-members').children];
  const checkedRows = rows.filter((r) => r.querySelector('input[type=checkbox]').checked);

  if (checkedRows.length === 0) return toast('請至少勾選一位分攤成員');

  let splits;
  if (splitMode === 'equal') {
    const shares = equalSplit(amount, checkedRows.length);
    splits = checkedRows.map((r, i) => ({ memberId: r.dataset.id, amount: shares[i] }));
  } else {
    splits = checkedRows
      .map((r) => ({
        memberId: r.dataset.id,
        amount: Number(r.querySelector('.split-amount-input').value) || 0,
      }))
      .filter((s) => s.amount > 0);
    if (splits.length === 0) return toast('請填寫分攤金額');
  }

  const payload = {
    payerId: $('#exp-payer').value,
    description: $('#exp-desc').value,
    amount,
    category: $('#exp-categories .chip.active')?.dataset.cat || '其他',
    expenseDate: $('#exp-date').value,
    splits,
  };

  try {
    if (state.editingId) {
      await api(`/api/groups/${state.groupId}/expenses/${state.editingId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast('支出已更新');
    } else {
      await api(`/api/groups/${state.groupId}/expenses`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast('支出已新增');
    }
    closeExpenseModal();
    refresh();
  } catch (e) { toast(e.message); }
});

/* ===== 初始化 ===== */
(async function init() {
  try {
    const me = await api('/api/me');
    state.groupId = me.groupId;
    state.memberId = me.memberId;
    await refresh();
    state.pollTimer = setInterval(() => refresh().catch(() => {}), 15000);
  } catch (e) {
    toast(e.message);
  }
})();
