'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateLedger,
  calculateSettlements,
  centsToMoney,
  moneyToCents,
  splitEvenly,
} = require('../lib/ledger');

const members = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'fund', name: '公帳', is_fund: 1 },
];

function expense(overrides) {
  return {
    payer_id: 'alice',
    amount: '10.00',
    category: '餐飲',
    kind: 'expense',
    splits: [
      { member_id: 'alice', amount: '5.00' },
      { member_id: 'bob', amount: '5.00' },
    ],
    ...overrides,
  };
}

test('converts decimal money at the module boundary', () => {
  assert.equal(moneyToCents('123.45'), 12345);
  assert.equal(moneyToCents(0.1), 10);
  assert.equal(moneyToCents('-0.01'), -1);
  assert.equal(centsToMoney(12345), 123.45);
});

test('rejects non-finite, fractional-cent, and unsafe amounts', () => {
  assert.throws(() => moneyToCents(Infinity), /finite/);
  assert.throws(() => moneyToCents(NaN), /finite/);
  assert.throws(() => moneyToCents('1.001'), /two decimal places/);
  assert.throws(() => moneyToCents('90071992547409.92'), /supported range/);
  assert.throws(() => moneyToCents('1'.repeat(100_000)), /supported range/);
  assert.equal(moneyToCents(centsToMoney(999_999_999_999)), 999_999_999_999);
  assert.equal(centsToMoney(1_200_000_000_000), 12_000_000_000);
});

test('splits cents evenly and assigns the remainder from the first share', () => {
  assert.deepEqual(splitEvenly(moneyToCents('10.00'), 3), [334, 333, 333]);
  assert.equal(splitEvenly(1000, 3).reduce((sum, share) => sum + share, 0), 1000);
});

test('calculates expense balances and spending total in cents', () => {
  const ledger = calculateLedger(members, [expense()]);

  assert.deepEqual(ledger, {
    balancesCents: { alice: 500, bob: -500, fund: 0 },
    totalExpenseCents: 1000,
    totalIncomeCents: 0,
  });
});

test('reverses the balance direction for income', () => {
  const ledger = calculateLedger(members, [expense({
    kind: 'income',
    category: '退款',
  })]);

  assert.deepEqual(ledger, {
    balancesCents: { alice: -500, bob: 500, fund: 0 },
    totalExpenseCents: 0,
    totalIncomeCents: 1000,
  });
});

test('treats a transfer as balance movement, not spending', () => {
  const ledger = calculateLedger(members, [expense({
    category: '轉帳',
    splits: [{ member_id: 'bob', amount: '10.00' }],
  })]);

  assert.deepEqual(ledger, {
    balancesCents: { alice: 1000, bob: -1000, fund: 0 },
    totalExpenseCents: 0,
    totalIncomeCents: 0,
  });
});

test('uses the normal transfer semantics for the public fund', () => {
  const deposit = expense({
    amount: '20.00',
    category: '轉帳',
    splits: [{ member_id: 'fund', amount: '20.00' }],
  });
  const fundPurchase = expense({
    payer_id: 'fund',
    amount: '6.00',
    splits: [
      { member_id: 'alice', amount: '3.00' },
      { member_id: 'bob', amount: '3.00' },
    ],
  });
  const ledger = calculateLedger(members, [deposit, fundPurchase]);

  assert.deepEqual(ledger, {
    balancesCents: { alice: 1700, bob: -300, fund: -1400 },
    totalExpenseCents: 600,
    totalIncomeCents: 0,
  });
});

test('creates a settlement for exactly one cent', () => {
  assert.deepEqual(calculateSettlements({ alice: -1, bob: 1 }), [
    { from: 'alice', to: 'bob', amountCents: 1 },
  ]);
});

test('preserves money across a mixed ledger and its settlements', () => {
  const ledger = calculateLedger(members, [
    expense({ amount: '10.01', splits: [
      { member_id: 'alice', amount: '3.34' },
      { member_id: 'bob', amount: '3.34' },
      { member_id: 'fund', amount: '3.33' },
    ] }),
    expense({
      payer_id: 'bob',
      amount: '2.50',
      kind: 'income',
      category: '退款',
      splits: [{ member_id: 'alice', amount: '2.50' }],
    }),
  ]);
  const balances = Object.values(ledger.balancesCents);
  assert.equal(balances.reduce((sum, balance) => sum + balance, 0), 0);

  const settlements = calculateSettlements(ledger.balancesCents);
  const settled = { ...ledger.balancesCents };
  for (const settlement of settlements) {
    settled[settlement.from] += settlement.amountCents;
    settled[settlement.to] -= settlement.amountCents;
  }
  assert.deepEqual(settled, { alice: 0, bob: 0, fund: 0 });
});

test('rejects a split that does not conserve the expense amount', () => {
  assert.throws(
    () => calculateLedger(members, [expense({
      splits: [{ member_id: 'alice', amount: '9.99' }],
    })]),
    /Split total must equal/
  );
  assert.throws(() => calculateSettlements({ alice: -2, bob: 1 }), /sum to zero/);
});
