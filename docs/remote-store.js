/* ============================================
   遠端資料層（GitHub Pages 用）
   帳本資料存為 GitHub 私人 repo 的 data.json，
   透過 Contents API 讀寫，跨裝置共用同一份資料。
   localStorage 只存連線設定（token），不存帳目。
   ============================================ */
(() => {
  const OWNER = 'fearnot221';
  const REPO = 'split-bill-data';
  const FILE = 'data.json';
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
  const CONFIG_KEY = 'splitbill:config';
  const LEGACY_KEY = 'splitbill:data'; // 舊 localStorage 版資料，連線時自動搬移
  const TRANSFER_CATEGORY = '還款';

  const uid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const round2 = (n) => Math.round(n * 100) / 100;

  const store = { data: null, sha: null, lastFetch: 0 };

  /* ===== 連線設定（token 之外可覆寫 api 位址，供測試或 GHE 使用） ===== */
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
    catch { return {}; }
  }
  const getToken = () => getConfig().token || null;
  const apiUrl = () => getConfig().api || API;
  const setToken = (t) => localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getConfig(), token: t }));
  const clearToken = () => localStorage.removeItem(CONFIG_KEY);

  const ghHeaders = () => ({
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  /* ===== UTF-8 安全的 base64 ===== */
  function b64encode(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64decode(s) {
    const bin = atob(s.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  /* ===== 讀寫 data.json ===== */
  function initialData() {
    return {
      group: { id: 'local', name: '我的帳本' },
      members: [{ id: uid(), name: '我', created_at: new Date().toISOString() }],
      expenses: [],
    };
  }

  function legacyData() {
    try {
      const d = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (d && d.group && Array.isArray(d.members) && Array.isArray(d.expenses)) return d;
    } catch { /* ignore */ }
    return null;
  }

  async function fetchData() {
    const res = await fetch(apiUrl(), { headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token 無效或權限不足（需要 split-bill-data 的 Contents 讀寫權限）');
    }
    if (res.status === 404) {
      // 資料檔不存在：用舊版 localStorage 資料或空帳本建立
      store.data = legacyData() || initialData();
      store.sha = null;
      await push('init: 建立帳本資料');
      localStorage.removeItem(LEGACY_KEY);
      store.lastFetch = Date.now();
      return;
    }
    if (!res.ok) throw new Error(`讀取資料失敗（HTTP ${res.status}）`);
    const body = await res.json();
    const data = JSON.parse(b64decode(body.content));
    if (!data.group || !Array.isArray(data.members) || !Array.isArray(data.expenses)) {
      throw new Error('data.json 格式不正確');
    }
    store.data = data;
    store.sha = body.sha;
    store.lastFetch = Date.now();

    // 舊版 localStorage 有資料而遠端還是空帳本 → 自動搬移
    const legacy = legacyData();
    if (legacy && legacy.expenses.length > 0 && store.data.expenses.length === 0) {
      store.data = legacy;
      await push('chore: 搬移瀏覽器內舊資料');
    }
    if (legacy) localStorage.removeItem(LEGACY_KEY);
  }

  async function push(message) {
    const payload = {
      message: message || `update: ${new Date().toISOString()}`,
      content: b64encode(JSON.stringify(store.data, null, 2)),
    };
    if (store.sha) payload.sha = store.sha;
    const res = await fetch(apiUrl(), {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409 || res.status === 422) {
      const e = new Error('資料版本衝突');
      e.conflict = true;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token 無效或權限不足，無法寫入');
    }
    if (!res.ok) throw new Error(`儲存失敗（HTTP ${res.status}）`);
    const body = await res.json();
    store.sha = body.content.sha;
  }

  async function ensureLoaded() {
    if (!getToken()) {
      showSetup();
      throw new Error('請先完成 GitHub 同步設定');
    }
    if (!store.data) await fetchData();
  }

  // 寫入：先套用變更再推送；遇版本衝突則拉最新資料重套一次
  async function withMutation(mutate) {
    await ensureLoaded();
    const err = mutate(store.data);
    if (err) throw new Error(err);
    try {
      await push();
    } catch (e) {
      if (!e.conflict) throw e;
      await fetchData();
      const err2 = mutate(store.data);
      if (err2) throw new Error(err2);
      await push();
    }
    return { ok: true };
  }

  /* ===== 帳本計算（與 server.js 相同） ===== */
  function groupData(d) {
    const expenses = [...d.expenses].sort((a, b) =>
      b.expense_date.localeCompare(a.expense_date) || b.created_at.localeCompare(a.created_at));

    const balances = {};
    for (const m of d.members) balances[m.id] = 0;
    for (const e of expenses) {
      balances[e.payer_id] = round2((balances[e.payer_id] || 0) + e.amount);
      for (const s of e.splits) {
        balances[s.member_id] = round2((balances[s.member_id] || 0) - s.amount);
      }
    }

    const debtors = [];
    const creditors = [];
    for (const [id, bal] of Object.entries(balances)) {
      if (bal < -0.01) debtors.push({ id, amount: -bal });
      else if (bal > 0.01) creditors.push({ id, amount: bal });
    }
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    const settlements = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = round2(Math.min(debtors[i].amount, creditors[j].amount));
      if (pay > 0.01) settlements.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
      debtors[i].amount = round2(debtors[i].amount - pay);
      creditors[j].amount = round2(creditors[j].amount - pay);
      if (debtors[i].amount <= 0.01) i++;
      if (creditors[j].amount <= 0.01) j++;
    }

    const total = round2(
      expenses.reduce((sum, e) => (e.category === TRANSFER_CATEGORY ? sum : sum + e.amount), 0)
    );

    return { group: d.group, members: d.members, expenses, balances, settlements, total };
  }

  function validateExpense(d, payload) {
    const { payerId, description, amount, splits } = payload;
    const amt = Number(amount);
    if (!description?.trim()) return '請填寫項目說明';
    if (!Number.isFinite(amt) || amt <= 0) return '金額必須大於 0';
    if (!Array.isArray(splits) || splits.length === 0) return '請至少選擇一位分攤成員';
    const ids = new Set(d.members.map((m) => m.id));
    if (!ids.has(payerId)) return '付款人不在成員中';
    for (const s of splits) {
      if (!ids.has(s.memberId)) return '分攤成員不在成員中';
      if (!Number.isFinite(Number(s.amount)) || Number(s.amount) < 0) return '分攤金額不正確';
    }
    const splitTotal = round2(splits.reduce((sum, s) => sum + Number(s.amount), 0));
    if (Math.abs(splitTotal - round2(amt)) > 0.01) {
      return `分攤總額 ${splitTotal} 與支出金額 ${amt} 不符`;
    }
    return null;
  }

  function toExpense(payload, id, createdAt) {
    return {
      id,
      payer_id: payload.payerId,
      description: payload.description.trim(),
      amount: round2(Number(payload.amount)),
      category: payload.category || '其他',
      expense_date: payload.expenseDate || new Date().toISOString().slice(0, 10),
      created_at: createdAt,
      splits: payload.splits
        .filter((s) => Number(s.amount) > 0)
        .map((s) => ({ member_id: s.memberId, amount: round2(Number(s.amount)) })),
    };
  }

  /* ===== API 模擬層（與 app.js 的 api() 介面對接） ===== */
  window.__localApi = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    let m;

    if (url === '/api/me') {
      await ensureLoaded();
      const d = store.data;
      return { groupId: d.group.id, memberId: d.members[0].id, groupName: d.group.name };
    }

    if (/^\/api\/groups\/[^/]+$/.test(url)) {
      if (method === 'GET') {
        await ensureLoaded();
        return groupData(store.data);
      }
      if (method === 'PATCH') {
        return withMutation((d) => {
          if (!body.name?.trim()) return '請填寫帳本名稱';
          d.group.name = body.name.trim();
        });
      }
    }

    if (/^\/api\/groups\/[^/]+\/members$/.test(url) && method === 'POST') {
      return withMutation((d) => {
        const name = body.name?.trim();
        if (!name) return '請填寫成員名字';
        if (d.members.some((x) => x.name === name)) return '已有同名成員';
        d.members.push({ id: uid(), name, created_at: new Date().toISOString() });
      });
    }

    if ((m = url.match(/^\/api\/groups\/[^/]+\/members\/([^/]+)$/)) && method === 'DELETE') {
      const mid = m[1];
      return withMutation((d) => {
        const involved = d.expenses.some(
          (e) => e.payer_id === mid || e.splits.some((s) => s.member_id === mid));
        if (involved) return '此成員已有帳務紀錄，無法刪除';
        d.members = d.members.filter((x) => x.id !== mid);
      });
    }

    if (/^\/api\/groups\/[^/]+\/expenses$/.test(url) && method === 'POST') {
      const id = uid();
      const createdAt = new Date().toISOString();
      return withMutation((d) => {
        const bad = validateExpense(d, body);
        if (bad) return bad;
        if (!d.expenses.some((e) => e.id === id)) {
          d.expenses.push(toExpense(body, id, createdAt));
        }
      });
    }

    if ((m = url.match(/^\/api\/groups\/[^/]+\/expenses\/([^/]+)$/))) {
      const eid = m[1];
      if (method === 'PUT') {
        return withMutation((d) => {
          const idx = d.expenses.findIndex((e) => e.id === eid);
          if (idx === -1) return '找不到這筆支出';
          const bad = validateExpense(d, body);
          if (bad) return bad;
          d.expenses[idx] = toExpense(body, eid, d.expenses[idx].created_at);
        });
      }
      if (method === 'DELETE') {
        return withMutation((d) => {
          const idx = d.expenses.findIndex((e) => e.id === eid);
          if (idx === -1) return '找不到這筆支出';
          d.expenses.splice(idx, 1);
        });
      }
    }

    throw new Error('找不到資源');
  };

  window.__localExport = () => {
    if (!store.data) return;
    const d = store.data;
    const { expenses } = groupData(d);
    const nameOf = (id) => d.members.find((x) => x.id === id)?.name || '?';
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['日期', '說明', '分類', '付款人', '金額', '分攤明細']];
    for (const e of expenses) {
      rows.push([
        e.expense_date, e.description, e.category, nameOf(e.payer_id), e.amount,
        e.splits.map((s) => `${nameOf(s.member_id)}:${s.amount}`).join('; '),
      ]);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `expenses-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ===== 首次連線設定畫面 ===== */
  function showSetup() {
    if (document.getElementById('sync-setup')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'sync-setup';
    el.innerHTML = `
      <div class="modal-card">
        <div class="modal-header"><h2>連接 GitHub 同步</h2></div>
        <p class="hint-block">帳本資料存在你的私人 repo
          <b>${OWNER}/${REPO}</b> 的 data.json，每台裝置輸入一次 token 即可同步。</p>
        <label>Fine-grained Personal Access Token
          <input type="password" id="sync-token" placeholder="github_pat_…" autocomplete="off">
        </label>
        <p class="hint">建立方式：GitHub → Settings → Developer settings →
          Fine-grained tokens → Generate new token，
          Repository access 只選 <b>${REPO}</b>，
          Permissions 給 <b>Contents：Read and write</b>。</p>
        <button type="button" class="btn btn-primary" id="sync-connect">連接</button>
        <p class="hint" id="sync-error" style="margin-top:10px"></p>
      </div>`;
    document.body.appendChild(el);
    const btn = el.querySelector('#sync-connect');
    const input = el.querySelector('#sync-token');
    const errEl = el.querySelector('#sync-error');
    const connect = async () => {
      const t = input.value.trim();
      if (!t) { errEl.textContent = '請貼上 token'; return; }
      btn.disabled = true;
      btn.textContent = '連接中…';
      setToken(t);
      try {
        await fetchData();
        location.reload();
      } catch (e) {
        clearToken();
        store.data = null;
        errEl.textContent = e.message;
        btn.disabled = false;
        btn.textContent = '連接';
      }
    };
    btn.addEventListener('click', connect);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') connect(); });
    setTimeout(() => input.focus(), 50);
  }

  /* ===== 回到分頁時拉最新資料 ===== */
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !getToken() || !store.data) return;
    if (Date.now() - store.lastFetch < 30000) return;
    try {
      await fetchData();
      if (window.refresh) window.refresh();
    } catch { /* 離線時略過 */ }
  });

  /* ===== 帳本設定加上「中斷同步」 ===== */
  function injectDisconnect() {
    const card = document.querySelector('#form-rename')?.closest('.card');
    if (!card || document.getElementById('sync-disconnect')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sync-disconnect';
    btn.className = 'btn btn-ghost';
    btn.style.marginTop = '14px';
    btn.textContent = '中斷 GitHub 同步連線';
    btn.addEventListener('click', () => {
      if (!confirm('中斷後這台裝置需重新輸入 token 才能使用。確定？')) return;
      clearToken();
      location.reload();
    });
    card.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDisconnect);
  } else {
    injectDisconnect();
  }
})();
