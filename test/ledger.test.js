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
  { id: 'charlie', name: 'Charlie' },
];
const wallets = [{ id: 'wallet', name: '公帳' }];

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
    balancesCents: { alice: 500, bob: -500, charlie: 0 },
    walletLedgers: {},
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
    balancesCents: { alice: -500, bob: 500, charlie: 0 },
    walletLedgers: {},
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
    balancesCents: { alice: 1000, bob: -1000, charlie: 0 },
    walletLedgers: {},
    totalExpenseCents: 0,
    totalIncomeCents: 0,
  });
});

test('uses normal transfer semantics alongside a shared expense', () => {
  const transfer = expense({
    amount: '20.00',
    category: '轉帳',
    splits: [{ member_id: 'charlie', amount: '20.00' }],
  });
  const sharedExpense = expense({
    payer_id: 'charlie',
    amount: '6.00',
    splits: [
      { member_id: 'alice', amount: '3.00' },
      { member_id: 'bob', amount: '3.00' },
    ],
  });
  const ledger = calculateLedger(members, [transfer, sharedExpense]);

  assert.deepEqual(ledger, {
    balancesCents: { alice: 1700, bob: -300, charlie: -1400 },
    walletLedgers: {},
    totalExpenseCents: 600,
    totalIncomeCents: 0,
  });
});

test('tracks wallet cash and member positions without mixing them into settlements', () => {
  const ledger = calculateLedger(members, [
    {
      payer_id: 'alice',
      transfer_to_wallet_id: 'wallet',
      amount: '100.00',
      category: '轉帳',
      kind: 'transfer',
      splits: [],
    },
    {
      payer_id: null,
      payer_wallet_id: 'wallet',
      amount: '60.00',
      category: '餐飲',
      kind: 'expense',
      splits: [
        { member_id: 'alice', amount: '30.00' },
        { member_id: 'bob', amount: '30.00' },
      ],
    },
  ], wallets);

  assert.deepEqual(ledger, {
    balancesCents: { alice: 0, bob: 0, charlie: 0 },
    walletLedgers: {
      wallet: {
        balanceCents: 4000,
        positionsCents: { alice: 7000, bob: -3000, charlie: 0 },
        sharedBalanceCents: 0,
      },
    },
    totalExpenseCents: 6000,
    totalIncomeCents: 0,
  });
  assert.deepEqual(calculateSettlements(ledger.balancesCents), []);
});

test('records wallet withdrawals and income against the receiving members positions', () => {
  const ledger = calculateLedger(members, [
    {
      payer_id: 'alice',
      transfer_to_wallet_id: 'wallet',
      amount: '50.00',
      category: '轉帳',
      kind: 'transfer',
      splits: [],
    },
    {
      payer_id: null,
      payer_wallet_id: 'wallet',
      transfer_to_member_id: 'alice',
      amount: '20.00',
      category: '轉帳',
      kind: 'transfer',
      splits: [],
    },
    {
      payer_id: null,
      payer_wallet_id: 'wallet',
      amount: '10.00',
      category: '退款',
      kind: 'income',
      splits: [{ member_id: 'bob', amount: '10.00' }],
    },
  ], wallets);

  assert.deepEqual(ledger.walletLedgers.wallet, {
    balanceCents: 4000,
    positionsCents: { alice: 3000, bob: 1000, charlie: 0 },
    sharedBalanceCents: 0,
  });
  assert.equal(ledger.totalExpenseCents, 0);
  assert.equal(ledger.totalIncomeCents, 1000);
});

test('allows a wallet overdraft and keeps each members top-up position explicit', () => {
  const ledger = calculateLedger(members, [{
    payer_wallet_id: 'wallet',
    amount: '60.00',
    category: '餐飲',
    kind: 'expense',
    splits: [
      { member_id: 'alice', amount: '30.00' },
      { member_id: 'bob', amount: '30.00' },
    ],
  }], wallets);

  assert.deepEqual(ledger.walletLedgers.wallet, {
    balanceCents: -6000,
    positionsCents: { alice: -3000, bob: -3000, charlie: 0 },
    sharedBalanceCents: 0,
  });
  assert.deepEqual(ledger.balancesCents, { alice: 0, bob: 0, charlie: 0 });
});

test('rejects invalid wallet sources, targets, and non-member wallet splits', () => {
  assert.throws(
    () => calculateLedger(members, [expense({ splits: [] })], wallets),
    /at least one split/
  );
  assert.throws(
    () => calculateLedger(members, [expense({
      payer_id: null,
      payer_wallet_id: 'wallet',
      kind: 'income',
      splits: [],
    })], wallets),
    /at least one split/
  );
  assert.throws(
    () => calculateLedger(members, [{
      payer_id: 'alice',
      payer_wallet_id: 'wallet',
      amount: '1.00',
      kind: 'expense',
      splits: [{ member_id: 'alice', amount: '1.00' }],
    }], wallets),
    /exactly one member or wallet source/
  );
  assert.throws(
    () => calculateLedger(members, [{
      payer_wallet_id: 'wallet',
      transfer_to_wallet_id: 'wallet',
      amount: '1.00',
      kind: 'transfer',
      splits: [],
    }], wallets),
    /source and target must be different|Wallet-to-wallet/
  );
  assert.throws(
    () => calculateLedger(members, [{
      payer_wallet_id: 'wallet',
      amount: '1.00',
      kind: 'expense',
      splits: [{ member_id: 'wallet', amount: '1.00' }],
    }], wallets),
    /not a ledger member/
  );
  assert.throws(
    () => calculateLedger(members, [{
      payer_id: 'alice',
      transfer_to_member_id: 'bob',
      amount: '1.00',
      kind: 'expense',
      splits: [{ member_id: 'alice', amount: '1.00' }],
    }], wallets),
    /Only transfers/
  );
});

test('allows only omitted or empty splits when a transfer has an explicit target', () => {
  const transfer = {
    payer_id: 'alice',
    transfer_to_member_id: 'bob',
    amount: '1.00',
    kind: 'transfer',
  };
  const expected = {
    balancesCents: { alice: 100, bob: -100, charlie: 0 },
    walletLedgers: { wallet: {
      balanceCents: 0,
      positionsCents: { alice: 0, bob: 0, charlie: 0 },
      sharedBalanceCents: 0,
    } },
    totalExpenseCents: 0,
    totalIncomeCents: 0,
  };

  assert.deepEqual(calculateLedger(members, [transfer], wallets), expected);
  assert.deepEqual(calculateLedger(members, [{ ...transfer, splits: [] }], wallets), expected);

  for (const splits of [
    null,
    {},
    'bob',
    [{ member_id: 'bob', amount: '1.00' }],
    [null],
  ]) {
    assert.throws(
      () => calculateLedger(members, [{ ...transfer, splits }], wallets),
      /cannot contain expense splits/
    );
  }
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
      { member_id: 'charlie', amount: '3.33' },
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
  assert.deepEqual(settled, { alice: 0, bob: 0, charlie: 0 });
});

test('records an unallocated wallet expense without creating member debt', () => {
  const ledger = calculateLedger(members, [
    {
      payer_id: 'alice',
      transfer_to_wallet_id: 'wallet',
      amount: '100.00',
      category: '轉帳',
      kind: 'transfer',
      splits: [],
    },
    {
      payer_wallet_id: 'wallet',
      amount: '60.00',
      category: '餐飲',
      kind: 'expense',
      splits: [],
    },
  ], wallets);

  assert.deepEqual(ledger.walletLedgers.wallet, {
    balanceCents: 4000,
    positionsCents: { alice: 10000, bob: 0, charlie: 0 },
    sharedBalanceCents: -6000,
  });
  assert.deepEqual(ledger.balancesCents, { alice: 0, bob: 0, charlie: 0 });
  assert.deepEqual(calculateSettlements(ledger.balancesCents), []);
  assert.equal(ledger.totalExpenseCents, 6000);
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
