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
`);

module.exports = db;
