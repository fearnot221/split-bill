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

test('local parser identifies a transfer target', () => {
  const text = '我轉帳 500 給小明';
  const raw = localParse(text, { ...context, today: '2026-07-14', hasReceipt: false });
  const draft = normalizeDraft(raw, { ...context, today: '2026-07-14', sourceText: text });
  assert.equal(draft.ready, true);
  assert.equal(draft.kind, 'transfer');
  assert.equal(draft.payerId, 'me');
  assert.equal(draft.transferToId, 'ming');
  assert.deepEqual(draft.participantIds, []);
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
        };
      },
    },
  };
  const draft = await analyzeWithOpenAI({
    client,
    model: 'gpt-5.6',
    text: '車票88我跟小明',
    receiptDataUrl: null,
    context,
    today: '2026-07-14',
    safetyIdentifier: 'ledger_test',
    signal: abortController.signal,
  });
  assert.equal(draft.ready, true);
  assert.equal(draft.category, '交通');
  assert.deepEqual(draft.participantIds, ['me', 'ming']);
  assert.equal(receivedOptions.signal, abortController.signal);
});
