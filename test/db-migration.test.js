'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { calculateLedger } = require('../lib/ledger');

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

function columnInfo(db, table) {
  return new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => [
    column.name,
    column,
  ]));
}

function assertDatabaseHealthy(db) {
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

function createPreWalletDatabase(filename, { fundRole = false } = {}) {
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
      ${fundRole ? 'is_fund INTEGER NOT NULL DEFAULT 0,' : ''}
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
  `);
  return legacy;
}

function insertLegacyMembers(db, { fundRole = false } = {}) {
  if (fundRole) {
    db.exec(`
      INSERT INTO members (id, group_id, name, is_fund) VALUES
        ('person', 'group', '一般成員', 0),
        ('legacy-fund', 'group', '舊系統公帳', 1);
    `);
  } else {
    db.exec(`
      INSERT INTO members (id, group_id, name) VALUES
        ('person', 'group', '一般成員'),
        ('friend', 'group', '朋友');
    `);
  }
}

test('fresh schema creates one wallet per ledger and remains idempotent', (t) => {
  const filename = makeTempDatabase(t);

  assertMigrationSucceeded(runMigrations(filename));
  const setup = new Database(filename);
  setup.prepare(`INSERT INTO groups (id, name, code) VALUES ('group', '新帳本', 'ABC123')`).run();
  setup.close();
  assertMigrationSucceeded(runMigrations(filename));
  assertMigrationSucceeded(runMigrations(filename));

  const db = new Database(filename);
  t.after(() => db.close());
  const expenseColumns = columnInfo(db, 'expenses');
  assert.equal(columnInfo(db, 'members').has('is_fund'), false);
  assert.equal(expenseColumns.get('payer_id').notnull, 0);
  assert.ok(expenseColumns.has('payer_wallet_id'));
  assert.ok(expenseColumns.has('transfer_to_member_id'));
  assert.ok(expenseColumns.has('transfer_to_wallet_id'));
  assert.deepEqual(
    db.prepare('SELECT group_id, name FROM ledger_wallets').all(),
    [{ group_id: 'group', name: '公帳' }]
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM admin_config
      WHERE key = 'ledger_wallet_accounts_v1'`).get().count,
    1
  );
  assertDatabaseHealthy(db);
});

test('startup integrity repair accepts a shared wallet expense without splits', (t) => {
  const filename = makeTempDatabase(t);
  assertMigrationSucceeded(runMigrations(filename));

  const setup = new Database(filename);
  setup.exec(`
    INSERT INTO groups (id, name, code) VALUES ('group', '共同帳本', 'ABC123');
    INSERT INTO members (id, group_id, name) VALUES ('person', 'group', '一般成員');
  `);
  setup.close();
  assertMigrationSucceeded(runMigrations(filename));

  const seeded = new Database(filename);
  const wallet = seeded.prepare("SELECT id FROM ledger_wallets WHERE group_id = 'group'").get();
  seeded.prepare(`INSERT INTO expenses (
    id, group_id, payer_id, payer_wallet_id, description, amount, category,
    expense_date, kind
  ) VALUES ('shared', 'group', NULL, ?, '共同用品', 60, '其他', '2026-07-28', 'expense')`)
    .run(wallet.id);
  seeded.prepare("DELETE FROM admin_config WHERE key = 'ledger_integrity_cents_v1'").run();
  seeded.close();

  assertMigrationSucceeded(runMigrations(filename));
  const db = new Database(filename);
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM expense_splits WHERE expense_id = 'shared'").get().count,
    0
  );
  const entry = db.prepare("SELECT * FROM expenses WHERE id = 'shared'").get();
  entry.splits = [];
  const ledger = calculateLedger([{ id: 'person' }], [entry], [wallet]);
  assert.equal(ledger.walletLedgers[wallet.id].balanceCents, -6000);
  assert.equal(ledger.walletLedgers[wallet.id].sharedBalanceCents, -6000);
  assert.deepEqual(ledger.walletLedgers[wallet.id].positionsCents, { person: 0 });
  assertDatabaseHealthy(db);
});

test('upgrades old expense columns and repairs cent-level legacy drift', (t) => {
  const filename = makeTempDatabase(t);
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
    INSERT INTO expense_splits (expense_id, member_id, amount) VALUES
      ('expense', 'friend', 0.99),
      ('zero', 'friend', 0);
  `);
  legacy.close();

  assertMigrationSucceeded(runMigrations(filename));
  const db = new Database(filename);
  t.after(() => db.close());
  const columns = columnInfo(db, 'expenses');
  for (const name of [
    'deleted_at', 'receipt', 'note', 'kind', 'version', 'request_key',
    'payer_wallet_id', 'transfer_to_member_id', 'transfer_to_wallet_id',
  ]) assert.ok(columns.has(name), name);
  assert.equal(columnInfo(db, 'members').has('is_fund'), false);
  assert.deepEqual(
    db.prepare(`SELECT member_id, amount FROM expense_splits
      WHERE expense_id = 'expense' ORDER BY member_id`).all(),
    [
      { member_id: 'friend', amount: 0.99 },
      { member_id: 'payer', amount: 0.01 },
    ]
  );
  assert.equal(db.prepare("SELECT amount FROM expenses WHERE id = 'zero'").get().amount, 0.01);
  assert.equal(db.prepare(`SELECT SUM(amount) AS total FROM expense_splits
    WHERE expense_id = 'zero'`).get().total, 0.01);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_wallets').get().count, 1);
  assertDatabaseHealthy(db);
});

test('preserves a real member named 公帳 and never infers a wallet by name', (t) => {
  const filename = makeTempDatabase(t);
  const legacy = createPreWalletDatabase(filename);
  legacy.exec(`
    INSERT INTO members (id, group_id, name) VALUES
      ('person', 'group', '一般成員'),
      ('named-public', 'group', '公帳');
    INSERT INTO admin_config (key, value) VALUES ('remove_public_fund_role_v1', '1');
    INSERT INTO expenses (
      id, group_id, payer_id, description, amount, category, expense_date
    ) VALUES ('expense', 'group', 'person', '既有帳目', 10, '其他', '2026-07-25');
    INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES ('expense', 'named-public', 10);
  `);
  legacy.close();

  assertMigrationSucceeded(runMigrations(filename));
  assertMigrationSucceeded(runMigrations(filename));
  const db = new Database(filename);
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare('SELECT id, name FROM members ORDER BY id').all(),
    [
      { id: 'named-public', name: '公帳' },
      { id: 'person', name: '一般成員' },
    ]
  );
  const wallet = db.prepare('SELECT id, group_id, name FROM ledger_wallets').get();
  assert.equal(wallet.group_id, 'group');
  assert.equal(wallet.name, '公帳');
  assert.notEqual(wallet.id, 'named-public');
  assert.deepEqual(
    db.prepare(`SELECT member_id, amount FROM expense_splits WHERE expense_id = 'expense'`).all(),
    [{ member_id: 'named-public', amount: 10 }]
  );
  assertDatabaseHealthy(db);
});

test('converts only explicitly flagged legacy fund accounts into a wallet', async (t) => {
  const cases = [
    {
      name: 'wallet-paid expense',
      payerId: 'legacy-fund',
      targetId: 'person',
      kind: 'expense',
      category: '其他',
      expected: { payer_id: null, target: null, walletSource: true, walletTarget: false, splits: 1 },
    },
    {
      name: 'member deposit into wallet',
      payerId: 'person',
      targetId: 'legacy-fund',
      kind: 'expense',
      category: '轉帳',
      expected: { payer_id: 'person', target: null, walletSource: false, walletTarget: true, splits: 0 },
    },
    {
      name: 'wallet withdrawal to member',
      payerId: 'legacy-fund',
      targetId: 'person',
      kind: 'transfer',
      category: '轉帳',
      expected: { payer_id: null, target: 'person', walletSource: true, walletTarget: false, splits: 0 },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const filename = makeTempDatabase(t);
      const legacy = createPreWalletDatabase(filename, { fundRole: true });
      insertLegacyMembers(legacy, { fundRole: true });
      legacy.prepare(`INSERT INTO expenses (
        id, group_id, payer_id, description, amount, category, expense_date, kind
      ) VALUES ('entry', 'group', ?, ?, 10, ?, '2026-07-24', ?)`).run(
        scenario.payerId,
        scenario.name,
        scenario.category,
        scenario.kind
      );
      legacy.prepare(`INSERT INTO expense_splits (expense_id, member_id, amount)
        VALUES ('entry', ?, 10)`).run(scenario.targetId);
      legacy.close();

      assertMigrationSucceeded(runMigrations(filename));
      assertMigrationSucceeded(runMigrations(filename));
      const db = new Database(filename);
      t.after(() => db.close());
      const wallet = db.prepare('SELECT id, name FROM ledger_wallets').get();
      const entry = db.prepare(`SELECT payer_id, payer_wallet_id, transfer_to_member_id,
        transfer_to_wallet_id, kind FROM expenses WHERE id = 'entry'`).get();
      assert.equal(entry.payer_id, scenario.expected.payer_id);
      assert.equal(entry.payer_wallet_id === wallet.id, scenario.expected.walletSource);
      assert.equal(entry.transfer_to_member_id, scenario.expected.target);
      assert.equal(entry.transfer_to_wallet_id === wallet.id, scenario.expected.walletTarget);
      assert.equal(entry.kind, scenario.category === '轉帳' ? 'transfer' : scenario.kind);
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM expense_splits
          WHERE expense_id = 'entry'`).get().count,
        scenario.expected.splits
      );
      assert.deepEqual(db.prepare('SELECT id FROM members').all(), [{ id: 'person' }]);
      assert.equal(columnInfo(db, 'members').has('is_fund'), false);
      assertDatabaseHealthy(db);
    });
  }
});

test('preserves net balances from legacy transfer payer correction splits', async (t) => {
  const cases = [
    {
      name: 'member to member',
      fundRole: false,
      payerId: 'person',
      targetId: 'friend',
      expected: {
        payer_id: 'person', transfer_to_member_id: 'friend',
        walletSource: false, walletTarget: false,
      },
    },
    {
      name: 'member to wallet',
      fundRole: true,
      payerId: 'person',
      targetId: 'legacy-fund',
      expected: {
        payer_id: 'person', transfer_to_member_id: null,
        walletSource: false, walletTarget: true,
      },
    },
    {
      name: 'wallet to member',
      fundRole: true,
      payerId: 'legacy-fund',
      targetId: 'person',
      expected: {
        payer_id: null, transfer_to_member_id: 'person',
        walletSource: true, walletTarget: false,
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const filename = makeTempDatabase(t);
      const legacy = createPreWalletDatabase(filename, { fundRole: scenario.fundRole });
      insertLegacyMembers(legacy, { fundRole: scenario.fundRole });
      legacy.prepare(`INSERT INTO expenses (
        id, group_id, payer_id, description, amount, category, expense_date, kind
      ) VALUES ('entry', 'group', ?, ?, 10, '轉帳', '2026-07-28', 'expense')`).run(
        scenario.payerId,
        scenario.name
      );
      const insertSplit = legacy.prepare(`INSERT INTO expense_splits (
        expense_id, member_id, amount
      ) VALUES ('entry', ?, ?)`);
      insertSplit.run(scenario.targetId, 9.99);
      insertSplit.run(scenario.payerId, 0.01);
      legacy.prepare(`INSERT INTO admin_config (key, value)
        VALUES ('ledger_integrity_cents_v1', '1')`).run();
      legacy.close();

      assertMigrationSucceeded(runMigrations(filename));
      const db = new Database(filename);
      t.after(() => db.close());
      const wallet = db.prepare('SELECT id, name FROM ledger_wallets').get();
      const entry = db.prepare(`SELECT * FROM expenses WHERE id = 'entry'`).get();
      entry.splits = db.prepare(`SELECT member_id, amount FROM expense_splits
        WHERE expense_id = 'entry'`).all();

      assert.equal(entry.amount, 9.99);
      assert.equal(entry.kind, 'transfer');
      assert.equal(entry.payer_id, scenario.expected.payer_id);
      assert.equal(entry.payer_wallet_id === wallet.id, scenario.expected.walletSource);
      assert.equal(entry.transfer_to_member_id, scenario.expected.transfer_to_member_id);
      assert.equal(entry.transfer_to_wallet_id === wallet.id, scenario.expected.walletTarget);
      assert.deepEqual(entry.splits, []);

      const members = db.prepare('SELECT id FROM members ORDER BY id').all();
      const ledger = calculateLedger(members, [entry], [wallet]);
      if (!scenario.fundRole) {
        assert.deepEqual(ledger.balancesCents, { friend: -999, person: 999 });
        assert.deepEqual(ledger.walletLedgers[wallet.id].positionsCents, {
          friend: 0, person: 0,
        });
      } else if (scenario.expected.walletTarget) {
        assert.deepEqual(ledger.balancesCents, { person: 0 });
        assert.equal(ledger.walletLedgers[wallet.id].balanceCents, 999);
        assert.deepEqual(ledger.walletLedgers[wallet.id].positionsCents, { person: 999 });
      } else {
        assert.deepEqual(ledger.balancesCents, { person: 0 });
        assert.equal(ledger.walletLedgers[wallet.id].balanceCents, -999);
        assert.deepEqual(ledger.walletLedgers[wallet.id].positionsCents, { person: -999 });
      }
      assertDatabaseHealthy(db);
    });
  }
});

test('rejects ambiguous or nonconserving legacy transfer corrections', async (t) => {
  const cases = [
    {
      name: 'multiple non-source targets',
      splits: [['friend', 5], ['other', 4.99], ['person', 0.01]],
      error: /只能有一個非來源收款對象/,
    },
    {
      name: 'negative correction',
      splits: [['friend', 10.01], ['person', -0.01]],
      error: /不能為負數/,
    },
    {
      name: 'nonconserving correction',
      splits: [['friend', 9.98], ['person', 0.01]],
      error: /總額與帳目金額不一致/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const filename = makeTempDatabase(t);
      const legacy = createPreWalletDatabase(filename);
      insertLegacyMembers(legacy);
      legacy.prepare(`INSERT INTO members (id, group_id, name)
        VALUES ('other', 'group', '其他成員')`).run();
      legacy.prepare(`INSERT INTO expenses (
        id, group_id, payer_id, description, amount, category, expense_date, kind
      ) VALUES ('entry', 'group', 'person', ?, 10, '轉帳', '2026-07-28', 'expense')`)
        .run(scenario.name);
      const insertSplit = legacy.prepare(`INSERT INTO expense_splits (
        expense_id, member_id, amount
      ) VALUES ('entry', ?, ?)`);
      for (const [memberId, amount] of scenario.splits) insertSplit.run(memberId, amount);
      legacy.prepare(`INSERT INTO admin_config (key, value)
        VALUES ('ledger_integrity_cents_v1', '1')`).run();
      legacy.close();

      const result = runMigrations(filename);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario.error);

      const db = new Database(filename);
      t.after(() => db.close());
      assert.equal(db.prepare("SELECT amount FROM expenses WHERE id = 'entry'").get().amount, 10);
      assert.deepEqual(
        db.prepare(`SELECT member_id, amount FROM expense_splits
          WHERE expense_id = 'entry' ORDER BY member_id`).all(),
        scenario.splits
          .map(([member_id, amount]) => ({ member_id, amount }))
          .sort((left, right) => left.member_id.localeCompare(right.member_id))
      );
      assert.equal(columnInfo(db, 'expenses').has('payer_wallet_id'), false);
      assertDatabaseHealthy(db);
    });
  }
});

test('fails closed when a legacy fund was used as a non-transfer split', (t) => {
  const filename = makeTempDatabase(t);
  const legacy = createPreWalletDatabase(filename, { fundRole: true });
  insertLegacyMembers(legacy, { fundRole: true });
  legacy.exec(`
    INSERT INTO expenses (
      id, group_id, payer_id, description, amount, category, expense_date, kind
    ) VALUES ('ambiguous', 'group', 'person', '無法判定', 10, '其他', '2026-07-24', 'expense');
    INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES ('ambiguous', 'legacy-fund', 10);
  `);
  legacy.close();

  const result = runMigrations(filename);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /非轉帳帳目.*舊公帳|無法升級公帳錢包/);

  const db = new Database(filename);
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(`SELECT payer_id FROM expenses WHERE id = 'ambiguous'`).get(),
    { payer_id: 'person' }
  );
  assert.deepEqual(
    db.prepare(`SELECT member_id, amount FROM expense_splits WHERE expense_id = 'ambiguous'`).all(),
    [{ member_id: 'legacy-fund', amount: 10 }]
  );
  assert.equal(columnInfo(db, 'members').has('is_fund'), true);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM admin_config
      WHERE key = 'ledger_wallet_accounts_v1'`).get().count,
    0
  );
  assertDatabaseHealthy(db);
});

test('fails closed when legacy split totals cannot be repaired', (t) => {
  const filename = makeTempDatabase(t);
  const legacy = createPreWalletDatabase(filename);
  insertLegacyMembers(legacy);
  legacy.exec(`
    INSERT INTO expenses (
      id, group_id, payer_id, description, amount, category, expense_date, kind
    ) VALUES ('broken', 'group', 'person', '無法守恆', 10, '其他', '2026-07-28', 'expense');
    INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES ('broken', 'friend', 5);
  `);
  legacy.close();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runMigrations(filename);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /完整性遷移失敗.*無法安全自動修復/);
  }

  const db = new Database(filename);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT amount FROM expenses WHERE id = 'broken'").get().amount, 10);
  assert.deepEqual(
    db.prepare(`SELECT member_id, amount FROM expense_splits WHERE expense_id = 'broken'`).all(),
    [{ member_id: 'friend', amount: 5 }]
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM admin_config
      WHERE key = 'ledger_integrity_cents_v1'`).get().count,
    0
  );
  assertDatabaseHealthy(db);
});

test('startup audit rejects nonconserving data even after migration markers exist', (t) => {
  const filename = makeTempDatabase(t);
  assertMigrationSucceeded(runMigrations(filename));
  const setup = new Database(filename);
  setup.prepare(`INSERT INTO groups (id, name, code) VALUES ('group', '帳本', 'ABC123')`).run();
  setup.close();
  assertMigrationSucceeded(runMigrations(filename));

  const corrupt = new Database(filename);
  corrupt.pragma('foreign_keys = ON');
  corrupt.prepare(`INSERT INTO members (id, group_id, name)
    VALUES ('person', 'group', '一般成員')`).run();
  corrupt.prepare(`INSERT INTO expenses (
    id, group_id, payer_id, description, amount, category, expense_date, kind
  ) VALUES ('broken', 'group', 'person', '無法守恆', 10, '其他', '2026-07-28', 'expense')`).run();
  corrupt.prepare(`INSERT INTO expense_splits (expense_id, member_id, amount)
    VALUES ('broken', 'person', 5)`).run();
  corrupt.close();

  const result = runMigrations(filename);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /完整性檢查失敗.*無法守恆/);

  const db = new Database(filename);
  t.after(() => db.close());
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM admin_config
      WHERE key = 'ledger_integrity_cents_v1'`).get().count,
    1
  );
  assertDatabaseHealthy(db);
});

test('database constraints reject mixed sources and cross-ledger accounts', (t) => {
  const filename = makeTempDatabase(t);
  assertMigrationSucceeded(runMigrations(filename));
  const setup = new Database(filename);
  setup.exec(`
    INSERT INTO groups (id, name, code) VALUES
      ('one', '一號帳本', 'ONE111'),
      ('two', '二號帳本', 'TWO222');
    INSERT INTO members (id, group_id, name) VALUES
      ('one-member', 'one', '甲'),
      ('two-member', 'two', '乙');
  `);
  setup.close();
  assertMigrationSucceeded(runMigrations(filename));

  const db = new Database(filename);
  t.after(() => db.close());
  const oneWallet = db.prepare("SELECT id FROM ledger_wallets WHERE group_id = 'one'").get().id;
  const twoWallet = db.prepare("SELECT id FROM ledger_wallets WHERE group_id = 'two'").get().id;
  const insert = db.prepare(`INSERT INTO expenses (
    id, group_id, payer_id, payer_wallet_id, transfer_to_member_id, transfer_to_wallet_id,
    description, amount, category, expense_date, kind
  ) VALUES (?, 'one', ?, ?, ?, ?, '測試', 1, ?, '2026-07-27', ?)`);

  assert.throws(
    () => insert.run('two-sources', 'one-member', oneWallet, null, null, '其他', 'expense'),
    /CHECK constraint/
  );
  assert.throws(
    () => insert.run('cross-member', 'two-member', null, null, null, '其他', 'expense'),
    /another group/
  );
  assert.throws(
    () => insert.run('cross-wallet', null, twoWallet, null, null, '其他', 'expense'),
    /another group/
  );
  assert.throws(
    () => insert.run('cross-target', 'one-member', null, 'two-member', null, '轉帳', 'transfer'),
    /another group/
  );
  assert.throws(
    () => insert.run('wallet-target', 'one-member', null, null, oneWallet, '其他', 'expense'),
    /CHECK constraint/
  );
  assertDatabaseHealthy(db);
});
