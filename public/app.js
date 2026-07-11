/* ===== 狀態 ===== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const TRANSFER_CATS = ['還款', '轉帳']; // 成員間資金移動的保留類別（不計入消費統計）

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
  tag: svgWrap('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'),
  clip: svgWrap('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
};

// 類別的圖示與顏色：預設類別有專屬圖示；自訂類別用 tag 圖示、依名稱雜湊配色
function catMeta(cat) {
  if (TRANSFER_CATS.includes(cat)) return { icon: 'transfer', color: 'cat-transfer' };
  const c = state.data?.categories?.find((x) => x.name === cat);
  const icon = c?.icon || 'other';
  if (icon !== 'tag') return { icon, color: `cat-${icon}` };
  let h = 0;
  for (const ch of cat) h = (h * 31 + ch.codePointAt(0)) % 6;
  return { icon: 'tag', color: `cat-h${h}` };
}

function catIcon(cat, cls = 'expense-icon') {
  const m = catMeta(cat);
  return `<span class="${cls} ${m.color}">${ICONS[m.icon] || ICONS.other}</span>`;
}

let state = {
  groupId: null,
  memberId: null,
  data: null,          // 伺服器回傳的帳本資料
  filterText: '',
  filterCat: '全部',
  statsFrom: '',       // 統計起始日（'' = 不限）
  statsTo: '',         // 統計結束日（'' = 不限）
  editingId: null,     // 正在編輯的紀錄 id（null = 新增）
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

// 以本地時區取得今天日期（toISOString 是 UTC，凌晨會差一天）
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

const isTransfer = (e) => TRANSFER_CATS.includes(e.category);
const isIncome = (e) => e.kind === 'income';
const isSpend = (e) => !isIncome(e) && !isTransfer(e);

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function refresh() {
  if (!state.groupId) return;
  state.data = await api(`/api/groups/${state.groupId}`);
  renderAll();
}

/* ===== 渲染 ===== */
function renderAll() {
  const { group, members, expenses, balances, settlements, total } = state.data;

  $('#group-name').textContent = group.name;
  document.title = `${group.name} — 分帳小工具`;

  // 摘要列：整本帳的總支出／總收入／淨額（一趟旅行一本帳，不以月份切分）
  const { totalIncome } = state.data;
  const net = Math.round((totalIncome - total) * 100) / 100;
  $('#total-amount').textContent = fmt(total);
  $('#total-income').textContent = fmt(totalIncome);
  const netEl = $('#net-amount');
  netEl.textContent = (net > 0 ? '+' : '') + fmt(net);
  netEl.className = 'stat-value ' + (net > 0.005 ? 'positive' : net < -0.005 ? 'negative' : '');

  renderFilterChips();
  renderExpenses();
  renderBalances(members, balances);
  renderSettlements(settlements);
  renderStats();
}

/* ===== 支出列表（含搜尋 / 分類篩選） ===== */
function matchesFilter(e) {
  if (state.filterCat !== '全部' && e.category !== state.filterCat) return false;
  const q = state.filterText.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    e.description,
    e.note || '',
    memberName(e.payer_id),
    ...e.splits.map((s) => memberName(s.member_id)),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function expenseItemHtml(e) {
  const names = escapeHtml(e.splits.map((s) => memberName(s.member_id)).join('、'));
  const meta = isTransfer(e)
    ? `${escapeHtml(memberName(e.payer_id))} ${e.category === '還款' ? '還款' : '匯款'}給 ${names}`
    : `${escapeHtml(memberName(e.payer_id))} ${isIncome(e) ? '收款' : '付款'}｜分攤：${names}`;
  const kindCls = isIncome(e) ? ' income' : isTransfer(e) ? ' transfer' : '';
  return `
    <li class="expense-item${kindCls}" data-id="${e.id}">
      ${catIcon(e.category)}
      <div class="expense-info">
        <div class="expense-desc">${escapeHtml(e.description)}${e.receipt ? `<span class="clip-ico" title="附有單據">${ICONS.clip}</span>` : ''}</div>
        <div class="expense-meta">${meta}</div>
        ${e.note ? `<div class="expense-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <span class="expense-amount">${isIncome(e) ? '+' : ''}${fmt(e.amount)}</span>
      <button class="expense-del" title="刪除">${ICONS.trash}</button>
    </li>`;
}

function renderExpenses() {
  const expenses = state.data.expenses.filter(matchesFilter);
  const list = $('#expense-list');
  const empty = $('#expense-empty');
  empty.classList.toggle('hidden', expenses.length > 0);
  empty.textContent = state.data.expenses.length === 0
    ? '還沒有任何紀錄，點右下角「＋」新增第一筆吧！'
    : '沒有符合條件的紀錄';

  // 依日期分組
  const days = [];
  for (const e of expenses) {
    const last = days[days.length - 1];
    if (!last || last.date !== e.expense_date) days.push({ date: e.expense_date, items: [e] });
    else last.items.push(e);
  }

  list.innerHTML = days.map((day) => {
    const dayTotal = day.items.reduce((s, e) => (isSpend(e) ? s + e.amount : s), 0);
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

    item.addEventListener('click', () => openExpenseModal(expense));
  });
}

/* ===== 結算 ===== */
function renderBalances(members, balances) {
  $('#balance-list').innerHTML = members.map((m) => {
    const bal = balances[m.id] ?? 0;
    // 公帳的負結餘代表「還握有大家的錢」，改以餘額呈現
    if (m.is_fund) {
      const held = Math.round(-bal * 100) / 100;
      const cls = held > 0.01 ? 'positive' : held < -0.01 ? 'negative' : 'zero';
      return `
      <li>
        <span class="member-name-row">${escapeHtml(m.name)}</span>
        <span class="balance-amount ${cls}">${held < -0.01 ? '透支' : '餘額'} ${fmt(Math.abs(held))}</span>
      </li>`;
    }
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
  $('#settlement-list').innerHTML = settlements.map((s) => `
    <li>
      ${escapeHtml(memberName(s.from))}
      <span class="settle-arrow">→</span>
      ${escapeHtml(memberName(s.to))}
      <span class="settle-amount">${fmt(s.amount)}</span>
    </li>`).join('');
}

/* ===== 統計（以天為單位的日期區間） ===== */
function inStatsRange(e) {
  if (state.statsFrom && e.expense_date < state.statsFrom) return false;
  if (state.statsTo && e.expense_date > state.statsTo) return false;
  return true;
}

function renderStats() {
  const inRange = state.data.expenses.filter(inStatsRange);
  const filtered = inRange.filter(isSpend);
  const incomes = inRange.filter(isIncome);

  const total = filtered.reduce((s, e) => s + e.amount, 0);
  const totalIncome = incomes.reduce((s, e) => s + e.amount, 0);
  const net = Math.round((totalIncome - total) * 100) / 100;
  $('#stat-total').textContent = fmt(total);
  $('#stat-income').textContent = fmt(totalIncome);
  const netEl = $('#stat-net');
  netEl.textContent = (net > 0 ? '+' : '') + fmt(net);
  netEl.className = 'stat-value ' + (net > 0.005 ? 'positive' : net < -0.005 ? 'negative' : '');

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
  // 公帳沒付過錢就不佔一行
  const statMembers = members.filter((m) => !m.is_fund || paid[m.id]);
  const maxPaid = Math.max(...statMembers.map((m) => paid[m.id] || 0), 1);
  $('#member-stats').innerHTML = statMembers.map((m) => {
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

/* ===== 分類 chips（清單來自帳本資料，可自訂新增） ===== */
const chipHtml = (cat, active) =>
  `<button type="button" class="chip${active ? ' active' : ''}" data-cat="${escapeHtml(cat)}"><span>${escapeHtml(cat)}</span></button>`;

function renderFilterChips() {
  // 只有實際出現過的轉帳類別才顯示快篩 chip
  const extras = TRANSFER_CATS.filter((c) => state.data.expenses.some((e) => e.category === c));
  const names = ['全部', ...state.data.categories.map((c) => c.name), ...extras];
  const row = $('#filter-cats');
  if (row.dataset.cats === names.join('|')) return; // 類別沒變就不重建
  row.dataset.cats = names.join('|');
  if (!names.includes(state.filterCat)) state.filterCat = '全部';
  row.innerHTML = names.map((c) => chipHtml(c, c === state.filterCat)).join('');
  row.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      state.filterCat = chip.dataset.cat;
      renderExpenses();
    });
  });
}

function renderModalCats(selected) {
  const row = $('#exp-categories');
  row.innerHTML = state.data.categories.map((c) => chipHtml(c.name, c.name === selected)).join('')
    + '<button type="button" class="chip chip-add"><span>＋ 新類別</span></button>';
  row.querySelectorAll('.chip:not(.chip-add)').forEach((chip) => {
    chip.addEventListener('click', () => {
      row.querySelectorAll('.chip:not(.chip-add)').forEach((c) => c.classList.toggle('active', c === chip));
    });
  });
  row.querySelector('.chip-add').addEventListener('click', async () => {
    const name = prompt('新類別名稱（最多 10 字）：')?.trim();
    if (!name) return;
    try {
      await api(`/api/groups/${state.groupId}/categories`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await refresh();
      renderModalCats(name); // 重建並選中新類別
      toast('類別已新增');
    } catch (e) { toast(e.message); }
  });
}

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

/* ===== 統計操作 ===== */
function setStatsRange(from, to) {
  state.statsFrom = from;
  state.statsTo = to;
  $('#stats-from').value = from;
  $('#stats-to').value = to;
  renderStats();
}

$$('#stats-presets .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('#stats-presets .chip').forEach((c) => c.classList.toggle('active', c === chip));
    const r = chip.dataset.range;
    const today = todayLocal();
    if (r === 'all') setStatsRange('', '');
    else if (r === 'month') setStatsRange(today.slice(0, 8) + '01', today);
    else setStatsRange(addDays(today, -(Number(r) - 1)), today);
  });
});

for (const id of ['stats-from', 'stats-to']) {
  $(`#${id}`).addEventListener('change', (ev) => {
    state[id === 'stats-from' ? 'statsFrom' : 'statsTo'] = ev.target.value;
    $$('#stats-presets .chip').forEach((c) => c.classList.remove('active'));
    renderStats();
  });
}

$('#btn-export').addEventListener('click', () => {
  location.href = `/api/groups/${state.groupId}/export`;
});

/* ===== 新增 / 編輯支出 Modal ===== */
let splitMode = 'equal';
let expenseKind = 'expense';
let transferCat = '轉帳'; // 編輯舊「還款」紀錄時保留原類別

function setKind(kind) {
  expenseKind = kind;
  const isTr = kind === 'transfer';
  $('#kind-expense').classList.toggle('active', kind === 'expense');
  $('#kind-income').classList.toggle('active', kind === 'income');
  $('#kind-transfer').classList.toggle('active', isTr);
  $('#label-payer').firstChild.textContent =
    isTr ? '匯款人' : kind === 'income' ? '收款人' : '付款人';
  $('#modal-title').textContent = (state.editingId ? '編輯' : '新增') +
    (isTr ? '轉帳' : kind === 'income' ? '收入' : '支出');

  // 轉帳模式：隱藏分類與分攤，改成選收款對象；說明改為選填
  $('#label-cats').classList.toggle('hidden', isTr);
  $('#exp-categories').classList.toggle('hidden', isTr);
  $('.split-header').classList.toggle('hidden', isTr);
  $('#label-transfer-to').classList.toggle('hidden', !isTr);
  $('#exp-desc').required = !isTr;
  $('#exp-desc').placeholder = isTr ? '選填，例如：訂房代墊、儲值公帳' : '例如：晚餐、車票';
  if (isTr) {
    $('#split-members').classList.add('hidden');
    $('#split-toolbar').classList.add('hidden');
    $('#split-remain').classList.add('hidden');
    renderTransferTargets();
  } else {
    setSplitMode(splitMode); // 恢復分攤區塊的顯示狀態
  }
}

$('#kind-expense').addEventListener('click', () => setKind('expense'));
$('#kind-income').addEventListener('click', () => setKind('income'));
$('#kind-transfer').addEventListener('click', () => setKind('transfer'));

// 收款對象：所有成員（公帳排最前面），排除目前的匯款人
function renderTransferTargets(selected) {
  const sel = $('#exp-transfer-to');
  const prev = selected ?? sel.value;
  const payerId = $('#exp-payer').value;
  const targets = state.data.members
    .filter((m) => m.id !== payerId)
    .sort((a, b) => (b.is_fund ? 1 : 0) - (a.is_fund ? 1 : 0));
  sel.innerHTML = targets.map((m) =>
    `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  if (targets.some((m) => m.id === prev)) sel.value = prev;
}

$('#exp-payer').addEventListener('change', () => {
  if (expenseKind === 'transfer') renderTransferTargets();
});

function setSplitMode(mode) {
  splitMode = mode;
  $('#split-equal').classList.toggle('active', mode === 'equal');
  $('#split-custom').classList.toggle('active', mode === 'custom');
  $('#split-none').classList.toggle('active', mode === 'none');
  $('#split-members').classList.toggle('hidden', mode === 'none');
  $('#split-toolbar').classList.toggle('hidden', mode === 'none');
  $$('#split-members .split-amount-input').forEach((i) => i.classList.toggle('hidden', mode !== 'custom'));
  $$('#split-members .split-amount-label').forEach((l) => l.classList.toggle('hidden', mode === 'custom'));
  updateSplitPreview();
}

function openExpenseModal(expense = null) {
  const { members } = state.data;
  state.editingId = expense?.id || null;

  $('#form-expense').reset();
  $('#exp-desc').value = expense?.description || '';
  $('#exp-amount').value = expense ? expense.amount : '';
  $('#exp-date').value = expense?.expense_date || todayLocal();
  $('#exp-note').value = expense?.note || '';

  const editingTransfer = !!expense && isTransfer(expense);
  transferCat = editingTransfer ? expense.category : '轉帳';

  renderModalCats(!expense || editingTransfer
    ? state.data.categories[0]?.name
    : expense.category);

  $('#exp-payer').innerHTML = members.map((m) =>
    `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  $('#exp-payer').value = expense?.payer_id || state.memberId;

  // 分攤名單不含公帳（公帳的錢進出用「轉帳」或當付款人）
  const splitMembers = members.filter((m) => !m.is_fund);
  const splitMap = new Map((expense?.splits || []).map((s) => [s.member_id, s.amount]));
  $('#split-members').innerHTML = splitMembers.map((m) => `
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

  // 編輯時判斷原本是不分攤、均分還是自訂
  let mode = 'equal';
  if (expense && !editingTransfer) {
    const isSelfOnly = expense.splits.length === 1
      && expense.splits[0].member_id === expense.payer_id
      && Math.abs(expense.splits[0].amount - expense.amount) < 0.011;
    if (isSelfOnly) {
      mode = 'none';
    } else {
      const checkedIds = splitMembers.filter((m) => splitMap.has(m.id)).map((m) => m.id);
      const shares = equalSplit(expense.amount, checkedIds.length);
      const isEqual = checkedIds.every((id, i) => Math.abs(splitMap.get(id) - shares[i]) < 0.011);
      mode = isEqual ? 'equal' : 'custom';
    }
  }
  setSplitMode(mode);

  // kind 要等付款人與分攤名單就緒後再設（轉帳模式會依付款人組出收款對象）
  setKind(editingTransfer ? 'transfer' : expense?.kind === 'income' ? 'income' : 'expense');
  if (editingTransfer) renderTransferTargets(expense.splits[0]?.member_id);

  // 單據與刪除鈕
  receiptState = { pending: null, existing: expense?.receipt || null, removed: false };
  $('#exp-receipt-file').value = '';
  renderReceiptUI();
  $('#btn-delete-expense').classList.toggle('hidden', !expense);

  $('#modal-expense').classList.remove('hidden');
  setTimeout(() => $('#exp-desc').focus(), 50);
}

function closeExpenseModal() {
  $('#modal-expense').classList.add('hidden');
  state.editingId = null;
}

/* ===== 單據照片 ===== */
let receiptState = { pending: null, existing: null, removed: false };

function renderReceiptUI() {
  const thumb = $('#receipt-thumb');
  const hasImage = !!receiptState.pending || (!!receiptState.existing && !receiptState.removed);
  thumb.classList.toggle('hidden', !hasImage);
  if (receiptState.pending) thumb.src = receiptState.pending;
  else if (receiptState.existing && !receiptState.removed) thumb.src = `/uploads/${receiptState.existing}`;
  else thumb.removeAttribute('src');
  $('#btn-receipt-pick').textContent = hasImage ? '更換單據' : '附上單據照片';
  $('#btn-receipt-view').classList.toggle('hidden',
    !(receiptState.existing && !receiptState.removed && !receiptState.pending));
  $('#btn-receipt-remove').classList.toggle('hidden', !hasImage);
}

// 縮到最長邊 1600px 的 JPEG，避免上傳原始大圖
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取這張圖片'));
    };
    img.src = url;
  });
}

$('#btn-receipt-pick').addEventListener('click', () => $('#exp-receipt-file').click());

$('#exp-receipt-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    receiptState.pending = await compressImage(file);
    receiptState.removed = false;
    renderReceiptUI();
  } catch (e) { toast(e.message); }
  ev.target.value = '';
});

$('#btn-receipt-view').addEventListener('click', () => {
  if (receiptState.existing) window.open(`/uploads/${receiptState.existing}`, '_blank');
});

$('#btn-receipt-remove').addEventListener('click', () => {
  receiptState.pending = null;
  receiptState.removed = !!receiptState.existing;
  renderReceiptUI();
});

$('#btn-delete-expense').addEventListener('click', async () => {
  if (!state.editingId) return;
  const exp = state.data.expenses.find((e) => e.id === state.editingId);
  if (!confirm(`確定刪除「${exp?.description ?? '這筆支出'}」？`)) return;
  try {
    await api(`/api/groups/${state.groupId}/expenses/${state.editingId}`, { method: 'DELETE' });
    closeExpenseModal();
    toast('已刪除');
    refresh();
  } catch (e) { toast(e.message); }
});

// 均分並把餘數分給前面的人（避免 0.01 誤差）
function equalSplit(amount, n) {
  if (n === 0) return [];
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / n);
  const extra = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}

function updateSplitToggleAll() {
  const boxes = [...$$('#split-members input[type=checkbox]')];
  $('#split-toggle-all').textContent =
    boxes.length && boxes.every((b) => b.checked) ? '全不選' : '全選';
}

$('#split-toggle-all').addEventListener('click', () => {
  const boxes = [...$$('#split-members input[type=checkbox]')];
  const allChecked = boxes.length && boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
  updateSplitPreview();
});

function updateSplitPreview() {
  if (expenseKind === 'transfer') return;
  updateSplitToggleAll();
  if (splitMode === 'none') {
    const el = $('#split-remain');
    el.classList.remove('hidden');
    el.textContent = expenseKind === 'income'
      ? '這筆屬於收款人自己，不會影響任何人的結餘'
      : '這筆由付款人自行承擔，不會影響任何人的結餘';
    return;
  }
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
$('#split-none').addEventListener('click', () => setSplitMode('none'));

$('#btn-add-expense').addEventListener('click', () => openExpenseModal());
$('#btn-close-modal').addEventListener('click', closeExpenseModal);
$('#modal-expense').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) closeExpenseModal();
});

$('#form-expense').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = Number($('#exp-amount').value);
  let payload;

  if (expenseKind === 'transfer') {
    const to = $('#exp-transfer-to').value;
    if (!to) return toast('請選擇收款對象');
    const toMember = state.data.members.find((m) => m.id === to);
    payload = {
      payerId: $('#exp-payer').value,
      description: $('#exp-desc').value.trim()
        || (toMember?.is_fund ? '存入公帳' : `匯款給 ${toMember?.name ?? '?'}`),
      amount,
      kind: 'expense',
      category: transferCat,
      expenseDate: $('#exp-date').value,
      note: $('#exp-note').value,
      splits: [{ memberId: to, amount }],
    };
  } else {
    const rows = [...$('#split-members').children];
    const checkedRows = rows.filter((r) => r.querySelector('input[type=checkbox]').checked);

    if (splitMode !== 'none' && checkedRows.length === 0) return toast('請至少勾選一位分攤成員');

    let splits;
    if (splitMode === 'none') {
      // 不分攤：整筆由付款人自行承擔，不影響任何人的結餘
      splits = [{ memberId: $('#exp-payer').value, amount }];
    } else if (splitMode === 'equal') {
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

    payload = {
      payerId: $('#exp-payer').value,
      description: $('#exp-desc').value,
      amount,
      kind: expenseKind,
      category: $('#exp-categories .chip.active')?.dataset.cat || '其他',
      expenseDate: $('#exp-date').value,
      note: $('#exp-note').value,
      splits,
    };
  }

  try {
    const isEdit = !!state.editingId;
    let expenseId = state.editingId;
    if (isEdit) {
      await api(`/api/groups/${state.groupId}/expenses/${expenseId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      expenseId = (await api(`/api/groups/${state.groupId}/expenses`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })).expenseId;
    }

    // 單據：有新照片就上傳（會自動替換舊的），被移除就刪掉
    if (receiptState.pending) {
      await api(`/api/groups/${state.groupId}/expenses/${expenseId}/receipt`, {
        method: 'POST',
        body: JSON.stringify({ dataUrl: receiptState.pending }),
      });
    } else if (receiptState.removed && receiptState.existing) {
      await api(`/api/groups/${state.groupId}/expenses/${expenseId}/receipt`, { method: 'DELETE' });
    }

    toast(isEdit ? '已更新' : '已新增');
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
