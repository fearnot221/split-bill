const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'NT$',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_fund INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  payer_id TEXT NOT NULL REFERENCES members(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT '其他',
  expense_date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  amount REAL NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_splits_expense ON expense_splits(expense_id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'tag',
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
`);

// 既有資料庫補上軟刪除與單據欄位
const expenseCols = db.prepare('PRAGMA table_info(expenses)').all();
if (!expenseCols.some((c) => c.name === 'deleted_at')) {
  db.exec('ALTER TABLE expenses ADD COLUMN deleted_at TEXT');
}
if (!expenseCols.some((c) => c.name === 'receipt')) {
  db.exec('ALTER TABLE expenses ADD COLUMN receipt TEXT');
}
if (!expenseCols.some((c) => c.name === 'note')) {
  db.exec('ALTER TABLE expenses ADD COLUMN note TEXT');
}
if (!expenseCols.some((c) => c.name === 'kind')) {
  db.exec("ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'");
}
const memberCols = db.prepare('PRAGMA table_info(members)').all();
if (!memberCols.some((c) => c.name === 'is_fund')) {
  db.exec('ALTER TABLE members ADD COLUMN is_fund INTEGER NOT NULL DEFAULT 0');
}

// 幫沒有類別的帳本種入預設類別（新帳本與既有資料庫遷移共用）
const DEFAULT_CATEGORIES = [
  ['餐飲', 'food'], ['交通', 'transport'], ['住宿', 'lodging'],
  ['購物', 'shopping'], ['娛樂', 'fun'], ['其他', 'other'],
];
db.seedCategories = (groupId) => {
  const has = db.prepare('SELECT 1 FROM categories WHERE group_id = ? LIMIT 1').get(groupId);
  if (has) return;
  const ins = db.prepare('INSERT INTO categories (id, group_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_CATEGORIES.forEach(([name, icon], i) => {
    ins.run(require('crypto').randomUUID(), groupId, name, icon, i);
  });
};
// 幫每本帳補上「公帳」虛擬成員：可收轉帳（存入公費）、也可作為付款人（公費支出）
db.seedFund = (groupId) => {
  const has = db.prepare('SELECT 1 FROM members WHERE group_id = ? AND is_fund = 1 LIMIT 1').get(groupId);
  if (has) return;
  const named = db.prepare('SELECT id FROM members WHERE group_id = ? AND name = ?').get(groupId, '公帳');
  if (named) {
    db.prepare('UPDATE members SET is_fund = 1 WHERE id = ?').run(named.id);
  } else {
    db.prepare('INSERT INTO members (id, group_id, name, is_fund) VALUES (?, ?, ?, 1)')
      .run(require('crypto').randomUUID(), groupId, '公帳');
  }
};

for (const g of db.prepare('SELECT id FROM groups').all()) {
  db.seedCategories(g.id);
  db.seedFund(g.id);
}

module.exports = db;
