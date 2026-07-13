'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('upgrades an older expenses table with current columns', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-bill-migration-'));
  const filename = path.join(tempDir, 'data.db');
  const legacy = new Database(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      currency TEXT NOT NULL DEFAULT 'NT$',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (group_id, name)
    );
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      payer_id TEXT NOT NULL REFERENCES members(id),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT '其他',
      expense_date TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE expense_splits (
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      amount REAL NOT NULL,
      PRIMARY KEY (expense_id, member_id)
    );
    INSERT INTO groups (id, name, code) VALUES ('group', '舊帳本', 'ABC123');
    INSERT INTO members (id, group_id, name) VALUES
      ('payer', 'group', '付款人'),
      ('friend', 'group', '朋友');
    INSERT INTO expenses (
      id, group_id, payer_id, description, amount, category, expense_date
    ) VALUES
      ('expense', 'group', 'payer', '舊版誤差', 1, '其他', '2026-07-13'),
      ('zero', 'group', 'payer', '舊版零元', 0, '其他', '2026-07-13');
    INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES
        ('expense', 'friend', 0.99),
        ('zero', 'friend', 0);
  `);
  legacy.close();

  process.env.DB_PATH = filename;
  const db = require('../db');
  t.after(() => {
    if (db.open) db.close();
    delete process.env.DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const columns = new Map(db.prepare('PRAGMA table_info(expenses)').all().map((column) => [
    column.name,
    column,
  ]));

  assert.ok(columns.has('deleted_at'));
  assert.ok(columns.has('receipt'));
  assert.ok(columns.has('note'));
  assert.ok(columns.has('kind'));
  assert.ok(columns.has('version'));
  assert.equal(columns.get('version').dflt_value, '1');
  const splits = db.prepare(`SELECT member_id, amount FROM expense_splits
    WHERE expense_id = 'expense' ORDER BY member_id`).all();
  assert.deepEqual(splits, [
    { member_id: 'friend', amount: 0.99 },
    { member_id: 'payer', amount: 0.01 },
  ]);
  assert.equal(db.prepare("SELECT amount FROM expenses WHERE id = 'zero'").get().amount, 0.01);
  assert.equal(db.prepare(`SELECT SUM(amount) AS total FROM expense_splits
    WHERE expense_id = 'zero'`).get().total, 0.01);
  assert.ok(db.prepare(`SELECT 1 FROM admin_config
    WHERE key = 'ledger_integrity_cents_v1'`).get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'").get());
});
