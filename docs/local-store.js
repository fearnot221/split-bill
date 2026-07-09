/* ============================================
   靜態版資料層（GitHub Pages 用）
   以 localStorage 取代後端 API，介面與 server.js 相同
   ============================================ */
(() => {
  const KEY = 'splitbill:data';
  const TRANSFER_CATEGORY = '還款';

  const uid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const round2 = (n) => Math.round(n * 100) / 100;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.group && Array.isArray(d.members) && Array.isArray(d.expenses)) return d;
    } catch { /* 資料損毀時重建 */ }
    return null;
  }
  function save(d) { localStorage.setItem(KEY, JSON.stringify(d)); }

  function ensure() {
    let d = load();
    if (!d) {
      d = {
        group: { id: 'local', name: '我的帳本' },
        members: [{ id: uid(), name: '我', created_at: new Date().toISOString() }],
        expenses: [],
      };
      save(d);
    }
    return d;
  }

  // 與 server.js getGroupData 相同：結餘＋最少轉帳結算＋總支出（不含還款）
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

  window.__localApi = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const d = ensure();
    const fail = (msg) => { throw new Error(msg); };
    let m;

    if (url === '/api/me') {
      return { groupId: d.group.id, memberId: d.members[0].id, groupName: d.group.name };
    }

    if (/^\/api\/groups\/[^/]+$/.test(url)) {
      if (method === 'GET') return groupData(d);
      if (method === 'PATCH') {
        if (!body.name?.trim()) fail('請填寫帳本名稱');
        d.group.name = body.name.trim();
        save(d);
        return { ok: true };
      }
    }

    if (/^\/api\/groups\/[^/]+\/members$/.test(url) && method === 'POST') {
      const name = body.name?.trim();
      if (!name) fail('請填寫成員名字');
      if (d.members.some((x) => x.name === name)) fail('已有同名成員');
      d.members.push({ id: uid(), name, created_at: new Date().toISOString() });
      save(d);
      return { ok: true };
    }

    if ((m = url.match(/^\/api\/groups\/[^/]+\/members\/([^/]+)$/)) && method === 'DELETE') {
      const mid = m[1];
      const involved = d.expenses.some(
        (e) => e.payer_id === mid || e.splits.some((s) => s.member_id === mid));
      if (involved) fail('此成員已有帳務紀錄，無法刪除');
      d.members = d.members.filter((x) => x.id !== mid);
      save(d);
      return { ok: true };
    }

    if (/^\/api\/groups\/[^/]+\/expenses$/.test(url) && method === 'POST') {
      const bad = validateExpense(d, body);
      if (bad) fail(bad);
      d.expenses.push(toExpense(body, uid(), new Date().toISOString()));
      save(d);
      return { ok: true };
    }

    if ((m = url.match(/^\/api\/groups\/[^/]+\/expenses\/([^/]+)$/))) {
      const idx = d.expenses.findIndex((e) => e.id === m[1]);
      if (idx === -1) fail('找不到這筆支出');
      if (method === 'PUT') {
        const bad = validateExpense(d, body);
        if (bad) fail(bad);
        d.expenses[idx] = toExpense(body, m[1], d.expenses[idx].created_at);
        save(d);
        return { ok: true };
      }
      if (method === 'DELETE') {
        d.expenses.splice(idx, 1);
        save(d);
        return { ok: true };
      }
    }

    fail('找不到資源');
  };

  window.__localExport = () => {
    const d = ensure();
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
})();
