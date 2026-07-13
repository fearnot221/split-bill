'use strict';

// SQLite stores legacy monetary columns as REAL. This bound remains cent-exact
// across Number -> SQLite -> Number while still allowing nearly 10 billion units.
const MAX_INPUT_CENTS = 999_999_999_999n;
const TRANSFER_CATEGORIES = new Set(['還款', '轉帳']);

function moneyToCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Money must be finite');
    value = String(value);
  } else if (typeof value === 'string') {
    if (value.length > 32) throw new RangeError('Money exceeds the supported range');
    value = value.trim();
  } else {
    throw new TypeError('Money must be a number or decimal string');
  }

  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new TypeError('Money must have at most two decimal places');

  const [, sign, whole, fraction = ''] = match;
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const cents = sign === '-' ? -magnitude : magnitude;
  if (cents > MAX_INPUT_CENTS || cents < -MAX_INPUT_CENTS) {
    throw new RangeError('Money exceeds the supported range');
  }
  return Number(cents);
}

function centsToMoney(cents) {
  assertSafeInteger(cents, 'Cents');
  const money = cents / 100;
  if (Math.round(money * 100) !== cents) {
    throw new RangeError('Cents cannot be represented exactly as money');
  }
  return money;
}

function splitEvenly(totalCents, count) {
  assertSafeInteger(totalCents, 'Total cents');
  if (totalCents < 0) throw new RangeError('Total cents cannot be negative');
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError('Split count must be a positive safe integer');
  }

  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function calculateLedger(members, expenses) {
  if (!Array.isArray(members)) throw new TypeError('Members must be an array');
  if (!Array.isArray(expenses)) throw new TypeError('Expenses must be an array');

  const balances = new Map();
  for (const member of members) {
    const id = readId(member, 'Member');
    if (balances.has(id)) throw new RangeError(`Duplicate member: ${id}`);
    balances.set(id, 0);
  }

  let totalExpenseCents = 0;
  let totalIncomeCents = 0;

  for (const expense of expenses) {
    if (!expense || typeof expense !== 'object') {
      throw new TypeError('Expense must be an object');
    }

    const payerId = expense.payer_id ?? expense.payerId;
    requireMember(balances, payerId, 'Payer');

    const amountCents = moneyToCents(expense.amount);
    if (amountCents <= 0) throw new RangeError('Expense amount must be greater than zero');

    if (!Array.isArray(expense.splits) || expense.splits.length === 0) {
      throw new RangeError('Expense must have at least one split');
    }

    const splitMembers = new Set();
    const parsedSplits = [];
    let splitTotalCents = 0;
    for (const split of expense.splits) {
      if (!split || typeof split !== 'object') throw new TypeError('Split must be an object');
      const memberId = split.member_id ?? split.memberId;
      requireMember(balances, memberId, 'Split member');
      if (splitMembers.has(memberId)) throw new RangeError(`Duplicate split member: ${memberId}`);
      splitMembers.add(memberId);

      const splitCents = moneyToCents(split.amount);
      if (splitCents < 0) throw new RangeError('Split amount cannot be negative');
      splitTotalCents = safeAdd(splitTotalCents, splitCents, 'Split total');
      parsedSplits.push([memberId, splitCents]);
    }

    if (splitTotalCents !== amountCents) {
      throw new RangeError('Split total must equal the expense amount');
    }

    const isTransfer = expense.kind === 'transfer' || TRANSFER_CATEGORIES.has(expense.category);
    const isIncome = expense.kind === 'income' && !isTransfer;
    const direction = isIncome ? -1 : 1;
    balances.set(
      payerId,
      safeAdd(balances.get(payerId), direction * amountCents, 'Member balance')
    );
    for (const [memberId, splitCents] of parsedSplits) {
      balances.set(
        memberId,
        safeAdd(balances.get(memberId), -direction * splitCents, 'Member balance')
      );
    }

    if (isIncome) {
      totalIncomeCents = safeAdd(totalIncomeCents, amountCents, 'Income total');
    } else if (!isTransfer) {
      totalExpenseCents = safeAdd(totalExpenseCents, amountCents, 'Expense total');
    }
  }

  const balanceTotal = [...balances.values()].reduce(
    (sum, balance) => safeAdd(sum, balance, 'Balance total'),
    0
  );
  if (balanceTotal !== 0) throw new Error('Ledger balances do not conserve money');

  return {
    balancesCents: Object.fromEntries(balances),
    totalExpenseCents,
    totalIncomeCents,
  };
}

function calculateSettlements(balancesCents) {
  if (!balancesCents || typeof balancesCents !== 'object' || Array.isArray(balancesCents)) {
    throw new TypeError('Balances must be an object or Map');
  }

  const entries = balancesCents instanceof Map
    ? [...balancesCents.entries()]
    : Object.entries(balancesCents);
  const debtors = [];
  const creditors = [];
  let total = 0;

  for (const [id, balance] of entries) {
    assertSafeInteger(balance, `Balance for ${id}`);
    total = safeAdd(total, balance, 'Balance total');
    if (balance < 0) debtors.push({ id, amountCents: -balance });
    if (balance > 0) creditors.push({ id, amountCents: balance });
  }
  if (total !== 0) throw new RangeError('Balances must sum to zero');

  const byLargestThenId = (a, b) =>
    b.amountCents - a.amountCents || String(a.id).localeCompare(String(b.id));
  debtors.sort(byLargestThenId);
  creditors.sort(byLargestThenId);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountCents = Math.min(debtor.amountCents, creditor.amountCents);
    settlements.push({ from: debtor.id, to: creditor.id, amountCents });
    debtor.amountCents -= amountCents;
    creditor.amountCents -= amountCents;
    if (debtor.amountCents === 0) debtorIndex += 1;
    if (creditor.amountCents === 0) creditorIndex += 1;
  }

  return settlements;
}

function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
}

function safeAdd(left, right, label) {
  const result = left + right;
  assertSafeInteger(result, label);
  return result;
}

function readId(record, label) {
  if (!record || typeof record !== 'object' || record.id === undefined || record.id === null) {
    throw new TypeError(`${label} must have an id`);
  }
  return record.id;
}

function requireMember(balances, id, label) {
  if (!balances.has(id)) throw new RangeError(`${label} is not a ledger member`);
}

module.exports = {
  calculateLedger,
  calculateSettlements,
  centsToMoney,
  moneyToCents,
  splitEvenly,
};
