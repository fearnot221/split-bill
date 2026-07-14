'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_DRAFT_SCHEMA,
  analyzeWithOpenAI,
  buildOpenAIRequest,
  localParse,
  mergeUsage,
  needsHighDetailReceiptRetry,
  normalizeDraft,
} = require('../lib/ai-ledger');

const context = {
  members: [
    { id: 'me', name: '我', is_fund: 0 },
    { id: 'ming', name: '小明', is_fund: 0 },
    { id: 'fund', name: '公帳', is_fund: 1 },
  ],
  categories: [
    { name: '餐飲' }, { name: '交通' }, { name: '住宿' }, { name: '其他' },
  ],
  defaultMemberId: 'me',
};

test('defines a strict structured-output schema', () => {
  assert.equal(AI_DRAFT_SCHEMA.type, 'object');
  assert.equal(AI_DRAFT_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    new Set(AI_DRAFT_SCHEMA.required),
    new Set(Object.keys(AI_DRAFT_SCHEMA.properties))
  );
  assert.equal(AI_DRAFT_SCHEMA.properties.customSplits.items.additionalProperties, false);
});

test('local parser understands an equal split with relative date', () => {
  const raw = localParse('昨天晚餐 NT$1,200，我跟小明均分，我付', {
    ...context, today: '2026-07-14', hasReceipt: false,
  });
  const draft = normalizeDraft(raw, {
    ...context, today: '2026-07-14', sourceText: '昨天晚餐 NT$1,200，我跟小明均分，我付',
  });
  assert.equal(draft.ready, true);
  assert.equal(draft.kind, 'expense');
  assert.equal(draft.description, '晚餐');
  assert.equal(draft.amount, 1200);
  assert.equal(draft.category, '餐飲');
  assert.equal(draft.expenseDate, '2026-07-13');
  assert.equal(draft.payerId, 'me');
  assert.deepEqual(draft.participantIds, ['me', 'ming']);
  assert.equal(draft.splitMode, 'equal');
});

test('local parser preserves valid custom splits', () => {
  const text = '晚餐 300 小明100 我200，我付';
  const raw = localParse(text, { ...context, today: '2026-07-14', hasReceipt: false });
  const draft = normalizeDraft(raw, { ...context, today: '2026-07-14', sourceText: text });
  assert.equal(draft.amount, 300);
  assert.equal(draft.splitMode, 'custom');
  assert.deepEqual(draft.customSplits, [
    { memberId: 'me', memberName: '我', amount: 200 },
    { memberId: 'ming', memberName: '小明', amount: 100 },
  ]);

  const chineseText = '晚餐我六百、小明三百，總額九百';
  const chineseDraft = normalizeDraft(
    localParse(chineseText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: chineseText }
  );
  assert.equal(chineseDraft.description, '晚餐');
  assert.equal(chineseDraft.amount, 900);
  assert.equal(chineseDraft.splitMode, 'custom');
  assert.deepEqual(chineseDraft.customSplits, [
    { memberId: 'me', memberName: '我', amount: 600 },
    { memberId: 'ming', memberName: '小明', amount: 300 },
  ]);
});

test('local parser converts percentage splits into exact currency amounts', () => {
  const text = '晚餐 999，我70%、小明30%，我付';
  const draft = normalizeDraft(
    localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: text }
  );
  assert.equal(draft.amount, 999);
  assert.equal(draft.splitMode, 'custom');
  assert.deepEqual(draft.customSplits, [
    { memberId: 'me', memberName: '我', amount: 699.3 },
    { memberId: 'ming', memberName: '小明', amount: 299.7 },
  ]);

  const invalidText = '晚餐 999，我60%、小明30%，我付';
  const invalid = normalizeDraft(
    localParse(invalidText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: invalidText }
  );
  assert.equal(invalid.splitMode, 'equal');
  assert.match(invalid.warnings.join(' '), /100%/);

  const missingTotalText = '晚餐，我70%、小明30%';
  const missingTotal = normalizeDraft(
    localParse(missingTotalText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: missingTotalText }
  );
  assert.equal(missingTotal.amount, null);
  assert.match(missingTotal.warnings.join(' '), /總金額/);
});

test('local parser identifies a transfer target', () => {
  const text = '我轉帳 500 給小明';
  const raw = localParse(text, { ...context, today: '2026-07-14', hasReceipt: false });
  const draft = normalizeDraft(raw, { ...context, today: '2026-07-14', sourceText: text });
  assert.equal(draft.ready, true);
  assert.equal(draft.kind, 'transfer');
  assert.equal(draft.payerId, 'me');
  assert.equal(draft.transferToId, 'ming');
  assert.deepEqual(draft.participantIds, []);
  assert.equal(draft.description, '轉帳');

  for (const shorthand of ['我還小明500', '我匯小明500', '我轉小明500']) {
    const shorthandDraft = normalizeDraft(
      localParse(shorthand, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: shorthand }
    );
    assert.equal(shorthandDraft.kind, 'transfer', shorthand);
    assert.equal(shorthandDraft.payerId, 'me', shorthand);
    assert.equal(shorthandDraft.transferToId, 'ming', shorthand);
    assert.equal(shorthandDraft.amount, 500, shorthand);
    assert.equal(shorthandDraft.description, '轉帳', shorthand);
  }

  for (const [bareTransfer, payerId, transferToId] of [
    ['我給小明500', 'me', 'ming'],
    ['小明付給我500', 'ming', 'me'],
  ]) {
    const bareDraft = normalizeDraft(
      localParse(bareTransfer, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: bareTransfer }
    );
    assert.equal(bareDraft.kind, 'transfer', bareTransfer);
    assert.equal(bareDraft.payerId, payerId, bareTransfer);
    assert.equal(bareDraft.transferToId, transferToId, bareTransfer);
    assert.equal(bareDraft.amount, 500, bareTransfer);
  }

  const contextualText = '訂房代墊，我轉小明500';
  const contextual = normalizeDraft(
    localParse(contextualText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: contextualText }
  );
  assert.equal(contextual.description, '訂房代墊');

  for (const ordinaryText of ['轉角咖啡500我付', '還有小明，晚餐500我付', '匯率差額500我付']) {
    const ordinary = localParse(ordinaryText, {
      ...context, today: '2026-07-14', hasReceipt: false,
    });
    assert.equal(ordinary.kind, 'expense', ordinaryText);
  }
});

test('local parser keeps dates and times out of the amount', () => {
  const cases = [
    ['2026-07-10 住宿 2400 我和小明均分', 2400, '2026-07-10', '住宿'],
    ['2026年7月10日 晚餐 500 我付不分攤', 500, '2026-07-10', '晚餐'],
    ['18:30 晚餐 700 我和小明均分', 700, '2026-07-14', '晚餐'],
    ['7/10晚餐500我付不分攤', 500, '2026-07-10', '晚餐'],
    ['18:30晚餐700我和小明均分', 700, '2026-07-14', '晚餐'],
    ['7月10日晚餐500我付不分攤', 500, '2026-07-10', '晚餐'],
    ['7月10號晚餐500我付不分攤', 500, '2026-07-10', '晚餐'],
    ['明天早餐80我付不分攤', 80, '2026-07-15', '早餐'],
    ['後天晚餐500我付不分攤', 500, '2026-07-16', '晚餐'],
    ['上週五晚餐500我付不分攤', 500, '2026-07-10', '晚餐'],
    ['本星期一早餐80我付不分攤', 80, '2026-07-13', '早餐'],
    ['下禮拜日晚餐500我付不分攤', 500, '2026-07-26', '晚餐'],
  ];
  for (const [text, amount, date, description] of cases) {
    const raw = localParse(text, { ...context, today: '2026-07-14', hasReceipt: false });
    const draft = normalizeDraft(raw, { ...context, today: '2026-07-14', sourceText: text });
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.expenseDate, date, text);
    assert.equal(draft.description, description, text);
  }

  for (const invalidPrecision of ['晚餐 500.123 我付', '晚餐 NT$500.123 我付', '晚餐 500.123元 我付']) {
    const draft = normalizeDraft(
      localParse(invalidPrecision, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: invalidPrecision }
    );
    assert.equal(draft.amount, null, invalidPrecision);
    assert.match(draft.warnings.join(' '), /尚未辨識金額/, invalidPrecision);
  }

  for (const invalidDate of ['2026-02-30晚餐500我付', '2/30晚餐500我付', '2月30日晚餐500我付']) {
    const draft = normalizeDraft(
      localParse(invalidDate, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: invalidDate }
    );
    assert.equal(draft.expenseDate, '2026-07-14', invalidDate);
    assert.match(draft.warnings.join(' '), /日期無效/, invalidDate);
  }
});

test('local parser understands guarded Chinese money amounts', () => {
  const cases = [
    ['晚餐五百元我跟小明均分', 500, '晚餐'],
    ['兩千四百塊旅館，我跟小明均分', 2400, '旅館'],
    ['總共一萬零五十，住宿，我付不分攤', 10050, '住宿'],
    ['總共五百元晚餐，我付不分攤', 500, '晚餐'],
  ];
  for (const [text, amount, description] of cases) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.description, description, text);
  }

  const peopleOnly = normalizeDraft(
    localParse('三人均分晚餐', { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: '三人均分晚餐' }
  );
  assert.equal(peopleOnly.amount, null);

  const salary = normalizeDraft(
    localParse('薪水五萬今天收到', { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: '薪水五萬今天收到' }
  );
  assert.equal(salary.kind, 'income');
  assert.equal(salary.description, '薪水');
  assert.equal(salary.amount, 50000);
});

test('local parser handles k shorthand without truncating units', () => {
  for (const [text, expected] of [
    ['晚餐1.2k跟小明均分', 1200],
    ['NT$1.5K旅館，我跟小明均分', 1500],
    ['車票0.08k我付不分攤', 80],
  ]) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, expected, text);
  }
  const weight = normalizeDraft(
    localParse('買1kg蘋果', { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: '買1kg蘋果' }
  );
  assert.equal(weight.amount, null);
});

test('local parser validates thousands separators', () => {
  for (const [text, expected] of [
    ['晚餐1,234元我付', 1234],
    ['旅館12,345.67元我付', 12345.67],
    ['晚餐1,2元我付', null],
    ['總額1,23,456，住宿', null],
  ]) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, expected, text);
  }
});

test('local parser prefers the final paid amount over subtotals and discounts', () => {
  for (const [text, amount, description] of [
    ['晚餐總額500折扣50實付450我付', 450, '晚餐'],
    ['旅館原價2k折後1.5k我付', 1500, '旅館'],
    ['午餐小計五百折扣五十應付四百五十元', 450, '午餐'],
  ]) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.description, description, text);
  }
});

test('local parser consumes common Taiwan currency prefixes', () => {
  for (const [text, amount, description] of [
    ['NTD500晚餐我付', 500, '晚餐'],
    ['台幣500車票我付', 500, '車票'],
    ['新台幣1.2k旅館我付', 1200, '旅館'],
    ['＄80早餐我付', 80, '早餐'],
    ['500圓晚餐我付', 500, '晚餐'],
    ['五百圓車票我付', 500, '車票'],
  ]) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.description, description, text);
  }
});

test('local parser ignores receipt and order identifiers', () => {
  for (const [text, amount, description] of [
    ['發票號碼 AB123456，晚餐500我付', 500, '晚餐'],
    ['統編12345678 旅館2400我付', 2400, '旅館'],
    ['訂單#998877 車票80我付', 80, '車票'],
  ]) {
    const draft = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.description, description, text);
  }
});

test('local parser handles everyone, income, and no-split phrases', () => {
  const everyoneText = '晚餐 1,500 大家均分我付';
  const everyone = normalizeDraft(
    localParse(everyoneText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: everyoneText }
  );
  assert.deepEqual(everyone.participantIds, ['me', 'ming']);
  assert.equal(everyone.splitMode, 'equal');

  const incomeText = '退款收入 500 我收款不分攤';
  const income = normalizeDraft(
    localParse(incomeText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: incomeText }
  );
  assert.equal(income.kind, 'income');
  assert.equal(income.splitMode, 'none');
  assert.deepEqual(income.participantIds, ['me']);

  const personalMealText = '個人鍋晚餐500，大家均分，我付';
  const personalMeal = normalizeDraft(
    localParse(personalMealText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: personalMealText }
  );
  assert.equal(personalMeal.splitMode, 'equal');
  assert.deepEqual(personalMeal.participantIds, ['me', 'ming']);

  for (const text of ['晚餐500不用分', '晚餐500不需分', '晚餐500算個人']) {
    const personal = normalizeDraft(
      localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: text }
    );
    assert.equal(personal.splitMode, 'none', text);
    assert.deepEqual(personal.participantIds, ['me'], text);
  }

  const singleParticipantText = '晚餐500，分帳：小明，我付';
  const singleParticipant = normalizeDraft(
    localParse(singleParticipantText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: singleParticipantText }
  );
  assert.equal(singleParticipant.splitMode, 'equal');
  assert.deepEqual(singleParticipant.participantIds, ['ming']);

  for (const shorthand of ['晚餐500跟小明均分', '晚餐500小明AA', '晚餐500跟小明對半']) {
    const shared = normalizeDraft(
      localParse(shorthand, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: shorthand }
    );
    assert.equal(shared.splitMode, 'equal', shorthand);
    assert.deepEqual(shared.participantIds, ['me', 'ming'], shorthand);
  }

  const receivedText = '小明收到退款500，我跟小明均分';
  const received = normalizeDraft(
    localParse(receivedText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: receivedText }
  );
  assert.equal(received.kind, 'income');
  assert.equal(received.payerId, 'ming');
  assert.equal(received.description, '退款');
});

test('local parser preserves description words and extracts a trailing note', () => {
  const text = '連續記帳測試 321，我付不分攤，備註：每月核對';
  const draft = normalizeDraft(
    localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: text }
  );
  assert.equal(draft.description, '連續記帳測試');
  assert.equal(draft.note, '每月核對');

  const compactNoteText = '晚餐500我付不分攤備註聚餐';
  const compactNote = normalizeDraft(
    localParse(compactNoteText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: compactNoteText }
  );
  assert.equal(compactNote.note, '聚餐');

  const commandText = '請幫我記帳：昨天晚餐 500，我付不分攤';
  const command = normalizeDraft(
    localParse(commandText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: commandText }
  );
  assert.equal(command.description, '晚餐');

  for (const [amountFirst, expected] of [
    ['500元晚餐，我跟小明均分', '晚餐'],
    ['NT$2400 旅館，由小明支付，我跟小明均分', '旅館'],
    ['300退款，小明收款，我跟小明均分', '退款'],
  ]) {
    const parsed = normalizeDraft(
      localParse(amountFirst, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: amountFirst }
    );
    assert.equal(parsed.description, expected, amountFirst);
  }

  const ambiguousText = '500元小明生日蛋糕，我付';
  const ambiguous = normalizeDraft(
    localParse(ambiguousText, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: ambiguousText }
  );
  assert.equal(ambiguous.description, '小明生日蛋糕');
  assert.equal(ambiguous.splitMode, 'none');
  assert.deepEqual(ambiguous.participantIds, ['me']);
  assert.match(ambiguous.warnings.join(' '), /未說明如何分攤/);

  for (const [structuredText, expected] of [
    ['項目：晚餐，金額：500，付款人：我，分帳：我、小明', '晚餐'],
    ['金額2400 品項旅館 分類住宿 付款人小明 分攤我、小明', '旅館'],
    ['用途：機場接送；總額 900；我跟小明均分', '機場接送'],
  ]) {
    const structured = normalizeDraft(
      localParse(structuredText, { ...context, today: '2026-07-14', hasReceipt: false }),
      { ...context, today: '2026-07-14', sourceText: structuredText }
    );
    assert.equal(structured.description, expected, structuredText);
  }
});

test('local parser handles common payer, transfer, date, category, and total phrasing', () => {
  const richContext = {
    ...context,
    members: [
      ...context.members,
      { id: 'mei', name: '小美', is_fund: 0 },
    ],
    categories: [...context.categories, { name: '醫療' }],
  };
  const cases = [
    {
      text: '小明出的晚餐 900，我、小明、小美均分',
      expected: { description: '晚餐', amount: 900, payerId: 'ming', splitMode: 'equal' },
    },
    {
      text: '晚餐 900，由小明支付，三人均分',
      expected: { payerId: 'ming', participantIds: ['me', 'ming', 'mei'] },
    },
    {
      text: '小明匯給我 500',
      expected: { kind: 'transfer', payerId: 'ming', transferToId: 'me', amount: 500 },
    },
    {
      text: '我轉800到公帳',
      expected: { kind: 'transfer', payerId: 'me', transferToId: 'fund', amount: 800 },
    },
    {
      text: '退款 300 小美收，我跟小美均分',
      expected: { kind: 'income', payerId: 'mei', participantIds: ['me', 'mei'] },
    },
    {
      text: '看診 450，分類醫療，我付不分攤',
      expected: { category: '醫療', splitMode: 'none', description: '看診' },
    },
    {
      text: '前天停車費 120，我付',
      expected: { expenseDate: '2026-07-12', category: '交通', description: '停車費' },
    },
    {
      text: '晚餐 小明100 小美200 我200，總共500，我付',
      expected: { amount: 500, splitMode: 'custom' },
    },
  ];

  for (const { text, expected } of cases) {
    const draft = normalizeDraft(
      localParse(text, { ...richContext, today: '2026-07-14', hasReceipt: false }),
      { ...richContext, today: '2026-07-14', sourceText: text }
    );
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(draft[key], value, `${text}: ${key}`);
    }
  }
});

test('normalizer rejects unknown members and unsafe custom totals', () => {
  const draft = normalizeDraft({
    isLedgerEntry: true,
    kind: 'expense',
    description: '旅館',
    amount: 1000,
    category: '住宿',
    expenseDate: '2026-07-14',
    payerName: '我',
    participantNames: ['小明', '不存在'],
    splitMode: 'custom',
    customSplits: [{ memberName: '小明', amount: 300 }],
    transferToName: null,
    note: null,
    confidence: 0.8,
    warnings: [],
  }, { ...context, today: '2026-07-14', sourceText: '旅館' });
  assert.equal(draft.splitMode, 'equal');
  assert.deepEqual(draft.customSplits, []);
  assert.match(draft.warnings.join(' '), /不存在/);
  assert.match(draft.warnings.join(' '), /總額不符/);

  const uncertain = normalizeDraft({
    isLedgerEntry: true,
    kind: 'expense',
    description: '可能是車票',
    amount: 88,
    category: '交通',
    expenseDate: '2026-07-14',
    payerName: '我',
    participantNames: ['我'],
    splitMode: 'none',
    customSplits: [],
    transferToName: null,
    note: null,
    confidence: 0.4,
    warnings: [],
  }, { ...context, today: '2026-07-14', sourceText: '可能是車票' });
  assert.equal(uncertain.ready, true);
  assert.match(uncertain.warnings.join(' '), /信心較低/);

  const noConfidence = normalizeDraft({ ...uncertain, confidence: 0, warnings: [] }, {
    ...context, today: '2026-07-14', sourceText: '可能是車票',
  });
  assert.match(noConfidence.warnings.join(' '), /信心較低/);

  const incomplete = normalizeDraft({
    isLedgerEntry: true,
    kind: 'expense',
    description: '',
    amount: 500,
    category: null,
    expenseDate: '2026-07-14',
    payerName: null,
    participantNames: [],
    splitMode: 'none',
    customSplits: [],
    transferToName: null,
    note: null,
    confidence: 0.7,
    warnings: [],
  }, { ...context, today: '2026-07-14', sourceText: '幫我處理這筆 500' });
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.description, '');
  assert.equal(incomplete.payerId, 'me');
  assert.equal(incomplete.category, '其他');
  assert.match(incomplete.warnings.join(' '), /項目說明/);
  assert.match(incomplete.warnings.join(' '), /付款／收款人/);
  assert.match(incomplete.warnings.join(' '), /分類/);
});

test('explicit participants override inferred splits while preserving exact custom splits', () => {
  const selectedContext = {
    ...context,
    today: '2026-07-14',
    explicitParticipantIds: ['ming'],
  };
  const inferredText = '晚餐 300，我跟小明均分，我付';
  const inferred = normalizeDraft(
    localParse(inferredText, { ...selectedContext, hasReceipt: false }),
    { ...selectedContext, sourceText: inferredText }
  );
  assert.equal(inferred.splitMode, 'equal');
  assert.deepEqual(inferred.participantIds, ['ming']);

  const exactCustom = normalizeDraft({
    isLedgerEntry: true,
    kind: 'expense',
    description: '晚餐',
    amount: 300,
    category: '餐飲',
    expenseDate: '2026-07-14',
    payerName: '我',
    participantNames: ['小明'],
    splitMode: 'custom',
    customSplits: [{ memberName: '小明', amount: 300 }],
    transferToName: null,
    note: null,
    confidence: 0.9,
    warnings: [],
  }, { ...selectedContext, sourceText: '晚餐 300，小明 300' });
  assert.equal(exactCustom.splitMode, 'custom');
  assert.deepEqual(exactCustom.participantIds, ['ming']);
  assert.deepEqual(exactCustom.customSplits, [
    { memberId: 'ming', memberName: '小明', amount: 300 },
  ]);

  const mismatchedCustom = normalizeDraft({
    isLedgerEntry: true,
    kind: 'expense',
    description: '晚餐',
    amount: 300,
    category: '餐飲',
    expenseDate: '2026-07-14',
    payerName: '我',
    participantNames: ['我', '小明'],
    splitMode: 'custom',
    customSplits: [
      { memberName: '我', amount: 200 },
      { memberName: '小明', amount: 100 },
    ],
    transferToName: null,
    note: null,
    confidence: 0.9,
    warnings: [],
  }, { ...selectedContext, sourceText: '晚餐 300，我 200、小明 100' });
  assert.equal(mismatchedCustom.splitMode, 'equal');
  assert.deepEqual(mismatchedCustom.participantIds, ['ming']);
  assert.deepEqual(mismatchedCustom.customSplits, []);
  assert.match(mismatchedCustom.warnings.join(' '), /手動選擇的分帳對象不一致/);

  const transferText = '我轉帳 500 給小明';
  const transfer = normalizeDraft(
    localParse(transferText, { ...selectedContext, hasReceipt: false }),
    { ...selectedContext, sourceText: transferText }
  );
  assert.equal(transfer.kind, 'transfer');
  assert.equal(transfer.payerId, 'me');
  assert.equal(transfer.transferToId, 'ming');
  assert.equal(transfer.splitMode, 'none');
  assert.deepEqual(transfer.participantIds, []);
});

test('builds a private multimodal Responses API request', () => {
  const request = buildOpenAIRequest({
    model: 'gpt-5.6-sol',
    text: '單據請分析',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });
  assert.equal(request.model, 'gpt-5.6-sol');
  assert.equal(request.store, false);
  assert.equal(request.safety_identifier, 'ledger_test');
  assert.equal(request.max_output_tokens, 1200);
  assert.match(request.instructions, /最終應付／實付總額/);
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.equal(request.input[0].content[1].detail, 'high');
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
});

test('OpenAI instructions describe explicit participants by name without member IDs', () => {
  const privateContext = {
    ...context,
    members: [
      { id: 'private-id-owner', name: '我', is_fund: 0 },
      { id: 'private-id-ming', name: '小明', is_fund: 0 },
      { id: 'private-id-fund', name: '公帳', is_fund: 1 },
    ],
    defaultMemberId: 'private-id-owner',
    explicitParticipantIds: ['private-id-ming'],
  };
  const request = buildOpenAIRequest({
    model: 'gpt-5.6-sol',
    text: '晚餐 300',
    receiptDataUrl: null,
    context: privateContext,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });
  assert.match(request.instructions, /明確指定分帳對象：\["小明"\]/);
  for (const member of privateContext.members) {
    assert.equal(request.instructions.includes(member.id), false, member.id);
  }
});

test('parses and normalizes a structured OpenAI response', async () => {
  const abortController = new AbortController();
  let receivedOptions;
  const client = {
    responses: {
      create: async (_request, options) => {
        receivedOptions = options;
        return {
          output_text: JSON.stringify({
            isLedgerEntry: true,
            kind: 'expense',
            description: '車票',
            amount: 88,
            category: '交通',
            expenseDate: '2026-07-14',
            payerName: '我',
            participantNames: ['我', '小明'],
            splitMode: 'equal',
            customSplits: [],
            transferToName: null,
            note: null,
            confidence: 0.96,
            warnings: [],
          }),
          output: [],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 32 },
            output_tokens: 48,
          },
        };
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '車票88我跟小明',
    receiptDataUrl: null,
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
    signal: abortController.signal,
  });
  const { draft } = result;
  assert.equal(draft.ready, true);
  assert.equal(draft.category, '交通');
  assert.deepEqual(draft.participantIds, ['me', 'ming']);
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 32,
    outputTokens: 48,
  });
  assert.equal(receivedOptions.signal, abortController.signal);
});

test('uses low-detail vision first and upgrades only incomplete receipt drafts', async () => {
  const requests = [];
  const responseFor = (overrides, usage) => ({
    output_text: JSON.stringify({
      isLedgerEntry: true,
      kind: 'expense',
      description: '咖啡',
      amount: 120,
      category: '餐飲',
      expenseDate: '2026-07-14',
      payerName: '我',
      participantNames: ['我'],
      splitMode: 'none',
      customSplits: [],
      transferToName: null,
      note: null,
      confidence: 0.98,
      warnings: [],
      ...overrides,
    }),
    output: [],
    usage,
  });
  const responses = [
    responseFor({ description: '', amount: null, confidence: 0.4 }, {
      input_tokens: 90,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 20,
    }),
    responseFor({}, {
      input_tokens: 180,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 40,
    }),
  ];
  const client = {
    responses: {
      create: async (request) => {
        requests.push(request);
        return responses.shift();
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.deepEqual(requests.map((request) => request.input[0].content[1].detail), ['low', 'high']);
  assert.equal(result.draft.ready, true);
  assert.equal(result.draft.amount, 120);
  assert.equal(result.receiptDetailUpgraded, true);
  assert.deepEqual(result.usage, {
    inputTokens: 270,
    cachedInputTokens: 40,
    outputTokens: 60,
  });
  assert.equal(needsHighDetailReceiptRetry(result), false);
  assert.deepEqual(mergeUsage(null, { inputTokens: 5, outputTokens: 2 }), {
    inputTokens: 5,
    cachedInputTokens: 0,
    outputTokens: 2,
  });
});

test('returns the low-detail receipt draft when its high-detail upgrade fails', async () => {
  let requestCount = 0;
  const client = {
    responses: {
      create: async () => {
        requestCount += 1;
        if (requestCount === 2) throw new Error('vision upgrade unavailable');
        return {
          output_text: JSON.stringify({
            isLedgerEntry: true,
            kind: 'expense',
            description: '單據',
            amount: null,
            category: '其他',
            expenseDate: '2026-07-14',
            payerName: '我',
            participantNames: ['我'],
            splitMode: 'none',
            customSplits: [],
            transferToName: null,
            note: null,
            confidence: 0.5,
            warnings: ['影像較模糊'],
          }),
          output: [],
          usage: { input_tokens: 95, output_tokens: 25 },
        };
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.equal(requestCount, 2);
  assert.equal(result.draft.ready, false);
  assert.equal(result.receiptDetailUpgradeFailed, true);
  assert.deepEqual(result.usage, {
    inputTokens: 95,
    cachedInputTokens: 0,
    outputTokens: 25,
  });
});

test('keeps useful low-detail fields when the high-detail result is worse', async () => {
  const responses = [
    {
      output_text: JSON.stringify({
        isLedgerEntry: true,
        kind: 'expense',
        description: '',
        amount: 120,
        category: '餐飲',
        expenseDate: '2026-07-14',
        payerName: '我',
        participantNames: ['我'],
        splitMode: 'none',
        customSplits: [],
        transferToName: null,
        note: null,
        confidence: 0.5,
        warnings: ['品項較模糊'],
      }),
      output: [],
      usage: { input_tokens: 90, output_tokens: 20 },
    },
    {
      output_text: JSON.stringify({
        isLedgerEntry: true,
        kind: 'expense',
        description: '咖啡',
        amount: null,
        category: '餐飲',
        expenseDate: '2026-07-14',
        payerName: '我',
        participantNames: ['我'],
        splitMode: 'none',
        customSplits: [],
        transferToName: null,
        note: null,
        confidence: 0.7,
        warnings: ['金額較模糊'],
      }),
      output: [],
      usage: { input_tokens: 180, output_tokens: 30 },
    },
  ];
  const client = { responses: { create: async () => responses.shift() } };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.equal(result.draft.amount, 120);
  assert.equal(result.draft.description, '咖啡');
  assert.equal(result.draft.ready, true);
  assert.equal(result.draft.confidence, 0.5);
  assert.doesNotMatch(result.draft.warnings.join(' '), /尚未辨識(金額|項目說明)/);
  assert.match(result.draft.warnings.join(' '), /辨識結果不一致/);
  assert.deepEqual(result.usage, {
    inputTokens: 270,
    cachedInputTokens: 0,
    outputTokens: 50,
  });
});

test('preserves the low-detail draft when the high-detail deadline expires', async () => {
  const controller = new AbortController();
  let requestCount = 0;
  const client = {
    responses: {
      create: async () => {
        requestCount += 1;
        if (requestCount === 2) {
          const timeoutError = new Error('deadline');
          timeoutError.code = 'AI_ANALYSIS_TIMEOUT';
          controller.abort(timeoutError);
          throw timeoutError;
        }
        return {
          output_text: JSON.stringify({
            isLedgerEntry: true,
            kind: 'expense',
            description: '單據',
            amount: 120,
            category: '餐飲',
            expenseDate: '2026-07-14',
            payerName: '我',
            participantNames: ['我'],
            splitMode: 'none',
            customSplits: [],
            transferToName: null,
            note: null,
            confidence: 0.5,
            warnings: ['影像較模糊'],
          }),
          output: [],
          usage: { input_tokens: 95, output_tokens: 25 },
        };
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
    signal: controller.signal,
  });

  assert.equal(result.draft.amount, 120);
  assert.equal(result.receiptDetailUpgradeFailed, true);
  assert.equal(result.receiptDetailUpgradeTimedOut, true);
  assert.deepEqual(result.usage, {
    inputTokens: 95,
    cachedInputTokens: 0,
    outputTokens: 25,
  });
});

test('does not use high detail solely for a normalized transfer-target issue', async () => {
  let requestCount = 0;
  const client = {
    responses: {
      create: async () => {
        requestCount += 1;
        return {
          output_text: JSON.stringify({
            isLedgerEntry: true,
            kind: 'transfer',
            description: '還款',
            amount: 120,
            category: '轉帳',
            expenseDate: '2026-07-14',
            payerName: '我',
            participantNames: [],
            splitMode: 'none',
            customSplits: [],
            transferToName: '不在帳本的人',
            note: null,
            confidence: 0.95,
            warnings: [],
          }),
          output: [],
          usage: { input_tokens: 90, output_tokens: 20 },
        };
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.equal(requestCount, 1);
  assert.equal(result.draft.ready, false);
});

test('uses high detail when the low-detail receipt date is missing', async () => {
  const requests = [];
  const makeResponse = (expenseDate) => ({
    output_text: JSON.stringify({
      isLedgerEntry: true,
      kind: 'expense',
      description: '咖啡',
      amount: 120,
      category: '餐飲',
      expenseDate,
      payerName: '我',
      participantNames: ['我'],
      splitMode: 'none',
      customSplits: [],
      transferToName: null,
      note: null,
      confidence: 0.95,
      warnings: [],
    }),
    output: [],
    usage: { input_tokens: 90, output_tokens: 20 },
  });
  const responses = [makeResponse(null), makeResponse('2026-07-13')];
  const client = {
    responses: {
      create: async (request) => {
        requests.push(request);
        return responses.shift();
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.deepEqual(requests.map((request) => request.input[0].content[1].detail), ['low', 'high']);
  assert.equal(result.draft.expenseDate, '2026-07-13');
});

test('warns when neither receipt pass can identify the date', async () => {
  let requestCount = 0;
  const client = {
    responses: {
      create: async () => {
        requestCount += 1;
        return {
          output_text: JSON.stringify({
            isLedgerEntry: true,
            kind: 'expense',
            description: '咖啡',
            amount: 120,
            category: '餐飲',
            expenseDate: null,
            payerName: '我',
            participantNames: ['我'],
            splitMode: 'none',
            customSplits: [],
            transferToName: null,
            note: null,
            confidence: 0.95,
            warnings: [],
          }),
          output: [],
          usage: { input_tokens: 90, output_tokens: 20 },
        };
      },
    },
  };
  const result = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6-sol',
    text: '',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });

  assert.equal(requestCount, 2);
  assert.equal(result.draft.expenseDate, '2026-07-14');
  assert.match(result.draft.warnings.join(' '), /尚未辨識單據日期/);
});

test('preserves token usage when an OpenAI response cannot be parsed', async () => {
  const client = {
    responses: {
      create: async () => ({
        output_text: '',
        output: [],
        usage: { input_tokens: 75, output_tokens: 12 },
      }),
    },
  };
  await assert.rejects(
    analyzeWithOpenAI({
      client,
      model: 'gpt-5.6-sol',
      text: '晚餐 300',
      receiptDataUrl: null,
      context,
      today: '2026-07-14',
      safetyIdentifier: 'ledger_test',
    }),
    (error) => {
      assert.match(error.message, /沒有回傳/);
      assert.deepEqual(error.aiUsage, {
        inputTokens: 75,
        cachedInputTokens: 0,
        outputTokens: 12,
      });
      return true;
    }
  );
});
