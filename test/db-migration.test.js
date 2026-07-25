'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');

function makeTempDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-bill-migration-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return path.join(tempDir, 'data.db');
}

function runMigrations(filename) {
  const result = spawnSync(
    process.execPath,
    ['-e', "const db = require('./db'); db.close();"],
    {
      cwd: root,
      env: { ...process.env, DB_PATH: filename },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  if (result.error) throw result.error;
  return result;
}

function assertMigrationSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function assertDatabaseHealthy(db) {
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

function createLegacyFundDatabase(filename, reference = null) {
  const legacy = new Database(filename);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
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
      is_fund INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      receipt TEXT,
      note TEXT,
      kind TEXT NOT NULL DEFAULT 'expense',
      version INTEGER NOT NULL DEFAULT 1,
      request_key TEXT
    );
    CREATE TABLE expense_splits (
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      amount REAL NOT NULL,
      PRIMARY KEY (expense_id, member_id)
    );
    CREATE TABLE admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO groups (id, name, code) VALUES ('group', '舊帳本', 'ABC123');
    INSERT INTO members (id, group_id, name, is_fund) VALUES
      ('person', 'group', '一般成員', 0),
      ('named-public', 'group', '公帳', 0),
      ('legacy-fund', 'group', '舊系統帳戶', 1);
  `);

  if (reference) {
    legacy.prepare(`INSERT INTO members (id, group_id, name, is_fund)
      VALUES (?, ?, ?, ?)`).run('orphan-fund', 'group', '未使用的舊系統帳戶', 1);
    const payerId = reference === 'payer' ? 'legacy-fund' : 'person';
    const splitMemberId = reference === 'split' ? 'legacy-fund' : 'person';
    legacy.prepare(`INSERT INTO expenses (
      id, group_id, payer_id, description, amount, category, expense_date, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'deleted-expense',
      'group',
      payerId,
      '已刪除的舊帳目',
      10,
      '其他',
      '2026-07-24',
      '2026-07-25 00:00:00'
    );
    legacy.prepare(`INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES (?, ?, ?)`).run('deleted-expense', splitMemberId, 10);
  }

  legacy.close();
}

test('fresh schema does not create a public-fund role', (t) => {
  const filename = makeTempDatabase(t);

  assertMigrationSucceeded(runMigrations(filename));
  assertMigrationSucceeded(runMigrations(filename));

  const db = new Database(filename);
  t.after(() => db.close());
  assert.ok(!columnNames(db, 'members').includes('is_fund'));
  assertDatabaseHealthy(db);
});

test('upgrades an older expenses table with current columns', (t) => {
  const filename = makeTempDatabase(t);
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

  assertMigrationSucceeded(runMigrations(filename));
  const db = new Database(filename);
  t.after(() => db.close());
  const columns = new Map(db.prepare('PRAGMA table_info(expenses)').all().map((column) => [
    column.name,
    column,
  ]));

  assert.ok(columns.has('deleted_at'));
  assert.ok(columns.has('receipt'));
  assert.ok(columns.has('note'));
  assert.ok(columns.has('kind'));
  assert.ok(columns.has('version'));
  assert.ok(columns.has('request_key'));
  assert.equal(columns.get('version').dflt_value, '1');
  assert.ok(!columnNames(db, 'members').includes('is_fund'));
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
  assertDatabaseHealthy(db);
});

test('removes only unreferenced legacy fund members and is idempotent', (t) => {
  const filename = makeTempDatabase(t);
  createLegacyFundDatabase(filename);

  const firstRun = runMigrations(filename);
  assertMigrationSucceeded(firstRun);
  assert.match(firstRun.stderr, /已移除 1 個未使用的舊公帳角色/);
  assertMigrationSucceeded(runMigrations(filename));

  const db = new Database(filename);
  t.after(() => db.close());
  assert.ok(!columnNames(db, 'members').includes('is_fund'));
  assert.deepEqual(
    db.prepare('SELECT id, name FROM members ORDER BY id').all(),
    [
      { id: 'named-public', name: '公帳' },
      { id: 'person', name: '一般成員' },
    ]
  );
  assert.equal(
    db.prepare(`SELECT value FROM admin_config
      WHERE key = 'remove_public_fund_role_v1'`).get().value,
    '1'
  );
  assertDatabaseHealthy(db);
});

test('referenced legacy fund members fail closed and preserve all ledger data', async (t) => {
  for (const reference of ['payer', 'split']) {
    await t.test(`legacy fund used as ${reference}`, (t) => {
      const filename = makeTempDatabase(t);
      createLegacyFundDatabase(filename, reference);

      const result = runMigrations(filename);
      assert.notEqual(result.status, 0, 'migration unexpectedly succeeded');
      assert.match(`${result.stderr}\n${result.stdout}`, /無法移除舊公帳角色：仍有 1 筆帳務關聯/);

      const db = new Database(filename);
      t.after(() => db.close());
      assert.ok(columnNames(db, 'members').includes('is_fund'));
      assert.deepEqual(
        db.prepare('SELECT id, name, is_fund FROM members ORDER BY id').all(),
        [
          { id: 'legacy-fund', name: '舊系統帳戶', is_fund: 1 },
          { id: 'named-public', name: '公帳', is_fund: 0 },
          { id: 'orphan-fund', name: '未使用的舊系統帳戶', is_fund: 1 },
          { id: 'person', name: '一般成員', is_fund: 0 },
        ]
      );
      assert.deepEqual(
        db.prepare(`SELECT id, payer_id, deleted_at FROM expenses
          WHERE id = 'deleted-expense'`).get(),
        {
          id: 'deleted-expense',
          payer_id: reference === 'payer' ? 'legacy-fund' : 'person',
          deleted_at: '2026-07-25 00:00:00',
        }
      );
      assert.deepEqual(
        db.prepare(`SELECT member_id, amount FROM expense_splits
          WHERE expense_id = 'deleted-expense'`).all(),
        [{ member_id: reference === 'split' ? 'legacy-fund' : 'person', amount: 10 }]
      );
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM admin_config
          WHERE key = 'remove_public_fund_role_v1'`).get().count,
        0
      );
      assertDatabaseHealthy(db);
    });
  }
});
