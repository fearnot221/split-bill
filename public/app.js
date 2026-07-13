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
  filterKind: 'all',
  statsFrom: '',       // 統計起始日（'' = 不限）
  statsTo: '',         // 統計結束日（'' = 不限）
  editingId: null,     // 正在編輯的紀錄 id（null = 新增）
  editingVersion: null,
  pollTimer: null,
  refreshSeq: 0,
  aiStatus: null,
};

let smartReceiptDataUrl = null;
let smartReceiptName = '';
let smartAnalyzing = false;
let aiDraftActive = false;
let aiDraftConsumesSmartEntry = false;
let smartPersistTimer = null;
let smartDraftRestored = false;
let smartDbPromise = null;
let smartSpeechRecognition = null;
let smartAnalyzeController = null;
let smartReceiptTask = null;
let smartReceiptSequence = 0;
let cachedSafetySessionId = null;

/* ===== 工具 ===== */
function fmt(n) {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs)
    ? abs.toLocaleString()
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const configured = state.data?.group?.currency || 'NT$';
  const currency = /^[A-Za-z$€£¥₩₹₫₱฿₽₺₪₴₦₲₡₭₮₵₸]{1,5}$/u.test(configured)
    ? configured
    : 'NT$';
  return (n < 0 ? `-${currency}` : currency) + s;
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
  el.classList.remove('hidden', 'toast-out');
  clearTimeout(el._t);
  clearTimeout(el._t2);
  el._t = setTimeout(() => {
    el.classList.add('toast-out');
    el._t2 = setTimeout(() => el.classList.add('hidden'), 220);
  }, 2200);
}

// 數字滾動：從目前值補間到新值（約 0.4 秒）
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateNumber(el, target, prefix = '') {
  const from = el._num ?? 0;
  el._num = target;
  const render = (value) => (prefix && value > 0 ? prefix : '') + fmt(value);
  if (from === target || REDUCED_MOTION) { el.textContent = render(target); return; }
  cancelAnimationFrame(el._raf);
  const start = performance.now();
  const dur = 400;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const v = Math.round((from + (target - from) * eased) * 100) / 100;
    el.textContent = render(v);
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// 長條圖從 0 長到目標寬度（重繪後下一影格再套用寬度）
function animateBars(container, selector = '.bar-fill') {
  const fills = container.querySelectorAll(selector);
  fills.forEach((f) => {
    const w = f.style.width;
    f.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { f.style.width = w; }));
  });
}

async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const error = new Error('已取消分析');
      error.cancelled = true;
      error.status = 0;
      throw error;
    }
    const message = navigator.onLine === false
      ? '目前處於離線狀態，請確認網路後重試'
      : '無法連線到帳本，請稍後重試';
    const error = new Error(message);
    error.cause = cause;
    error.status = 0;
    throw error;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || '發生錯誤，請稍後再試');
    error.status = res.status;
    throw error;
  }
  return body;
}

function showConnectionStatus(message) {
  $('#connection-message').textContent = message;
  $('#connection-status').classList.remove('hidden');
}

function clearConnectionStatus() {
  $('#connection-status').classList.add('hidden');
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
const isIncome = (e) => e.kind === 'income' && !isTransfer(e);
const isSpend = (e) => !isIncome(e) && !isTransfer(e);

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function canPoll() {
  return !document.hidden && $('#modal-expense').classList.contains('hidden');
}

async function refresh({ poll = false } = {}) {
  if (!state.groupId) return;
  if (poll && !canPoll()) return;

  const seq = ++state.refreshSeq;
  try {
    const data = await api(`/api/groups/${state.groupId}`);
    if (seq !== state.refreshSeq || (poll && !canPoll())) return;

    state.data = data;
    clearConnectionStatus();
    renderAll();
  } catch (error) {
    if (seq === state.refreshSeq) showConnectionStatus(error.message);
    throw error;
  }
}

/* ===== 渲染 ===== */
function renderAll() {
  const { group, members, expenses, balances, settlements, total } = state.data;

  $('#group-name').textContent = group.name;
  const exampleMembers = members
    .filter((member) => !member.is_fund && member.id !== state.memberId)
    .slice(0, 2)
    .map((member) => member.name);
  $('#smart-input').placeholder = exampleMembers.length
    ? `例如：昨天晚餐 1,280，我付，我跟${exampleMembers.join('、')}均分`
    : '例如：昨天晚餐 320，我付，不分攤';
  document.title = `${group.name} — 分帳小工具`;

  // 摘要列：整本帳的總支出／總收入／淨額（一趟旅行一本帳，不以月份切分）
  const { totalIncome } = state.data;
  const net = Math.round((totalIncome - total) * 100) / 100;
  animateNumber($('#total-amount'), total);
  animateNumber($('#total-income'), totalIncome);
  const netEl = $('#net-amount');
  animateNumber(netEl, net, net > 0 ? '+' : '');
  netEl.className = 'stat-value ' + (net > 0.005 ? 'positive' : net < -0.005 ? 'negative' : '');

  renderFilterChips();
  renderExpenses();
  renderBalances(members, balances);
  renderSettlements(settlements);
  renderStats();
  renderSmartRecents(expenses);
}

/* ===== 支出列表（含搜尋 / 分類篩選） ===== */
function matchesFilter(e) {
  if (state.filterKind === 'expense' && !isSpend(e)) return false;
  if (state.filterKind === 'income' && !isIncome(e)) return false;
  if (state.filterKind === 'transfer' && !isTransfer(e)) return false;
  if (state.filterCat !== '全部' && e.category !== state.filterCat) return false;
  const q = state.filterText.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    e.description,
    e.note || '',
    e.category,
    isTransfer(e) ? '轉帳 還款' : isIncome(e) ? '收入 收款' : '支出 付款',
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
  const filtering = !!state.filterText.trim()
    || state.filterCat !== '全部'
    || state.filterKind !== 'all';
  $('#filter-summary').classList.toggle('hidden', !filtering);
  $('#filter-count').textContent = `顯示 ${expenses.length} / ${state.data.expenses.length} 筆`;

  // 依日期分組
  const days = [];
  for (const e of expenses) {
    const last = days[days.length - 1];
    if (!last || last.date !== e.expense_date) days.push({ date: e.expense_date, items: [e] });
    else last.items.push(e);
  }

  const html = days.map((day) => {
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

  if (list.dataset.sig === html) return; // 內容沒變就不重建（避免輪詢時動畫重播）
  list.dataset.sig = html;
  list.innerHTML = html;
}

// 由點擊當下的最新 state 取紀錄，避免 HTML 未重建時沿用舊資料閉包。
$('#expense-list').addEventListener('click', async (ev) => {
  const item = ev.target.closest('.expense-item');
  if (!item) return;
  const expense = state.data?.expenses.find((e) => e.id === item.dataset.id);
  if (!expense) return;

  if (ev.target.closest('.expense-del')) {
    const deleteButton = ev.target.closest('.expense-del');
    if (!confirm(`確定刪除「${expense.description}」？`)) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/groups/${state.groupId}/expenses/${expense.id}?version=${expense.version}`, {
        method: 'DELETE',
      });
      try {
        await refresh();
        toast('已刪除');
      } catch {
        toast('已刪除，重新連線後會更新畫面');
      }
    } catch (e) {
      if (e.status === 409) refresh().catch(() => {});
      toast(e.message);
    } finally {
      if (deleteButton.isConnected) deleteButton.disabled = false;
    }
    return;
  }

  openExpenseModal(expense);
});

/* ===== 結算 ===== */
function renderBalances(members, balances) {
  $('#balance-list').innerHTML = members.map((m) => {
    const bal = balances[m.id] ?? 0;
    // 公帳的負結餘代表「還握有大家的錢」，改以餘額呈現
    if (m.is_fund) {
      const held = Math.round(-bal * 100) / 100;
      const cls = held > 0.005 ? 'positive' : held < -0.005 ? 'negative' : 'zero';
      return `
      <li>
        <span class="member-name-row">${escapeHtml(m.name)}</span>
        <span class="balance-amount ${cls}">${held < -0.005 ? '透支' : '餘額'} ${fmt(Math.abs(held))}</span>
      </li>`;
    }
    const cls = bal > 0.005 ? 'positive' : bal < -0.005 ? 'negative' : 'zero';
    const note = bal > 0.005 ? '應收' : bal < -0.005 ? '應付' : '結清';
    return `
      <li>
        <span class="member-name-row">${escapeHtml(m.name)}</span>
        <span class="balance-amount ${cls}">${note} ${fmt(Math.abs(bal))}</span>
      </li>`;
  }).join('');
}

function renderSettlements(settlements) {
  $('#settle-empty').classList.toggle('hidden', settlements.length > 0);
  $('#settlement-list').innerHTML = settlements.map((s, index) => `
    <li data-index="${index}">
      <div class="settle-main">
        <span class="settle-party">${escapeHtml(memberName(s.from))}</span>
        <span class="settle-arrow">→</span>
        <span class="settle-party">${escapeHtml(memberName(s.to))}</span>
        <span class="settle-amount">${fmt(s.amount)}</span>
      </div>
      <button type="button" class="settle-done" data-index="${index}">
        ${ICONS.transfer}<span>記錄轉帳</span>
      </button>
    </li>`).join('');
}

$('#settlement-list').addEventListener('click', (ev) => {
  const button = ev.target.closest('.settle-done');
  if (!button) return;
  const settlement = state.data?.settlements[Number(button.dataset.index)];
  if (!settlement) return;
  openExpenseModal();
  $('#exp-payer').value = settlement.from;
  setKind('transfer');
  renderTransferTargets(settlement.to);
  $('#exp-amount').value = settlement.amount;
  $('#exp-desc').value = '結算轉帳';
  expenseFormBaseline = expenseDraftSignature();
});

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
  animateNumber($('#stat-total'), total);
  animateNumber($('#stat-income'), totalIncome);
  const netEl = $('#stat-net');
  animateNumber(netEl, net, net > 0 ? '+' : '');
  netEl.className = 'stat-value ' + (net > 0.005 ? 'positive' : net < -0.005 ? 'negative' : '');

  $('#stats-empty').classList.toggle('hidden', filtered.length > 0);

  // 每日收支：只呈現最近 14 個有紀錄日，轉帳不計入。
  const byDate = new Map();
  for (const e of inRange) {
    if (isTransfer(e)) continue;
    const day = byDate.get(e.expense_date) || { expense: 0, income: 0 };
    if (isIncome(e)) day.income += e.amount;
    else day.expense += e.amount;
    byDate.set(e.expense_date, day);
  }
  const allDays = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right));
  const visibleDays = allDays.slice(-14);
  const dailyEmpty = visibleDays.length === 0;
  $('#daily-empty').classList.toggle('hidden', !dailyEmpty);
  $('#daily-caption').classList.toggle('hidden', allDays.length <= 14);
  $('#daily-caption').textContent = allDays.length > 14 ? '顯示最近 14 個有紀錄日' : '';
  const dailyMaximum = Math.max(
    ...visibleDays.flatMap(([, day]) => [day.expense, day.income]),
    1
  );
  $('#daily-stats').innerHTML = visibleDays.map(([date, day]) => {
    const [year, month, dateOfMonth] = date.split('-').map(Number);
    const weekday = '日一二三四五六'[new Date(year, month - 1, dateOfMonth).getDay()];
    const dateLabel = `${year === new Date().getFullYear() ? '' : `${year}/`}${month}/${dateOfMonth} 週${weekday}`;
    const net = Math.round((day.income - day.expense) * 100) / 100;
    const netClass = net > 0.005 ? 'positive' : net < -0.005 ? 'negative' : '';
    return `
      <li>
        <div class="daily-head">
          <span class="daily-date">${dateLabel}</span>
          <span class="daily-net ${netClass}">淨額 ${net > 0 ? '+' : ''}${fmt(net)}</span>
        </div>
        <div class="daily-line">
          <span class="daily-label">支</span>
          <span class="daily-track"><span class="daily-fill expense" style="width:${Math.round(day.expense / dailyMaximum * 100)}%"></span></span>
          <span class="daily-value">${fmt(day.expense)}</span>
        </div>
        <div class="daily-line">
          <span class="daily-label">收</span>
          <span class="daily-track"><span class="daily-fill income" style="width:${Math.round(day.income / dailyMaximum * 100)}%"></span></span>
          <span class="daily-value">${fmt(day.income)}</span>
        </div>
      </li>`;
  }).join('');

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

// 統計頁可見時讓長條從 0 長出（切分頁或改區間時呼叫，輪詢更新不重播）
function replayStatsBars() {
  if ($('#tab-stats').classList.contains('hidden') || REDUCED_MOTION) return;
  animateBars($('#cat-stats'));
  animateBars($('#member-stats'));
  animateBars($('#daily-stats'), '.daily-fill');
}

/* ===== 分類 chips（清單來自帳本資料，可自訂新增） ===== */
const chipHtml = (cat, active) =>
  `<button type="button" class="chip${active ? ' active' : ''}" data-cat="${escapeHtml(cat)}"
    aria-pressed="${active ? 'true' : 'false'}"><span>${escapeHtml(cat)}</span></button>`;

function renderFilterChips() {
  // 只有實際出現過的轉帳類別才顯示快篩 chip
  const extras = TRANSFER_CATS.filter((c) => state.data.expenses.some((e) => e.category === c));
  const regular = state.data.categories.map((c) => c.name);
  const categories = state.filterKind === 'transfer'
    ? extras
    : state.filterKind === 'all' ? [...regular, ...extras] : regular;
  const names = ['全部', ...categories];
  const row = $('#filter-cats');
  if (!names.includes(state.filterCat)) state.filterCat = '全部';
  const signature = JSON.stringify(names);
  if (row.dataset.cats !== signature) {
    row.dataset.cats = signature;
    row.innerHTML = names.map((c) => chipHtml(c, c === state.filterCat)).join('');
    row.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.filterCat = chip.dataset.cat;
        renderFilterChips();
        renderExpenses();
      });
    });
  }
  row.querySelectorAll('.chip').forEach((chip) => {
    const active = chip.dataset.cat === state.filterCat;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

function renderModalCats(selected) {
  const row = $('#exp-categories');
  row.innerHTML = state.data.categories.map((c) => chipHtml(c.name, c.name === selected)).join('')
    + '<button type="button" class="chip chip-add"><span>＋ 新類別</span></button>';
  row.querySelectorAll('.chip:not(.chip-add)').forEach((chip) => {
    chip.addEventListener('click', () => {
      row.querySelectorAll('.chip:not(.chip-add)').forEach((category) => {
        const active = category === chip;
        category.classList.toggle('active', active);
        category.setAttribute('aria-pressed', String(active));
      });
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
      try {
        await refresh();
        renderModalCats(name); // 重建並選中新類別
        toast('類別已新增');
      } catch {
        toast('類別已新增，重新連線後會更新畫面');
      }
    } catch (e) { toast(e.message); }
  });
}

/* ===== 分頁切換 ===== */
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach((p) => {
      const show = p.id === `tab-${tab}`;
      p.classList.toggle('hidden', !show);
      if (show) { // 重新觸發過場動畫
        p.style.animation = 'none';
        void p.offsetHeight;
        p.style.animation = '';
      }
    });
    $('#btn-add-expense').classList.toggle('hidden', tab !== 'expenses');
    if (tab === 'stats') replayStatsBars();
  });
});

/* ===== 搜尋 / 篩選 ===== */
$('#filter-text').addEventListener('input', (ev) => {
  state.filterText = ev.target.value;
  renderExpenses();
});

function syncKindFilter() {
  $$('#filter-kind .seg-btn').forEach((button) => {
    const active = button.dataset.kind === state.filterKind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

$$('#filter-kind .seg-btn').forEach((button) => {
  button.addEventListener('click', () => {
    state.filterKind = button.dataset.kind;
    state.filterCat = '全部';
    syncKindFilter();
    renderFilterChips();
    renderExpenses();
  });
});

$('#btn-clear-filters').addEventListener('click', () => {
  state.filterText = '';
  state.filterCat = '全部';
  state.filterKind = 'all';
  $('#filter-text').value = '';
  syncKindFilter();
  renderFilterChips();
  renderExpenses();
  $('#filter-text').focus();
});

/* ===== 一句記帳 ===== */
function setSmartFeedback(message, error = false) {
  const feedback = $('#smart-feedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
}

function syncSmartAnalyzeButton() {
  const hasInput = !!$('#smart-input').value.trim() || !!smartReceiptDataUrl;
  $('#btn-smart-analyze').disabled = smartAnalyzing
    ? false
    : !state.groupId || !!smartReceiptTask || !hasInput;
}

function resizeSmartInput() {
  const input = $('#smart-input');
  input.style.height = 'auto';
  const height = Math.min(input.scrollHeight, 220);
  input.style.height = `${Math.max(92, height)}px`;
  input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
}

function setSmartAnalyzing(analyzing) {
  smartAnalyzing = analyzing;
  if (analyzing && smartSpeechRecognition
    && $('#btn-smart-voice').getAttribute('aria-pressed') === 'true') {
    smartSpeechRecognition.abort();
  }
  $('#smart-entry-title').closest('.smart-entry').setAttribute('aria-busy', String(analyzing));
  $('#smart-input').disabled = analyzing;
  $('#btn-smart-receipt').disabled = analyzing;
  $('#btn-smart-voice').disabled = analyzing;
  $('#btn-smart-receipt-remove').disabled = analyzing;
  syncSmartAnalyzeButton();
  const label = $('#btn-smart-analyze span');
  label.textContent = analyzing ? '取消分析' : smartReceiptTask ? '處理單據…' : '分析帳目';
  $('#btn-smart-analyze').classList.toggle('analyzing', analyzing);
  if (analyzing) setSmartFeedback('正在整理金額、成員與分攤方式…');
}

function renderSmartReceipt() {
  const row = $('#smart-receipt');
  row.classList.toggle('hidden', !smartReceiptDataUrl);
  if (smartReceiptDataUrl) {
    $('#smart-receipt-thumb').src = smartReceiptDataUrl;
    $('#smart-receipt-name').textContent = smartReceiptName || '單據圖片';
  } else {
    $('#smart-receipt-thumb').removeAttribute('src');
    $('#smart-receipt-name').textContent = '';
  }
}

function openReceiptPreview(source) {
  if (!source) return;
  if (!source.startsWith('data:')) {
    window.open(source, '_blank', 'noopener');
    return;
  }
  const match = /^data:([^;,]+);base64,(.+)$/.exec(source);
  if (!match) return;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
    window.open(objectUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    toast('無法開啟這張單據');
  }
}

async function setSmartReceiptFile(file) {
  if (!file) return;
  if (smartAnalyzing) throw new Error('分析進行中，請先取消再更換單據');
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔案');
  if (file.size > 25 * 1024 * 1024) throw new Error('圖片過大（原始檔上限 25MB）');
  const sequence = ++smartReceiptSequence;
  const task = compressImage(file);
  smartReceiptTask = task;
  syncSmartAnalyzeButton();
  $('#btn-smart-analyze span').textContent = '處理單據…';
  setSmartFeedback('正在準備單據圖片…');
  try {
    const dataUrl = await task;
    if (sequence !== smartReceiptSequence) return;
    smartReceiptDataUrl = dataUrl;
    smartReceiptName = file.name || '貼上的單據';
    renderSmartReceipt();
    scheduleSmartDraftPersist();
    setSmartFeedback(state.aiStatus?.receiptRecognition
      ? '單據已附上，可以開始分析'
      : '單據已附上；目前只會保留圖片，尚未啟用影像辨識');
  } catch (error) {
    if (sequence === smartReceiptSequence) throw error;
  } finally {
    if (sequence === smartReceiptSequence) {
      smartReceiptTask = null;
      syncSmartAnalyzeButton();
      $('#btn-smart-analyze span').textContent = '分析帳目';
    }
  }
}

async function loadAiStatus() {
  const status = await api('/api/ai/status');
  state.aiStatus = status;
  $('#smart-mode').textContent = status.mode === 'openai' ? 'AI 單據辨識' : '基本文字解析';
  syncSmartAnalyzeButton();
  if (status.mode !== 'openai' && !$('#smart-input').value && !smartReceiptDataUrl) {
    setSmartFeedback('尚未設定 AI 金鑰，仍可使用基本文字解析');
  }
}

function clearSmartEntry() {
  $('#smart-input').value = '';
  resizeSmartInput();
  $('#smart-receipt-file').value = '';
  smartReceiptDataUrl = null;
  smartReceiptName = '';
  smartReceiptSequence += 1;
  smartReceiptTask = null;
  aiDraftActive = false;
  aiDraftConsumesSmartEntry = false;
  renderSmartReceipt();
  syncSmartAnalyzeButton();
  clearTimeout(smartPersistTimer);
  deleteSmartDraft().catch(() => {});
  setSmartFeedback('帳目已儲存');
}

function getSmartDraftDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (smartDbPromise) return smartDbPromise;
  smartDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('split-bill-local', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('smart-drafts')) {
        request.result.createObjectStore('smart-drafts');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Cannot open draft database'));
  });
  return smartDbPromise;
}

async function writeSmartDraft() {
  if (!state.groupId) return;
  const text = $('#smart-input').value;
  if (!text && !smartReceiptDataUrl) return deleteSmartDraft();
  const db = await getSmartDraftDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('smart-drafts', 'readwrite');
    transaction.objectStore('smart-drafts').put({
      text,
      receiptDataUrl: smartReceiptDataUrl,
      receiptName: smartReceiptName,
      updatedAt: new Date().toISOString(),
    }, state.groupId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Cannot save draft'));
    transaction.onabort = () => reject(transaction.error || new Error('Cannot save draft'));
  });
}

async function readSmartDraft() {
  if (!state.groupId) return null;
  const db = await getSmartDraftDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('smart-drafts').objectStore('smart-drafts').get(state.groupId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Cannot read draft'));
  });
}

async function deleteSmartDraft() {
  if (!state.groupId || !('indexedDB' in window)) return;
  const db = await getSmartDraftDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('smart-drafts', 'readwrite');
    transaction.objectStore('smart-drafts').delete(state.groupId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Cannot delete draft'));
  });
}

function scheduleSmartDraftPersist() {
  clearTimeout(smartPersistTimer);
  smartPersistTimer = setTimeout(() => writeSmartDraft().catch(() => {}), 250);
}

async function restoreSmartDraft() {
  if (smartDraftRestored) return;
  smartDraftRestored = true;
  try {
    const draft = await readSmartDraft();
    if (!draft || $('#smart-input').value || smartReceiptDataUrl) return;
    $('#smart-input').value = typeof draft.text === 'string' ? draft.text : '';
    resizeSmartInput();
    smartReceiptDataUrl = typeof draft.receiptDataUrl === 'string' ? draft.receiptDataUrl : null;
    smartReceiptName = typeof draft.receiptName === 'string' ? draft.receiptName : '';
    renderSmartReceipt();
    syncSmartAnalyzeButton();
    setSmartFeedback('已復原尚未儲存的記帳草稿');
  } catch {}
}

function setupSmartSpeechInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  const button = $('#btn-smart-voice');
  button.classList.remove('hidden');
  const recognition = new SpeechRecognition();
  smartSpeechRecognition = recognition;
  recognition.lang = 'zh-TW';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => {
    button.setAttribute('aria-pressed', 'true');
    setSmartFeedback('正在聽取記帳內容…');
  };
  recognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText) {
      const input = $('#smart-input');
      input.value = `${input.value}${input.value.trim() ? '。' : ''}${finalText}`;
      resizeSmartInput();
      scheduleSmartDraftPersist();
    }
    if (interimText) setSmartFeedback(`聽到：${interimText}`);
  };
  recognition.onerror = (event) => {
    const message = event.error === 'not-allowed'
      ? '麥克風權限未開啟'
      : event.error === 'no-speech' ? '沒有聽到語音，請再試一次' : '語音辨識失敗';
    setSmartFeedback(message, true);
  };
  recognition.onend = () => button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') recognition.stop();
    else {
      try { recognition.start(); } catch {}
    }
  });
}

function buildRepeatDraft(expense) {
  const splits = expense.splits || [];
  const selfOnly = splits.length === 1
    && splits[0].member_id === expense.payer_id
    && Math.abs(splits[0].amount - expense.amount) < 0.011;
  const shares = equalSplit(expense.amount, splits.length);
  const equal = splits.length > 0
    && splits.every((split, index) => Math.abs(split.amount - shares[index]) < 0.011);
  const splitMode = selfOnly ? 'none' : equal ? 'equal' : splits.length ? 'custom' : 'none';
  return {
    isLedgerEntry: true,
    ready: true,
    kind: isIncome(expense) ? 'income' : 'expense',
    description: expense.description,
    amount: expense.amount,
    category: expense.category,
    expenseDate: todayLocal(),
    payerId: expense.payer_id,
    payerName: memberName(expense.payer_id),
    participantIds: splits.map((split) => split.member_id),
    participantNames: splits.map((split) => memberName(split.member_id)),
    splitMode,
    customSplits: splitMode === 'custom'
      ? splits.map((split) => ({
        memberId: split.member_id,
        memberName: memberName(split.member_id),
        amount: split.amount,
      }))
      : [],
    transferToId: null,
    transferToName: null,
    note: null,
    confidence: 1,
    warnings: [],
  };
}

function renderSmartRecents(expenses) {
  const recent = [];
  const seen = new Set();
  for (const expense of expenses) {
    if (isTransfer(expense)) continue;
    const key = `${expense.kind}\u0000${expense.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(expense);
    if (recent.length === 3) break;
  }
  $('#smart-recents').classList.toggle('hidden', recent.length === 0);
  const list = $('#smart-recent-list');
  const signature = JSON.stringify(recent.map((expense) => [expense.id, expense.version]));
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.innerHTML = recent.map((expense) => `
    <button type="button" class="pill-btn smart-recent" data-id="${expense.id}"
      title="再記一筆 ${escapeHtml(expense.description)}">↻ ${escapeHtml(expense.description)}</button>
  `).join('');
}

$('#smart-recent-list').addEventListener('click', (ev) => {
  const button = ev.target.closest('.smart-recent');
  if (!button) return;
  const expense = state.data?.expenses.find((item) => item.id === button.dataset.id);
  if (!expense) return;
  applyAiDraft({ provider: 'recent', model: null, draft: buildRepeatDraft(expense), notices: [] });
  setSmartFeedback('已帶入最近紀錄，請確認後儲存');
});

function showAiReview(result) {
  const { draft } = result;
  const title = result.provider === 'openai'
    ? `AI 草稿 · 信心 ${Math.round(draft.confidence * 100)}%`
    : result.provider === 'recent' ? '最近紀錄' : '基本文字草稿';
  $('#ai-review-title').textContent = `${title}，儲存前請確認`;
  const warnings = [...(result.notices || []), ...(draft.warnings || [])];
  const list = $('#ai-review-warnings');
  list.replaceChildren(...warnings.map((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    return item;
  }));
  list.classList.toggle('hidden', warnings.length === 0);
  const review = $('#ai-review');
  review.classList.toggle('notice', (result.notices || []).length > 0);
  review.classList.toggle('needs-attention', (draft.warnings || []).length > 0 || !draft.ready);
  review.classList.remove('hidden');
}

function aiDraftFocusTarget(draft) {
  if (!draft.description) return $('#exp-desc');
  if (!draft.amount) return $('#exp-amount');
  if (draft.kind === 'transfer' && !draft.transferToId) return $('#exp-transfer-to');
  const warnings = (draft.warnings || []).join(' ');
  if (/信心較低/.test(warnings)) return $('#exp-desc');
  if (/日期/.test(warnings)) return $('#exp-date');
  if (/(分攤|成員)/.test(warnings) && draft.kind !== 'transfer') return $('#split-equal');
  if (/(付款|收款)人/.test(warnings)) return $('#exp-payer');
  if (/分類/.test(warnings)) return $('#exp-categories .chip') || $('#exp-desc');
  return $('.modal-actions button[type="submit"]');
}

function applyAiDraft(result) {
  const { draft } = result;
  openExpenseModal();
  aiDraftActive = true;
  aiDraftConsumesSmartEntry = result.provider !== 'recent';
  modalReturnFocus = $('#smart-input');
  expenseSubmitLabel = '確認並儲存';
  $('.modal-actions button[type="submit"]').textContent = expenseSubmitLabel;

  $('#exp-desc').value = draft.description || '';
  $('#exp-amount').value = draft.amount ?? '';
  $('#exp-date').value = draft.expenseDate || todayLocal();
  $('#exp-note').value = draft.note || '';
  if (draft.payerId
    && [...$('#exp-payer').options].some((option) => option.value === draft.payerId)) {
    $('#exp-payer').value = draft.payerId;
  }

  if (draft.kind === 'transfer') {
    setKind('transfer');
    renderTransferTargets(draft.transferToId);
  } else {
    renderModalCats(draft.category);
    setKind(draft.kind === 'income' ? 'income' : 'expense');
    const participants = new Set(draft.participantIds || []);
    const custom = new Map((draft.customSplits || []).map((split) => [split.memberId, split.amount]));
    $$('#split-members > li').forEach((row) => {
      row.querySelector('input[type="checkbox"]').checked = participants.has(row.dataset.id);
      row.querySelector('.split-amount-input').value = custom.get(row.dataset.id) ?? '';
    });
    setSplitMode(draft.splitMode || 'equal');
    updateSplitPreview();
  }

  if (smartReceiptDataUrl) {
    receiptState.pending = smartReceiptDataUrl;
    receiptState.removed = false;
    renderReceiptUI();
  }
  showAiReview(result);
  setSmartFeedback('草稿已建立，請確認後儲存');
  clearTimeout(modalFocusTimer);
  const focusTarget = aiDraftFocusTarget(draft);
  modalFocusTimer = setTimeout(() => focusTarget.focus(), 50);
}

async function analyzeSmartEntry() {
  if (smartAnalyzing) {
    smartAnalyzeController?.abort();
    return;
  }
  if (smartReceiptTask) {
    setSmartFeedback('正在準備單據圖片…');
    try {
      await smartReceiptTask;
    } catch (error) {
      setSmartFeedback(error.message, true);
      return;
    }
  }
  const text = $('#smart-input').value.trim();
  if (!text && !smartReceiptDataUrl) {
    setSmartFeedback('請輸入記帳內容或附上單據', true);
    $('#smart-input').focus();
    return;
  }
  smartAnalyzeController = new AbortController();
  setSmartAnalyzing(true);
  try {
    const result = await api(`/api/groups/${state.groupId}/ai/parse`, {
      method: 'POST',
      signal: smartAnalyzeController.signal,
      body: JSON.stringify({
        text,
        receiptDataUrl: smartReceiptDataUrl,
        defaultMemberId: state.memberId,
        localDate: todayLocal(),
        safetySessionId: safetySessionId(),
      }),
    });
    if (!result.draft?.isLedgerEntry) {
      const message = result.draft?.warnings?.[0] || '無法從這段內容建立帳目';
      setSmartFeedback(message, true);
      return;
    }
    applyAiDraft(result);
  } catch (error) {
    setSmartFeedback(error.message, !error.cancelled);
  } finally {
    smartAnalyzeController = null;
    setSmartAnalyzing(false);
  }
}

$('#btn-smart-receipt').addEventListener('click', () => $('#smart-receipt-file').click());
$('#smart-receipt-file').addEventListener('change', async (ev) => {
  try { await setSmartReceiptFile(ev.target.files[0]); } catch (error) {
    setSmartFeedback(error.message, true);
  }
  ev.target.value = '';
});
$('#btn-smart-receipt-remove').addEventListener('click', () => {
  smartReceiptSequence += 1;
  smartReceiptTask = null;
  smartReceiptDataUrl = null;
  smartReceiptName = '';
  syncSmartAnalyzeButton();
  $('#btn-smart-analyze span').textContent = '分析帳目';
  renderSmartReceipt();
  scheduleSmartDraftPersist();
  setSmartFeedback('');
});
$('#btn-smart-receipt-view').addEventListener('click', () => {
  openReceiptPreview(smartReceiptDataUrl);
});
$('#btn-smart-analyze').addEventListener('click', analyzeSmartEntry);
$('#smart-input').addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault();
    analyzeSmartEntry();
  }
});
$('#smart-input').addEventListener('input', () => {
  resizeSmartInput();
  syncSmartAnalyzeButton();
  scheduleSmartDraftPersist();
});
$('#smart-input').addEventListener('paste', (ev) => {
  const image = [...(ev.clipboardData?.files || [])].find((file) => file.type.startsWith('image/'));
  if (image) setSmartReceiptFile(image).catch((error) => setSmartFeedback(error.message, true));
});
const smartEntry = $('#smart-entry-title').closest('.smart-entry');
smartEntry.addEventListener('dragover', (ev) => {
  if (smartAnalyzing) return;
  if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
  smartEntry.classList.add('dragging');
});
smartEntry.addEventListener('dragleave', (ev) => {
  if (!smartEntry.contains(ev.relatedTarget)) smartEntry.classList.remove('dragging');
});
smartEntry.addEventListener('drop', (ev) => {
  smartEntry.classList.remove('dragging');
  if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
  ev.preventDefault();
  if (smartAnalyzing) {
    setSmartFeedback('分析進行中，請先取消再更換單據', true);
    return;
  }
  const image = [...(ev.dataTransfer?.files || [])].find((file) => file.type.startsWith('image/'));
  if (!image) {
    setSmartFeedback('請拖入圖片格式的單據', true);
    return;
  }
  setSmartReceiptFile(image).catch((error) => setSmartFeedback(error.message, true));
});
setupSmartSpeechInput();

/* ===== 統計操作 ===== */
function setStatsRange(from, to) {
  state.statsFrom = from;
  state.statsTo = to;
  $('#stats-from').value = from;
  $('#stats-to').value = to;
  $('#stats-from').max = to;
  $('#stats-to').min = from;
  renderStats();
  replayStatsBars();
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
    let from = id === 'stats-from' ? ev.target.value : state.statsFrom;
    let to = id === 'stats-to' ? ev.target.value : state.statsTo;
    if (from && to && from > to) {
      if (id === 'stats-from') to = from;
      else from = to;
    }
    $$('#stats-presets .chip').forEach((c) => c.classList.remove('active'));
    setStatsRange(from, to);
  });
}

/* ===== 新增 / 編輯支出 Modal ===== */
let splitMode = 'equal';
let expenseKind = 'expense';
let transferCat = '轉帳'; // 編輯舊「還款」紀錄時保留原類別
let expenseSubmitting = false;
let expensePersisted = false;
let expenseFormBaseline = '';
let modalReturnFocus = null;
let expenseSubmitLabel = '儲存';
let modalFocusTimer = null;
let expenseRequestId = null;
let receiptTask = null;
let receiptSequence = 0;

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safetySessionId() {
  if (cachedSafetySessionId) return cachedSafetySessionId;
  try {
    const stored = sessionStorage.getItem('split-bill-safety-session');
    if (/^[0-9a-f-]{36}$/i.test(stored || '')) cachedSafetySessionId = stored;
    else {
      cachedSafetySessionId = newRequestId();
      sessionStorage.setItem('split-bill-safety-session', cachedSafetySessionId);
    }
  } catch {
    cachedSafetySessionId = newRequestId();
  }
  return cachedSafetySessionId;
}

function expenseDraftSignature() {
  return JSON.stringify({
    kind: expenseKind,
    splitMode,
    description: $('#exp-desc').value,
    amount: $('#exp-amount').value,
    date: $('#exp-date').value,
    note: $('#exp-note').value,
    payer: $('#exp-payer').value,
    transferTo: $('#exp-transfer-to').value,
    category: $('#exp-categories .chip.active')?.dataset.cat || '',
    splits: [...$('#split-members').children].map((row) => ({
      id: row.dataset.id,
      checked: row.querySelector('input[type=checkbox]').checked,
      amount: row.querySelector('.split-amount-input').value,
    })),
    receiptPending: !!receiptState.pending,
    receiptRemoved: receiptState.removed,
  });
}

function hasUnsavedExpenseChanges() {
  return !expensePersisted && expenseFormBaseline && expenseDraftSignature() !== expenseFormBaseline;
}

function setExpenseSubmitting(submitting, pendingLabel = '儲存中…') {
  expenseSubmitting = submitting;
  $$('#modal-expense button, #modal-expense input, #modal-expense select, #modal-expense textarea')
    .forEach((control) => { control.disabled = submitting; });
  const button = $('.modal-actions button[type="submit"]');
  button.textContent = submitting ? pendingLabel : expenseSubmitLabel;
  button.disabled = submitting || !!receiptTask;
  $('.modal-card').setAttribute('aria-busy', String(submitting));
}

function setKind(kind) {
  expenseKind = kind;
  const isTr = kind === 'transfer';
  $('#kind-expense').classList.toggle('active', kind === 'expense');
  $('#kind-income').classList.toggle('active', kind === 'income');
  $('#kind-transfer').classList.toggle('active', isTr);
  $('#kind-expense').setAttribute('aria-pressed', String(kind === 'expense'));
  $('#kind-income').setAttribute('aria-pressed', String(kind === 'income'));
  $('#kind-transfer').setAttribute('aria-pressed', String(isTr));
  $('#label-payer').firstChild.textContent =
    isTr ? '匯款人' : kind === 'income' ? '收款人' : '付款人';
  $('#modal-title').textContent = (aiDraftActive ? '確認' : state.editingId ? '編輯' : '新增') +
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
  $('#split-equal').setAttribute('aria-pressed', String(mode === 'equal'));
  $('#split-custom').setAttribute('aria-pressed', String(mode === 'custom'));
  $('#split-none').setAttribute('aria-pressed', String(mode === 'none'));
  $('#split-members').classList.toggle('hidden', mode === 'none');
  $('#split-toolbar').classList.toggle('hidden', mode === 'none');
  $$('#split-members .split-amount-input').forEach((i) => i.classList.toggle('hidden', mode !== 'custom'));
  $$('#split-members .split-amount-label').forEach((l) => l.classList.toggle('hidden', mode === 'custom'));
  updateSplitPreview();
}

function openExpenseModal(expense = null) {
  if (expenseSubmitting) return;
  aiDraftActive = false;
  aiDraftConsumesSmartEntry = false;
  expenseSubmitLabel = '儲存';
  $('.modal-actions button[type="submit"]').textContent = expenseSubmitLabel;
  $('#ai-review').classList.add('hidden');
  $('#ai-review').classList.remove('notice', 'needs-attention');
  $('#ai-review-warnings').replaceChildren();
  modalReturnFocus = document.activeElement;
  const { members } = state.data;
  expensePersisted = false;
  state.editingId = expense?.id || null;
  state.editingVersion = expense?.version || null;
  expenseRequestId = expense ? null : newRequestId();
  receiptSequence += 1;
  receiptTask = null;

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
      <input type="checkbox" aria-label="分攤給 ${escapeHtml(m.name)}"
        ${!expense || splitMap.has(m.id) ? 'checked' : ''}>
      <span class="split-name">${escapeHtml(m.name)}</span>
      <span class="split-amount-label">—</span>
      <input type="number" class="split-amount-input hidden" min="0" step="0.01"
        max="9999999999.99" inputmode="decimal" placeholder="0" value="${splitMap.get(m.id) ?? ''}">
    </li>`).join('');

  $('#split-members').querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', updateSplitPreview);
    inp.addEventListener('change', updateSplitPreview);
  });
  $$('#split-members > li').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('input, button')) return;
      const checkbox = row.querySelector('input[type="checkbox"]');
      checkbox.checked = !checkbox.checked;
      updateSplitPreview();
    });
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
  expenseFormBaseline = expenseDraftSignature();

  const modal = $('#modal-expense');
  clearTimeout(modal._closeTimer);
  modal.classList.remove('hidden', 'closing');
  $('#view-group').inert = true;
  document.body.classList.add('modal-open');
  clearTimeout(modalFocusTimer);
  modalFocusTimer = setTimeout(() => $('#exp-desc').focus(), 50);
}

function closeExpenseModal(force = false) {
  if (expenseSubmitting && !force) return false;
  if (!force && hasUnsavedExpenseChanges()
    && !confirm('尚未儲存的變更會遺失，確定關閉？')) return false;
  const modal = $('#modal-expense');
  receiptSequence += 1;
  receiptTask = null;
  clearTimeout(modalFocusTimer);
  modal.classList.add('closing');
  modal._closeTimer = setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('closing');
    $('#view-group').inert = false;
    document.body.classList.remove('modal-open');
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  }, 180);
  state.editingId = null;
  state.editingVersion = null;
  return true;
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
  $('#btn-receipt-pick').textContent = receiptTask
    ? '處理單據…'
    : hasImage ? '更換單據' : '附上單據照片';
  $('#btn-receipt-view').classList.toggle('hidden', !hasImage);
  $('#btn-receipt-remove').classList.toggle('hidden', !hasImage);
  $('.modal-actions button[type="submit"]').disabled = expenseSubmitting || !!receiptTask;
}

// 縮到最長邊 1600px 的 JPEG，避免上傳原始大圖
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        if (!img.width || !img.height || img.width * img.height > 100_000_000) {
          throw new Error('圖片尺寸過大，請改用較小的圖片');
        }
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('這個瀏覽器無法處理圖片');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
          throw new Error('圖片轉換失敗，請改用其他圖片');
        }
        resolve(dataUrl);
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取這張圖片'));
    };
    img.src = url;
  });
}

$('#btn-receipt-pick').addEventListener('click', () => $('#exp-receipt-file').click());

async function setExpenseReceiptFile(file) {
  if (!file) return;
  const sequence = ++receiptSequence;
  try {
    if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔案');
    if (file.size > 25 * 1024 * 1024) throw new Error('圖片過大（原始檔上限 25MB）');
    const task = compressImage(file);
    receiptTask = task;
    renderReceiptUI();
    const dataUrl = await task;
    if (sequence !== receiptSequence) return;
    receiptState.pending = dataUrl;
    receiptState.removed = false;
  } catch (error) {
    if (sequence === receiptSequence) throw error;
  } finally {
    if (sequence === receiptSequence) {
      receiptTask = null;
      renderReceiptUI();
    }
  }
}

$('#exp-receipt-file').addEventListener('change', async (ev) => {
  try {
    await setExpenseReceiptFile(ev.target.files[0]);
  } catch (error) {
    toast(error.message);
  }
  ev.target.value = '';
});

$('#btn-receipt-view').addEventListener('click', () => {
  if (receiptState.pending) openReceiptPreview(receiptState.pending);
  else if (receiptState.existing && !receiptState.removed) {
    openReceiptPreview(`/uploads/${receiptState.existing}`);
  }
});

$('#btn-receipt-remove').addEventListener('click', () => {
  receiptSequence += 1;
  receiptTask = null;
  receiptState.pending = null;
  receiptState.removed = !!receiptState.existing;
  renderReceiptUI();
});

$('#btn-delete-expense').addEventListener('click', async () => {
  if (!state.editingId || expenseSubmitting) return;
  const exp = state.data.expenses.find((e) => e.id === state.editingId);
  if (!confirm(`確定刪除「${exp?.description ?? '這筆支出'}」？`)) return;
  setExpenseSubmitting(true, '處理中…');
  try {
    await api(
      `/api/groups/${state.groupId}/expenses/${state.editingId}?version=${exp.version}`,
      { method: 'DELETE' }
    );
    expensePersisted = true;
    setExpenseSubmitting(false);
    closeExpenseModal(true);
    try {
      await refresh();
      toast('已刪除');
    } catch {
      toast('已刪除，重新連線後會更新畫面');
    }
  } catch (e) {
    if (e.status === 409) {
      setExpenseSubmitting(false);
      closeExpenseModal(true);
      refresh().catch(() => {});
    }
    toast(e.message);
  } finally {
    setExpenseSubmitting(false);
  }
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
$('#btn-close-modal').addEventListener('click', () => closeExpenseModal());
$('#modal-expense').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) closeExpenseModal();
});
document.addEventListener('keydown', (ev) => {
  const modal = $('#modal-expense');
  if (modal.classList.contains('hidden') || modal.classList.contains('closing')) return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !expenseSubmitting) {
    ev.preventDefault();
    $('#form-expense').requestSubmit();
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeExpenseModal();
    return;
  }
  if (ev.key !== 'Tab') return;
  const focusable = [...modal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
  )].filter((el) => !el.closest('.hidden'));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
});

window.addEventListener('beforeunload', (ev) => {
  if ($('#modal-expense').classList.contains('hidden') || !hasUnsavedExpenseChanges()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

$('#form-expense').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (expenseSubmitting || expensePersisted) return;
  if (receiptTask) return toast('單據仍在處理，完成後即可儲存');
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

  const isEdit = !!state.editingId;
  if (isEdit) payload.version = state.editingVersion;
  const expenseId = state.editingId;
  const receiptUpdate = {
    pending: receiptState.pending,
    remove: receiptState.removed && !!receiptState.existing,
  };
  setExpenseSubmitting(true);

  try {
    if (isEdit) {
      if (receiptUpdate.pending) payload.receiptDataUrl = receiptUpdate.pending;
      else if (receiptUpdate.remove) payload.removeReceipt = true;
      await api(`/api/groups/${state.groupId}/expenses/${expenseId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      payload.clientRequestId = expenseRequestId;
      if (receiptUpdate.pending) payload.receiptDataUrl = receiptUpdate.pending;
      const endpoint = receiptUpdate.pending
        ? `/api/groups/${state.groupId}/expenses-with-receipt`
        : `/api/groups/${state.groupId}/expenses`;
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    expensePersisted = true;
    const completedSmartDraft = aiDraftActive && aiDraftConsumesSmartEntry;

    setExpenseSubmitting(false);
    closeExpenseModal(true);
    if (completedSmartDraft) clearSmartEntry();
    refresh().catch(() => {});
    toast(isEdit ? '已更新' : '已新增');
  } catch (e) {
    if (e.status === 409) {
      setExpenseSubmitting(false);
      closeExpenseModal(true);
      refresh().catch(() => {});
    }
    toast(e.message);
  } finally {
    setExpenseSubmitting(false);
  }
});

/* ===== 初始化 ===== */
let initializing = false;

async function initialize() {
  if (initializing) return;
  initializing = true;
  try {
    if (!state.groupId) {
      const me = await api('/api/me');
      state.groupId = me.groupId;
      state.memberId = me.memberId;
    }
    await refresh();
    await restoreSmartDraft();
    loadAiStatus().catch(() => {
      $('#smart-mode').textContent = '狀態未知';
      syncSmartAnalyzeButton();
    });
    if (!state.pollTimer) {
      state.pollTimer = setInterval(() => refresh({ poll: true }).catch(() => {}), 15000);
    }
  } catch (e) {
    showConnectionStatus(e.message);
  } finally {
    initializing = false;
  }
}

$('#btn-retry').addEventListener('click', async (ev) => {
  ev.currentTarget.disabled = true;
  await initialize();
  ev.currentTarget.disabled = false;
});

window.addEventListener('offline', () => {
  showConnectionStatus('目前處於離線狀態，帳本將在網路恢復後更新');
});
window.addEventListener('online', () => initialize());

initialize();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) writeSmartDraft().catch(() => {});
  if (canPoll()) refresh({ poll: true }).catch(() => {});
});
