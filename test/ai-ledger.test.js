'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_DRAFT_SCHEMA,
  analyzeWithOpenAI,
  buildOpenAIRequest,
  localParse,
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
  ];
  for (const [text, amount, date, description] of cases) {
    const raw = localParse(text, { ...context, today: '2026-07-14', hasReceipt: false });
    const draft = normalizeDraft(raw, { ...context, today: '2026-07-14', sourceText: text });
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.expenseDate, date, text);
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
});

test('local parser preserves description words and extracts a trailing note', () => {
  const text = '連續記帳測試 321，我付不分攤，備註：每月核對';
  const draft = normalizeDraft(
    localParse(text, { ...context, today: '2026-07-14', hasReceipt: false }),
    { ...context, today: '2026-07-14', sourceText: text }
  );
  assert.equal(draft.description, '連續記帳測試');
  assert.equal(draft.note, '每月核對');

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
});

test('builds a private multimodal Responses API request', () => {
  const request = buildOpenAIRequest({
    model: 'gpt-5.6',
    text: '單據請分析',
    receiptDataUrl: 'data:image/jpeg;base64,/9j/',
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
  });
  assert.equal(request.model, 'gpt-5.6');
  assert.equal(request.store, false);
  assert.equal(request.safety_identifier, 'ledger_test');
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.equal(request.input[0].content[1].detail, 'high');
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
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
    model: 'gpt-5.6',
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
      model: 'gpt-5.6',
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
