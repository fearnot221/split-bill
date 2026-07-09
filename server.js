const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uid = () => crypto.randomUUID();

// 產生不重複的 6 碼邀請碼（避開易混淆字元）
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    const exists = db.prepare('SELECT 1 FROM groups WHERE code = ?').get(code);
    if (!exists) return code;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

// 「還款」是成員間轉帳，不算實際消費
const TRANSFER_CATEGORY = '還款';

// 取得群組完整資料（成員、支出、結餘、結算建議）
function getGroupData(groupId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return null;

  const members = db
    .prepare('SELECT * FROM members WHERE group_id = ? ORDER BY created_at')
    .all(groupId);

  const expenses = db
    .prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY expense_date DESC, created_at DESC')
    .all(groupId);

  const splitStmt = db.prepare('SELECT member_id, amount FROM expense_splits WHERE expense_id = ?');
  for (const e of expenses) e.splits = splitStmt.all(e.id);

  // 結餘：付出的 - 應分攤的
  const balances = {};
  for (const m of members) balances[m.id] = 0;
  for (const e of expenses) {
    balances[e.payer_id] = round2((balances[e.payer_id] || 0) + e.amount);
    for (const s of e.splits) {
      balances[s.member_id] = round2((balances[s.member_id] || 0) - s.amount);
    }
  }

  // 最少轉帳結算（貪婪法：最大債務人付給最大債權人）
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

  return { group, members, expenses, balances, settlements, total };
}

// 個人模式：取得（或自動建立）預設帳本
app.get('/api/me', (req, res) => {
  let group = db.prepare('SELECT * FROM groups ORDER BY created_at LIMIT 1').get();
  if (!group) {
    const groupId = uid();
    const memberId = uid();
    db.transaction(() => {
      db.prepare('INSERT INTO groups (id, name, code) VALUES (?, ?, ?)')
        .run(groupId, '我的帳本', genCode());
      db.prepare('INSERT INTO members (id, group_id, name) VALUES (?, ?, ?)')
        .run(memberId, groupId, '我');
    })();
    group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  }
  const me = db
    .prepare('SELECT * FROM members WHERE group_id = ? ORDER BY created_at LIMIT 1')
    .get(group.id);
  res.json({ groupId: group.id, memberId: me.id, groupName: group.name });
});

// 修改帳本名稱
app.patch('/api/groups/:id', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填寫帳本名稱' });
  const result = db
    .prepare('UPDATE groups SET name = ? WHERE id = ?')
    .run(name.trim(), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '找不到帳本' });
  res.json({ ok: true });
});

// 匯出 CSV（含 BOM，Excel 可直接開啟中文）
app.get('/api/groups/:id/export', (req, res) => {
  const data = getGroupData(req.params.id);
  if (!data) return res.status(404).json({ error: '找不到帳本' });
  const nameOf = (id) => data.members.find((m) => m.id === id)?.name || '?';
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['日期', '說明', '分類', '付款人', '金額', '分攤明細']];
  for (const e of data.expenses) {
    rows.push([
      e.expense_date, e.description, e.category, nameOf(e.payer_id), e.amount,
      e.splits.map((s) => `${nameOf(s.member_id)}:${s.amount}`).join('; '),
    ]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// 取得群組完整資料
app.get('/api/groups/:id', (req, res) => {
  const data = getGroupData(req.params.id);
  if (!data) return res.status(404).json({ error: '找不到群組' });
  res.json(data);
});

// 新增成員
app.post('/api/groups/:id/members', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填寫成員名字' });
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: '找不到群組' });
  const exists = db
    .prepare('SELECT 1 FROM members WHERE group_id = ? AND name = ?')
    .get(group.id, name.trim());
  if (exists) return res.status(409).json({ error: '已有同名成員' });
  const memberId = uid();
  db.prepare('INSERT INTO members (id, group_id, name) VALUES (?, ?, ?)')
    .run(memberId, group.id, name.trim());
  res.json({ memberId });
});

// 刪除成員（有帳務紀錄則不可刪）
app.delete('/api/groups/:id/members/:memberId', (req, res) => {
  const { id, memberId } = req.params;
  const involved = db
    .prepare(`SELECT 1 FROM expenses WHERE group_id = ? AND payer_id = ?
              UNION SELECT 1 FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
              WHERE e.group_id = ? AND s.member_id = ?`)
    .get(id, memberId, id, memberId);
  if (involved) return res.status(409).json({ error: '此成員已有帳務紀錄，無法刪除' });
  db.prepare('DELETE FROM members WHERE id = ? AND group_id = ?').run(memberId, id);
  res.json({ ok: true });
});

// 新增支出
app.post('/api/groups/:id/expenses', (req, res) => {
  const { payerId, description, amount, category, expenseDate, splits } = req.body;
  const groupId = req.params.id;

  const amt = Number(amount);
  if (!description?.trim()) return res.status(400).json({ error: '請填寫項目說明' });
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: '金額必須大於 0' });
  if (!Array.isArray(splits) || splits.length === 0) {
    return res.status(400).json({ error: '請至少選擇一位分攤成員' });
  }

  const memberIds = new Set(
    db.prepare('SELECT id FROM members WHERE group_id = ?').all(groupId).map((m) => m.id)
  );
  if (!memberIds.has(payerId)) return res.status(400).json({ error: '付款人不在群組中' });
  for (const s of splits) {
    if (!memberIds.has(s.memberId)) return res.status(400).json({ error: '分攤成員不在群組中' });
    if (!Number.isFinite(Number(s.amount)) || Number(s.amount) < 0) {
      return res.status(400).json({ error: '分攤金額不正確' });
    }
  }
  const splitTotal = round2(splits.reduce((sum, s) => sum + Number(s.amount), 0));
  if (Math.abs(splitTotal - round2(amt)) > 0.01) {
    return res.status(400).json({ error: `分攤總額 ${splitTotal} 與支出金額 ${amt} 不符` });
  }

  const expenseId = uid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO expenses (id, group_id, payer_id, description, amount, category, expense_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      expenseId, groupId, payerId, description.trim(), round2(amt),
      category || '其他', expenseDate || new Date().toISOString().slice(0, 10)
    );
    const ins = db.prepare(
      'INSERT INTO expense_splits (expense_id, member_id, amount) VALUES (?, ?, ?)'
    );
    for (const s of splits) {
      if (Number(s.amount) > 0) ins.run(expenseId, s.memberId, round2(Number(s.amount)));
    }
  })();
  res.json({ expenseId });
});

// 編輯支出
app.put('/api/groups/:id/expenses/:expenseId', (req, res) => {
  const { payerId, description, amount, category, expenseDate, splits } = req.body;
  const groupId = req.params.id;
  const expenseId = req.params.expenseId;

  const existing = db
    .prepare('SELECT id FROM expenses WHERE id = ? AND group_id = ?')
    .get(expenseId, groupId);
  if (!existing) return res.status(404).json({ error: '找不到這筆支出' });

  const amt = Number(amount);
  if (!description?.trim()) return res.status(400).json({ error: '請填寫項目說明' });
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: '金額必須大於 0' });
  if (!Array.isArray(splits) || splits.length === 0) {
    return res.status(400).json({ error: '請至少選擇一位分攤成員' });
  }

  const memberIds = new Set(
    db.prepare('SELECT id FROM members WHERE group_id = ?').all(groupId).map((m) => m.id)
  );
  if (!memberIds.has(payerId)) return res.status(400).json({ error: '付款人不在群組中' });
  for (const s of splits) {
    if (!memberIds.has(s.memberId)) return res.status(400).json({ error: '分攤成員不在群組中' });
    if (!Number.isFinite(Number(s.amount)) || Number(s.amount) < 0) {
      return res.status(400).json({ error: '分攤金額不正確' });
    }
  }
  const splitTotal = round2(splits.reduce((sum, s) => sum + Number(s.amount), 0));
  if (Math.abs(splitTotal - round2(amt)) > 0.01) {
    return res.status(400).json({ error: `分攤總額 ${splitTotal} 與支出金額 ${amt} 不符` });
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE expenses SET payer_id = ?, description = ?, amount = ?, category = ?, expense_date = ?
       WHERE id = ?`
    ).run(
      payerId, description.trim(), round2(amt), category || '其他',
      expenseDate || new Date().toISOString().slice(0, 10), expenseId
    );
    db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expenseId);
    const ins = db.prepare(
      'INSERT INTO expense_splits (expense_id, member_id, amount) VALUES (?, ?, ?)'
    );
    for (const s of splits) {
      if (Number(s.amount) > 0) ins.run(expenseId, s.memberId, round2(Number(s.amount)));
    }
  })();
  res.json({ ok: true });
});

// 刪除支出
app.delete('/api/groups/:id/expenses/:expenseId', (req, res) => {
  const result = db
    .prepare('DELETE FROM expenses WHERE id = ? AND group_id = ?')
    .run(req.params.expenseId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '找不到這筆支出' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`分帳 App 已啟動： http://localhost:${PORT}`);
});
