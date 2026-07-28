const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const { calculateLedger, centsToMoney, moneyToCents } = require('./lib/ledger');

const databasePath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data.db');
const db = new Database(databasePath);
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

CREATE TABLE IF NOT EXISTS ledger_wallets (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '公帳',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  payer_id TEXT REFERENCES members(id),
  payer_wallet_id TEXT REFERENCES ledger_wallets(id),
  transfer_to_member_id TEXT REFERENCES members(id),
  transfer_to_wallet_id TEXT REFERENCES ledger_wallets(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT '其他',
  expense_date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  receipt TEXT,
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer')),
  version INTEGER NOT NULL DEFAULT 1,
  request_key TEXT,
  CHECK ((payer_id IS NOT NULL) <> (payer_wallet_id IS NOT NULL)),
  CHECK ((transfer_to_member_id IS NULL) OR (transfer_to_wallet_id IS NULL)),
  CHECK (
    (kind = 'transfer' AND ((transfer_to_member_id IS NOT NULL) <> (transfer_to_wallet_id IS NOT NULL)))
    OR
    (kind IN ('expense', 'income') AND transfer_to_member_id IS NULL AND transfer_to_wallet_id IS NULL)
  ),
  CHECK (payer_id IS NULL OR transfer_to_member_id IS NULL OR payer_id <> transfer_to_member_id),
  CHECK (payer_wallet_id IS NULL OR transfer_to_wallet_id IS NULL OR payer_wallet_id <> transfer_to_wallet_id)
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

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  model TEXT,
  has_receipt INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
`);

// 先補齊舊版欄位，再把付款來源與轉帳去向升級成 member / wallet 明確關聯。
let expenseCols = db.prepare('PRAGMA table_info(expenses)').all();
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
if (!expenseCols.some((c) => c.name === 'version')) {
  db.exec('ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}
if (!expenseCols.some((c) => c.name === 'request_key')) {
  db.exec('ALTER TABLE expenses ADD COLUMN request_key TEXT');
}
const memberCols = db.prepare('PRAGMA table_info(members)').all();
const hasLegacyFundRole = memberCols.some((column) => column.name === 'is_fund');
expenseCols = db.prepare('PRAGMA table_info(expenses)').all();
const payerColumn = expenseCols.find((column) => column.name === 'payer_id');
const expenseTableSql = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expenses'"
).get()?.sql || '';
const needsWalletMigration = hasLegacyFundRole
  || !expenseCols.some((column) => column.name === 'payer_wallet_id')
  || !expenseCols.some((column) => column.name === 'transfer_to_member_id')
  || !expenseCols.some((column) => column.name === 'transfer_to_wallet_id')
  || payerColumn?.notnull === 1
  || !expenseTableSql.includes(
    'CHECK ((payer_id IS NOT NULL) <> (payer_wallet_id IS NOT NULL))'
  );

function ensureWallet(groupId, preferred = null) {
  const existing = db.prepare('SELECT * FROM ledger_wallets WHERE group_id = ?').get(groupId);
  if (existing) return existing;
  const wallet = {
    id: preferred?.id || crypto.randomUUID(),
    group_id: groupId,
    name: preferred?.name || '公帳',
  };
  db.prepare('INSERT INTO ledger_wallets (id, group_id, name) VALUES (?, ?, ?)')
    .run(wallet.id, wallet.group_id, wallet.name);
  return wallet;
}

if (needsWalletMigration) {
  const legacyFunds = hasLegacyFundRole
    ? db.prepare(`SELECT id, group_id, name FROM members WHERE is_fund = 1
      ORDER BY created_at, rowid`).all()
    : [];
  const duplicateFund = hasLegacyFundRole
    ? db.prepare(`SELECT group_id FROM members WHERE is_fund = 1
      GROUP BY group_id HAVING COUNT(*) > 1 LIMIT 1`).get()
    : null;
  if (duplicateFund) {
    throw new Error(`無法升級公帳錢包：帳本 ${duplicateFund.group_id} 有多個舊公帳角色`);
  }
  const groups = db.prepare('SELECT id FROM groups ORDER BY created_at').all();
  const groupIds = new Set(groups.map((group) => group.id));
  const members = hasLegacyFundRole
    ? db.prepare('SELECT id, group_id, name, is_fund FROM members').all()
    : db.prepare('SELECT id, group_id, name, 0 AS is_fund FROM members').all();
  const memberById = new Map(members.map((member) => [member.id, member]));
  const fundByGroup = new Map(legacyFunds.map((fund) => [fund.group_id, fund]));
  const existingWallets = db.prepare('SELECT id, group_id, name FROM ledger_wallets').all();
  const walletById = new Map(existingWallets.map((wallet) => [wallet.id, wallet]));
  const walletByGroup = new Map(existingWallets.map((wallet) => [wallet.group_id, wallet]));
  for (const group of groups) {
    if (walletByGroup.has(group.id)) continue;
    const fund = fundByGroup.get(group.id);
    const wallet = {
      id: fund?.id || crypto.randomUUID(),
      group_id: group.id,
      name: fund?.name || '公帳',
    };
    walletByGroup.set(group.id, wallet);
    walletById.set(wallet.id, wallet);
  }

  const splitRows = db.prepare(`SELECT s.rowid, s.expense_id, s.member_id, s.amount
    FROM expense_splits s ORDER BY s.rowid`).all();
  const splitsByExpense = new Map();
  for (const split of splitRows) {
    const splits = splitsByExpense.get(split.expense_id) || [];
    splits.push(split);
    splitsByExpense.set(split.expense_id, splits);
  }
  const oldExpenses = db.prepare('SELECT rowid, * FROM expenses ORDER BY rowid').all();
  const convertedExpenses = [];
  const transferIds = [];
  let removedTransferSplits = 0;

  const migrationError = (entry, message) => {
    throw new Error(`無法升級公帳錢包：帳目 ${entry.id} ${message}`);
  };
  const walletAccount = (wallet) => ({ type: 'wallet', id: wallet.id });
  const memberAccount = (member) => ({ type: 'member', id: member.id });
  const resolveMemberAccount = (entry, memberId, label, allowFund) => {
    const member = memberById.get(memberId);
    if (!member || member.group_id !== entry.group_id) {
      migrationError(entry, `${label}含不存在或跨帳本的成員`);
    }
    if (!member.is_fund) return memberAccount(member);
    if (!allowFund) migrationError(entry, '非轉帳紀錄將舊公帳列為分攤對象');
    return walletAccount(walletByGroup.get(entry.group_id));
  };
  const resolveWalletAccount = (entry, walletId, label) => {
    const wallet = walletById.get(walletId);
    if (!wallet || wallet.group_id !== entry.group_id) {
      migrationError(entry, `${label}含不存在或跨帳本的公帳錢包`);
    }
    return walletAccount(wallet);
  };
  const sameAccount = (left, right) => left.type === right.type && left.id === right.id;

  for (const entry of oldExpenses) {
    if (!groupIds.has(entry.group_id)) migrationError(entry, '所屬帳本不存在');
    const wallet = walletByGroup.get(entry.group_id);
    const payerId = entry.payer_id ?? null;
    const payerWalletId = entry.payer_wallet_id ?? null;
    if ((payerId === null) === (payerWalletId === null)) {
      migrationError(entry, '必須且只能有一個款項來源');
    }
    let source;
    if (payerId !== null) {
      const payer = memberById.get(payerId);
      if (!payer || payer.group_id !== entry.group_id) {
        migrationError(entry, '付款來源含不存在或跨帳本的成員');
      }
      source = payer.is_fund ? walletAccount(wallet) : memberAccount(payer);
    } else {
      source = resolveWalletAccount(entry, payerWalletId, '付款來源');
    }

    const splits = splitsByExpense.get(entry.id) || [];
    const parsedSplits = [];
    for (const split of splits) {
      let cents;
      try { cents = moneyToCents(split.amount); } catch {
        migrationError(entry, '分攤金額格式不正確');
      }
      if (cents < 0) migrationError(entry, '分攤金額不能為負數');
      parsedSplits.push({
        ...split,
        cents,
        account: resolveMemberAccount(entry, split.member_id, '分攤資料', true),
      });
    }
    let amountCents;
    try { amountCents = moneyToCents(entry.amount); } catch {
      migrationError(entry, '金額格式不正確');
    }
    const isTransfer = entry.kind === 'transfer' || ['還款', '轉帳'].includes(entry.category);
    let target = null;
    let transferAmountCents = amountCents;
    if (isTransfer) {
      if (amountCents <= 0) migrationError(entry, '轉帳金額必須大於 0');
      const explicitMemberId = entry.transfer_to_member_id ?? null;
      const explicitWalletId = entry.transfer_to_wallet_id ?? null;
      if (explicitMemberId !== null && explicitWalletId !== null) {
        migrationError(entry, '轉帳有多個去向');
      }
      if (explicitMemberId !== null) {
        target = resolveMemberAccount(entry, explicitMemberId, '轉帳去向', true);
      } else if (explicitWalletId !== null) {
        target = resolveWalletAccount(entry, explicitWalletId, '轉帳去向');
      }

      let splitTarget = null;
      if (parsedSplits.length > 0) {
        let splitTotalCents = 0;
        const nonSourceSplits = [];
        for (const split of parsedSplits) {
          if (!Number.isSafeInteger(splitTotalCents + split.cents)) {
            migrationError(entry, '轉帳分攤總額超過系統上限');
          }
          splitTotalCents += split.cents;
          if (!sameAccount(split.account, source)) nonSourceSplits.push(split);
        }
        if (splitTotalCents !== amountCents) {
          migrationError(entry, '轉帳分攤總額與帳目金額不一致');
        }
        if (nonSourceSplits.length !== 1) {
          migrationError(entry, '轉帳必須且只能有一個非來源收款對象');
        }
        const recipient = nonSourceSplits[0];
        if (recipient.cents <= 0) migrationError(entry, '轉帳實際收款金額必須大於 0');
        splitTarget = recipient.account;
        transferAmountCents = recipient.cents;
      }
      if (!target) target = splitTarget;
      if (!target || (splitTarget && !sameAccount(target, splitTarget))) {
        migrationError(entry, '轉帳的顯式去向與舊分攤資料不一致');
      }
      if (sameAccount(source, target)) migrationError(entry, '轉帳來源與去向相同');
      if (source.type === 'wallet' && target.type === 'wallet') {
        migrationError(entry, '不支援公帳錢包互轉');
      }
      transferIds.push(entry.id);
      removedTransferSplits += splits.length;
    } else {
      if (entry.transfer_to_member_id != null || entry.transfer_to_wallet_id != null) {
        migrationError(entry, '非轉帳紀錄不應有轉帳去向');
      }
      const isSharedWalletExpense = source.type === 'wallet'
        && entry.kind === 'expense'
        && splits.length === 0;
      if (splits.length === 0 && !isSharedWalletExpense) migrationError(entry, '缺少分攤資料');
      for (const split of splits) {
        resolveMemberAccount(entry, split.member_id, '分攤資料', false);
      }
    }

    convertedExpenses.push({
      ...entry,
      payer_id: source.type === 'member' ? source.id : null,
      payer_wallet_id: source.type === 'wallet' ? source.id : null,
      transfer_to_member_id: target?.type === 'member' ? target.id : null,
      transfer_to_wallet_id: target?.type === 'wallet' ? target.id : null,
      amount: isTransfer ? centsToMoney(transferAmountCents) : entry.amount,
      kind: isTransfer ? 'transfer' : entry.kind === 'income' ? 'income' : 'expense',
    });
  }

  const beforeExpenseCount = oldExpenses.length;
  const beforeSplitCount = splitRows.length;
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  if (db.pragma('foreign_keys', { simple: true }) !== 0) {
    throw new Error('無法升級公帳錢包：無法暫停 SQLite 外鍵檢查');
  }
  try {
    db.transaction(() => {
      for (const group of groups) ensureWallet(group.id, walletByGroup.get(group.id));

      db.exec(`
        CREATE TABLE expenses_wallet_v1 (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          payer_id TEXT REFERENCES members(id),
          payer_wallet_id TEXT REFERENCES ledger_wallets(id),
          transfer_to_member_id TEXT REFERENCES members(id),
          transfer_to_wallet_id TEXT REFERENCES ledger_wallets(id),
          description TEXT NOT NULL,
          amount REAL NOT NULL,
          category TEXT NOT NULL DEFAULT '其他',
          expense_date TEXT NOT NULL DEFAULT (date('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at TEXT,
          receipt TEXT,
          note TEXT,
          kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer')),
          version INTEGER NOT NULL DEFAULT 1,
          request_key TEXT,
          CHECK ((payer_id IS NOT NULL) <> (payer_wallet_id IS NOT NULL)),
          CHECK ((transfer_to_member_id IS NULL) OR (transfer_to_wallet_id IS NULL)),
          CHECK (
            (kind = 'transfer' AND ((transfer_to_member_id IS NOT NULL) <> (transfer_to_wallet_id IS NOT NULL)))
            OR
            (kind IN ('expense', 'income') AND transfer_to_member_id IS NULL AND transfer_to_wallet_id IS NULL)
          ),
          CHECK (payer_id IS NULL OR transfer_to_member_id IS NULL OR payer_id <> transfer_to_member_id),
          CHECK (payer_wallet_id IS NULL OR transfer_to_wallet_id IS NULL OR payer_wallet_id <> transfer_to_wallet_id)
        );

      `);
      const insertExpense = db.prepare(`INSERT INTO expenses_wallet_v1 (
        id, group_id, payer_id, payer_wallet_id, transfer_to_member_id,
        transfer_to_wallet_id, description, amount, category, expense_date,
        created_at, deleted_at, receipt, note, kind, version, request_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of convertedExpenses) {
        insertExpense.run(
          entry.id, entry.group_id, entry.payer_id, entry.payer_wallet_id,
          entry.transfer_to_member_id, entry.transfer_to_wallet_id, entry.description,
          entry.amount, entry.category, entry.expense_date, entry.created_at,
          entry.deleted_at, entry.receipt, entry.note, entry.kind, entry.version,
          entry.request_key
        );
      }
      const deleteTransferSplits = db.prepare(
        'DELETE FROM expense_splits WHERE expense_id = ?'
      );
      for (const expenseId of transferIds) deleteTransferSplits.run(expenseId);
      db.exec(`
        DROP TABLE expenses;
        ALTER TABLE expenses_wallet_v1 RENAME TO expenses;
        CREATE INDEX idx_expenses_group ON expenses(group_id);
        CREATE INDEX idx_expenses_transfer_member ON expenses(transfer_to_member_id);
        CREATE UNIQUE INDEX idx_expenses_request_key
          ON expenses(request_key) WHERE request_key IS NOT NULL;
      `);

      if (hasLegacyFundRole) {
        db.prepare('DELETE FROM members WHERE is_fund = 1').run();
        db.exec('ALTER TABLE members DROP COLUMN is_fund');
      }
      db.prepare(`INSERT INTO admin_config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run('ledger_wallet_accounts_v1', '1');

      const afterExpenseCount = db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count;
      const afterSplitCount = db.prepare('SELECT COUNT(*) AS count FROM expense_splits').get().count;
      if (afterExpenseCount !== beforeExpenseCount
        || afterSplitCount !== beforeSplitCount - removedTransferSplits) {
        throw new Error('公帳錢包遷移筆數核對失敗');
      }
      const foreignKeyErrors = db.pragma('foreign_key_check');
      if (foreignKeyErrors.length) throw new Error('公帳錢包遷移外鍵核對失敗');
    })();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
  if (foreignKeysEnabled && db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('公帳錢包遷移後無法恢復 SQLite 外鍵檢查');
  }
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_request_key
  ON expenses(request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_transfer_member ON expenses(transfer_to_member_id);`);

// 舊版在驗證後才逐筆四捨五入，可能留下小額差異或 0 元紀錄。
const LEDGER_MIGRATION_KEY = 'ledger_integrity_cents_v1';
const migrationApplied = db.prepare('SELECT 1 FROM admin_config WHERE key = ?')
  .get(LEDGER_MIGRATION_KEY);
if (!migrationApplied) {
  const migration = db.transaction(() => {
    const expenses = db.prepare(
      'SELECT id, payer_id, payer_wallet_id, amount, kind, category FROM expenses'
    ).all();
    const getSplits = db.prepare(
      'SELECT rowid, member_id, amount FROM expense_splits WHERE expense_id = ? ORDER BY rowid'
    );
    const updateExpense = db.prepare('UPDATE expenses SET amount = ? WHERE id = ?');
    const updateSplit = db.prepare('UPDATE expense_splits SET amount = ? WHERE rowid = ?');
    const insertSplit = db.prepare(
      'INSERT INTO expense_splits (expense_id, member_id, amount) VALUES (?, ?, ?)'
    );
    let repaired = 0;
    let unresolved = 0;

    for (const expense of expenses) {
      let amountCents;
      try { amountCents = moneyToCents(expense.amount); } catch {
        unresolved += 1;
        continue;
      }
      if (amountCents < 0) {
        unresolved += 1;
        continue;
      }

      if (expense.kind === 'transfer' || ['還款', '轉帳'].includes(expense.category)) {
        if (amountCents === 0) amountCents = 1;
        const normalizedAmount = centsToMoney(amountCents);
        if (expense.amount !== normalizedAmount) updateExpense.run(normalizedAmount, expense.id);
        continue;
      }

      const splits = getSplits.all(expense.id);
      let splitTotalCents = 0;
      let valid = true;
      for (const split of splits) {
        try {
          split.cents = moneyToCents(split.amount);
          if (split.cents < 0 || !Number.isSafeInteger(splitTotalCents + split.cents)) valid = false;
          splitTotalCents += split.cents;
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        unresolved += 1;
        continue;
      }

      if (expense.kind === 'expense' && expense.payer_wallet_id && splits.length === 0) {
        if (amountCents === 0) amountCents = 1;
        const normalizedAmount = centsToMoney(amountCents);
        if (expense.amount !== normalizedAmount) updateExpense.run(normalizedAmount, expense.id);
        continue;
      }

      if (amountCents === 0) amountCents = 1;
      const difference = amountCents - splitTotalCents;
      const maximumLegacyDifference = Math.max(1, splits.length);
      if (Math.abs(difference) > maximumLegacyDifference) {
        unresolved += 1;
        continue;
      }

      const normalizedAmount = centsToMoney(amountCents);
      if (expense.amount !== normalizedAmount) updateExpense.run(normalizedAmount, expense.id);
      for (const split of splits) {
        const normalizedSplit = centsToMoney(split.cents);
        if (split.amount !== normalizedSplit) updateSplit.run(normalizedSplit, split.rowid);
      }

      if (difference === 0) continue;
      repaired += 1;
      if (difference > 0) {
        const payerSplit = splits.find((split) => split.member_id === expense.payer_id)
          || (expense.payer_wallet_id ? splits[0] : null);
        if (payerSplit) {
          updateSplit.run(centsToMoney(payerSplit.cents + difference), payerSplit.rowid);
        } else if (expense.payer_id) {
          insertSplit.run(expense.id, expense.payer_id, centsToMoney(difference));
        } else {
          repaired -= 1;
          unresolved += 1;
        }
        continue;
      }

      let excess = -difference;
      const reductionOrder = [...splits].sort((left, right) =>
        Number(right.member_id === expense.payer_id) - Number(left.member_id === expense.payer_id)
        || right.cents - left.cents
      );
      for (const split of reductionOrder) {
        const reduction = Math.min(split.cents, excess);
        split.cents -= reduction;
        excess -= reduction;
        updateSplit.run(centsToMoney(split.cents), split.rowid);
        if (excess === 0) break;
      }
    }

    if (unresolved > 0) {
      throw new Error(`帳務資料完整性遷移失敗：有 ${unresolved} 筆紀錄無法安全自動修復`);
    }
    db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?)')
      .run(LEDGER_MIGRATION_KEY, '1');
    return { repaired, unresolved };
  })();

  if (migration.repaired > 0) {
    console.warn(`已修復 ${migration.repaired} 筆舊版分攤金額誤差。`);
  }
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
    ins.run(crypto.randomUUID(), groupId, name, icon, i);
  });
};
db.seedWallet = (groupId) => ensureWallet(groupId);

// SQLite 外鍵只能確認 ID 存在，這些 trigger 再保證交易雙方都屬於同一本帳。
db.exec(`
DROP TRIGGER IF EXISTS expenses_account_group_insert;
DROP TRIGGER IF EXISTS expenses_account_group_update;
DROP TRIGGER IF EXISTS expense_splits_group_insert;
DROP TRIGGER IF EXISTS expense_splits_group_update;
DROP TRIGGER IF EXISTS expenses_transfer_cleanup;
DROP TRIGGER IF EXISTS members_group_immutable;
DROP TRIGGER IF EXISTS ledger_wallets_group_immutable;

CREATE TRIGGER expenses_account_group_insert
BEFORE INSERT ON expenses BEGIN
  SELECT RAISE(ABORT, 'reserved transfer category requires transfer kind')
    WHERE NEW.category IN ('還款', '轉帳') AND NEW.kind <> 'transfer';
  SELECT RAISE(ABORT, 'payer member belongs to another group')
    WHERE NEW.payer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM members WHERE id = NEW.payer_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'payer wallet belongs to another group')
    WHERE NEW.payer_wallet_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_wallets WHERE id = NEW.payer_wallet_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'target member belongs to another group')
    WHERE NEW.transfer_to_member_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM members WHERE id = NEW.transfer_to_member_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'target wallet belongs to another group')
    WHERE NEW.transfer_to_wallet_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_wallets WHERE id = NEW.transfer_to_wallet_id AND group_id = NEW.group_id
    );
END;

CREATE TRIGGER expenses_account_group_update
BEFORE UPDATE OF group_id, payer_id, payer_wallet_id, transfer_to_member_id,
  transfer_to_wallet_id, kind, category
ON expenses BEGIN
  SELECT RAISE(ABORT, 'reserved transfer category requires transfer kind')
    WHERE NEW.category IN ('還款', '轉帳') AND NEW.kind <> 'transfer';
  SELECT RAISE(ABORT, 'payer member belongs to another group')
    WHERE NEW.payer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM members WHERE id = NEW.payer_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'payer wallet belongs to another group')
    WHERE NEW.payer_wallet_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_wallets WHERE id = NEW.payer_wallet_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'target member belongs to another group')
    WHERE NEW.transfer_to_member_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM members WHERE id = NEW.transfer_to_member_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'target wallet belongs to another group')
    WHERE NEW.transfer_to_wallet_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_wallets WHERE id = NEW.transfer_to_wallet_id AND group_id = NEW.group_id
    );
  SELECT RAISE(ABORT, 'split member belongs to another group')
    WHERE EXISTS (
      SELECT 1 FROM expense_splits s
      JOIN members m ON m.id = s.member_id
      WHERE s.expense_id = NEW.id AND m.group_id <> NEW.group_id
    );
END;

CREATE TRIGGER expense_splits_group_insert
BEFORE INSERT ON expense_splits BEGIN
  SELECT RAISE(ABORT, 'transfer entries cannot have splits')
    WHERE EXISTS (
      SELECT 1 FROM expenses WHERE id = NEW.expense_id AND kind = 'transfer'
    );
  SELECT RAISE(ABORT, 'split member belongs to another group')
    WHERE NOT EXISTS (
      SELECT 1 FROM expenses e JOIN members m ON m.id = NEW.member_id
      WHERE e.id = NEW.expense_id AND e.group_id = m.group_id
    );
END;

CREATE TRIGGER expense_splits_group_update
BEFORE UPDATE OF expense_id, member_id ON expense_splits BEGIN
  SELECT RAISE(ABORT, 'transfer entries cannot have splits')
    WHERE EXISTS (
      SELECT 1 FROM expenses WHERE id = NEW.expense_id AND kind = 'transfer'
    );
  SELECT RAISE(ABORT, 'split member belongs to another group')
    WHERE NOT EXISTS (
      SELECT 1 FROM expenses e JOIN members m ON m.id = NEW.member_id
      WHERE e.id = NEW.expense_id AND e.group_id = m.group_id
    );
END;

CREATE TRIGGER expenses_transfer_cleanup
AFTER UPDATE OF kind ON expenses
WHEN NEW.kind = 'transfer' BEGIN
  DELETE FROM expense_splits WHERE expense_id = NEW.id;
END;

CREATE TRIGGER members_group_immutable
BEFORE UPDATE OF group_id ON members
WHEN NEW.group_id <> OLD.group_id BEGIN
  SELECT RAISE(ABORT, 'member group cannot be changed');
END;

CREATE TRIGGER ledger_wallets_group_immutable
BEFORE UPDATE OF group_id ON ledger_wallets
WHEN NEW.group_id <> OLD.group_id BEGIN
  SELECT RAISE(ABORT, 'wallet group cannot be changed');
END;
`);

for (const g of db.prepare('SELECT id FROM groups').all()) {
  db.seedCategories(g.id);
  db.seedWallet(g.id);
}

const invalidAccountGroup = db.prepare(`SELECT e.id FROM expenses e
  LEFT JOIN members payer ON payer.id = e.payer_id
  LEFT JOIN ledger_wallets payer_wallet ON payer_wallet.id = e.payer_wallet_id
  LEFT JOIN members target ON target.id = e.transfer_to_member_id
  LEFT JOIN ledger_wallets target_wallet ON target_wallet.id = e.transfer_to_wallet_id
  WHERE (e.payer_id IS NOT NULL AND (payer.id IS NULL OR payer.group_id <> e.group_id))
    OR (e.payer_wallet_id IS NOT NULL
      AND (payer_wallet.id IS NULL OR payer_wallet.group_id <> e.group_id))
    OR (e.transfer_to_member_id IS NOT NULL
      AND (target.id IS NULL OR target.group_id <> e.group_id))
    OR (e.transfer_to_wallet_id IS NOT NULL
      AND (target_wallet.id IS NULL OR target_wallet.group_id <> e.group_id))
  LIMIT 1`).get();
const invalidSplitGroup = db.prepare(`SELECT e.id FROM expenses e
  JOIN expense_splits s ON s.expense_id = e.id
  LEFT JOIN members m ON m.id = s.member_id
  WHERE m.id IS NULL OR m.group_id <> e.group_id LIMIT 1`).get();
const transferWithSplits = db.prepare(`SELECT e.id FROM expenses e
  JOIN expense_splits s ON s.expense_id = e.id
  WHERE e.kind = 'transfer' LIMIT 1`).get();
const noncanonicalTransfer = db.prepare(`SELECT id FROM expenses
  WHERE category IN ('還款', '轉帳') AND kind <> 'transfer' LIMIT 1`).get();
if (invalidAccountGroup || invalidSplitGroup || transferWithSplits || noncanonicalTransfer) {
  const invalidId = invalidAccountGroup?.id || invalidSplitGroup?.id
    || transferWithSplits?.id || noncanonicalTransfer.id;
  throw new Error(`帳務資料完整性檢查失敗：帳目 ${invalidId} 的帳戶或分攤關聯不正確`);
}
const foreignKeyErrors = db.pragma('foreign_key_check');
if (foreignKeyErrors.length) {
  throw new Error(`帳務資料完整性檢查失敗：發現 ${foreignKeyErrors.length} 個外鍵錯誤`);
}

const auditSplitsByExpense = new Map();
for (const split of db.prepare(
  'SELECT expense_id, member_id, amount FROM expense_splits ORDER BY rowid'
).all()) {
  const splits = auditSplitsByExpense.get(split.expense_id) || [];
  splits.push({ member_id: split.member_id, amount: split.amount });
  auditSplitsByExpense.set(split.expense_id, splits);
}
const auditExpenses = db.prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY rowid');
const auditMembers = db.prepare('SELECT id FROM members WHERE group_id = ? ORDER BY rowid');
const auditWallets = db.prepare('SELECT id FROM ledger_wallets WHERE group_id = ? ORDER BY rowid');
for (const group of db.prepare('SELECT id FROM groups ORDER BY rowid').all()) {
  const expenses = auditExpenses.all(group.id);
  for (const expense of expenses) {
    expense.splits = auditSplitsByExpense.get(expense.id) || [];
  }
  try {
    calculateLedger(auditMembers.all(group.id), expenses, auditWallets.all(group.id));
  } catch (error) {
    throw new Error(
      `帳務資料完整性檢查失敗：帳本 ${group.id} 無法守恆（${error.message}）`
    );
  }
}
db.prepare(`INSERT INTO admin_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run('ledger_wallet_accounts_v1', '1');

module.exports = db;
