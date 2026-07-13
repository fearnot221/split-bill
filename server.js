const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const {
  calculateLedger,
  calculateSettlements,
  centsToMoney,
  moneyToCents,
} = require('./lib/ledger');
const {
  analyzeWithOpenAI,
  localParse,
  normalizeDraft,
} = require('./lib/ai-ledger');
const { bindClientAbort } = require('./lib/request-abort');

const app = express();
const positiveIntegerEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const PORT = process.env.PORT || 3000;
const APP_USERNAME = process.env.APP_USERNAME || 'ledger';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ALLOW_PUBLIC_ACCESS = process.env.ALLOW_PUBLIC_ACCESS === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6';
const OPENAI_TIMEOUT_MS = positiveIntegerEnv(process.env.OPENAI_TIMEOUT_MS, 30_000);
const AI_REQUESTS_PER_HOUR = positiveIntegerEnv(process.env.AI_REQUESTS_PER_HOUR, 30);

if (APP_USERNAME.includes(':') || /[\r\n]/.test(APP_USERNAME)) {
  throw new Error('APP_USERNAME cannot contain a colon or line break');
}
if (APP_PASSWORD && APP_PASSWORD.length < 8) {
  throw new Error('APP_PASSWORD must contain at least 8 characters');
}
if (process.env.NODE_ENV === 'production' && !APP_PASSWORD && !ALLOW_PUBLIC_ACCESS) {
  throw new Error(
    'Refusing to start an unprotected production server. Set APP_PASSWORD or ALLOW_PUBLIC_ACCESS=1.'
  );
}

const db = require('./db');
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS, maxRetries: 1 })
  : null;

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameSecret = (a, b) => crypto.timingSafeEqual(
  Buffer.from(sha256(a), 'hex'),
  Buffer.from(sha256(b), 'hex')
);

// 單據照片存於 uploads/（已列入 .gitignore）
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 正式對外時可用環境變數替整站加上共享密碼，不影響本機免登入使用。
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const username = colon >= 0 ? decoded.slice(0, colon) : '';
      const password = colon >= 0 ? decoded.slice(colon + 1) : '';
      if (sameSecret(username, APP_USERNAME) && sameSecret(password, APP_PASSWORD)) return next();
    } catch {}
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Split Bill", charset="UTF-8"');
  return res.status(401).send('Authentication required');
});

const regularJson = express.json({ limit: '100kb' });
const receiptJson = express.json({ limit: '15mb' });
const aiJson = express.json({ limit: '15mb' });
app.use('/api/groups/:id/expenses/:expenseId/receipt', (req, res, next) => {
  return req.method === 'POST' ? receiptJson(req, res, next) : next();
});
app.use('/api/groups/:id/ai/parse', (req, res, next) => {
  return req.method === 'POST' ? aiJson(req, res, next) : next();
});
app.post('/api/groups/:id/expenses-with-receipt', receiptJson, (req, res) => {
  createExpense(req, res, true);
});
app.use(regularJson);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-store'),
}));

const unlinkReceipt = (filename) => {
  if (!filename || path.basename(filename) !== filename) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`無法刪除單據 ${filename}:`, error);
  }
};

function decodeReceipt(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: '單據格式不正確，請上傳圖片' };
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { error: '單據格式不正確，請上傳圖片' };

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return { error: '單據內容是空的' };
  if (buffer.length > 8 * 1024 * 1024) return { error: '圖片過大（上限 8MB）' };

  const type = match[1];
  const valid = type === 'jpeg'
    ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : type === 'png'
      ? buffer.length >= 8 && buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
      : buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) return { error: '檔案內容與圖片格式不符' };

  return { buffer, extension: type === 'jpeg' ? 'jpg' : type };
}

function writeReceiptAtomic(filename, buffer) {
  const temporary = path.join(UPLOAD_DIR, `.upload-${uid()}.tmp`);
  try {
    fs.writeFileSync(temporary, buffer, { mode: 0o600 });
    fs.renameSync(temporary, path.join(UPLOAD_DIR, filename));
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

const uid = () => crypto.randomUUID();

// 產生不重複的 6 碼邀請碼（避開易混淆字元）
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    const exists = db.prepare('SELECT 1 FROM groups WHERE code = ?').get(code);
    if (!exists) return code;
  }
}

// 「還款」「轉帳」是成員間資金移動，不算實際消費
const TRANSFER_CATEGORIES = ['還款', '轉帳'];

// 取得群組完整資料（成員、支出、結餘、結算建議）
function getGroupData(groupId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return null;

  const members = db
    .prepare('SELECT * FROM members WHERE group_id = ? ORDER BY created_at')
    .all(groupId);

  const expenses = db
    .prepare(`SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL
              ORDER BY expense_date DESC, created_at DESC`)
    .all(groupId);

  const splitRows = db.prepare(`
    SELECT s.expense_id, s.member_id, s.amount
    FROM expense_splits s
    JOIN expenses e ON e.id = s.expense_id
    WHERE e.group_id = ? AND e.deleted_at IS NULL
  `).all(groupId);
  const splitsByExpense = new Map();
  for (const split of splitRows) {
    if (!splitsByExpense.has(split.expense_id)) splitsByExpense.set(split.expense_id, []);
    splitsByExpense.get(split.expense_id).push({ member_id: split.member_id, amount: split.amount });
  }
  for (const expense of expenses) {
    delete expense.request_key;
    expense.splits = splitsByExpense.get(expense.id) || [];
  }

  const ledger = calculateLedger(members, expenses);
  const balances = Object.fromEntries(
    Object.entries(ledger.balancesCents).map(([id, cents]) => [id, centsToMoney(cents)])
  );
  const settlements = calculateSettlements(ledger.balancesCents).map((settlement) => ({
    from: settlement.from,
    to: settlement.to,
    amount: centsToMoney(settlement.amountCents),
  }));
  const total = centsToMoney(ledger.totalExpenseCents);
  const totalIncome = centsToMoney(ledger.totalIncomeCents);

  const categories = db
    .prepare('SELECT id, name, icon FROM categories WHERE group_id = ? ORDER BY sort, rowid')
    .all(groupId);

  return { group, members, expenses, balances, settlements, total, totalIncome, categories };
}

// 支出的類別必須存在（還款／轉帳為系統保留類別）
function isValidCategory(groupId, name) {
  if (TRANSFER_CATEGORIES.includes(name)) return true;
  return !!db.prepare('SELECT 1 FROM categories WHERE group_id = ? AND name = ?').get(groupId, name);
}

const trimmedString = (value) => typeof value === 'string' ? value.trim() : '';

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateExpenseInput(groupId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '請提供正確的紀錄資料' };
  }

  const description = trimmedString(body.description);
  const note = trimmedString(body.note);
  const payerId = typeof body.payerId === 'string' ? body.payerId : '';
  const category = body.category === undefined || body.category === null || body.category === ''
    ? '其他'
    : trimmedString(body.category);
  const kind = body.kind === undefined || body.kind === null || body.kind === ''
    ? 'expense'
    : body.kind === 'income' ? 'income' : body.kind === 'expense' ? 'expense' : null;
  const expenseDate = body.expenseDate || new Date().toISOString().slice(0, 10);

  if (!description) return { error: '請填寫項目說明' };
  if (description.length > 50) return { error: '項目說明最多 50 字' };
  if (note.length > 500) return { error: '備註最多 500 字' };
  if (!kind) return { error: '紀錄類型不正確' };
  if (!isValidDate(expenseDate)) return { error: '日期格式不正確' };
  if (!category) return { error: '類別不正確' };

  let amountCents;
  try {
    amountCents = moneyToCents(body.amount);
  } catch (error) {
    if (error instanceof RangeError) return { error: '金額超過系統上限（9,999,999,999.99）' };
    return { error: '金額最多只能有兩位小數' };
  }
  if (amountCents <= 0) return { error: '金額必須大於 0' };

  if (!Array.isArray(body.splits) || body.splits.length === 0) {
    return { error: '請至少選擇一位分攤成員' };
  }

  const memberIds = new Set(
    db.prepare('SELECT id FROM members WHERE group_id = ?').all(groupId).map((member) => member.id)
  );
  if (!memberIds.has(payerId)) return { error: '付款人不在群組中' };

  const seen = new Set();
  const splits = [];
  let splitTotalCents = 0;
  for (const split of body.splits) {
    if (!split || typeof split !== 'object' || Array.isArray(split)) {
      return { error: '分攤資料不正確' };
    }
    const memberId = typeof split.memberId === 'string' ? split.memberId : '';
    if (!memberIds.has(memberId)) return { error: '分攤成員不在群組中' };
    if (seen.has(memberId)) return { error: '同一成員不能重複分攤' };
    seen.add(memberId);

    let splitCents;
    try {
      splitCents = moneyToCents(split.amount);
    } catch (error) {
      if (error instanceof RangeError) return { error: '分攤金額超過系統上限' };
      return { error: '分攤金額最多只能有兩位小數' };
    }
    if (splitCents < 0) return { error: '分攤金額不能小於 0' };
    if (!Number.isSafeInteger(splitTotalCents + splitCents)) return { error: '分攤金額過大' };
    splitTotalCents += splitCents;
    if (splitCents > 0) splits.push({ memberId, amountCents: splitCents });
  }

  if (splitTotalCents !== amountCents) {
    return {
      error: `分攤總額 ${centsToMoney(splitTotalCents)} 與紀錄金額 ${centsToMoney(amountCents)} 不符`,
    };
  }

  let normalizedKind = kind;
  if (!isValidCategory(groupId, category)) return { error: '類別不存在' };
  if (TRANSFER_CATEGORIES.includes(category)) {
    normalizedKind = 'expense';
    if (splits.length !== 1) return { error: '轉帳需指定一位收款對象' };
    if (splits[0].memberId === payerId) return { error: '不能轉帳給自己' };
  }

  return {
    value: {
      payerId,
      description,
      amount: centsToMoney(amountCents),
      category,
      expenseDate,
      note: note || null,
      kind: normalizedKind,
      splits,
    },
  };
}

function todayInTaipei() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function getAiContext(groupId, preferredMemberId) {
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) return null;
  const members = db.prepare(
    'SELECT id, name, is_fund FROM members WHERE group_id = ? ORDER BY created_at'
  ).all(groupId);
  const categories = db.prepare(
    'SELECT name FROM categories WHERE group_id = ? ORDER BY sort, rowid'
  ).all(groupId);
  const preferred = members.find((member) => member.id === preferredMemberId && !member.is_fund);
  const defaultMember = preferred || members.find((member) => !member.is_fund) || members[0];
  return { members, categories, defaultMemberId: defaultMember?.id || null };
}

const aiUsage = new Map();
function consumeAiQuota(ip) {
  const now = Date.now();
  let record = aiUsage.get(ip);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: now + 60 * 60 * 1000 };
    aiUsage.set(ip, record);
  }
  if (record.count >= AI_REQUESTS_PER_HOUR) {
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }
  record.count += 1;
  if (aiUsage.size > 1000) aiUsage.delete(aiUsage.keys().next().value);
  return 0;
}

const insertAiUsage = db.prepare(`INSERT INTO ai_usage (
  provider, model, has_receipt, success, latency_ms,
  input_tokens, cached_input_tokens, output_tokens, error_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function recordAiUsage({ provider, model, hasReceipt, success, startedAt, usage, errorCode }) {
  try {
    insertAiUsage.run(
      provider,
      model || null,
      hasReceipt ? 1 : 0,
      success ? 1 : 0,
      Math.max(0, Date.now() - startedAt),
      usage?.inputTokens || 0,
      usage?.cachedInputTokens || 0,
      usage?.outputTokens || 0,
      errorCode || null
    );
    db.prepare("DELETE FROM ai_usage WHERE created_at < datetime('now', '-180 days')").run();
  } catch (error) {
    console.error('無法記錄 AI 使用統計:', error?.message || error);
  }
}

function classifyAiError(error, aborted) {
  if (aborted || error?.name === 'AbortError') return 'cancelled';
  const status = Number(error?.status);
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'authentication';
  if (/^(AI 沒有|AI 回傳|無法分析)/.test(error?.message || '')) return 'invalid_output';
  if (status >= 400 && status < 500) return 'request_error';
  return 'upstream_error';
}

app.get('/api/ai/status', (req, res) => {
  res.json({
    mode: openai ? 'openai' : 'local',
    model: openai ? OPENAI_MODEL : null,
    receiptRecognition: !!openai,
  });
});

function buildLocalAnalysis({ text, receiptDataUrl, context, today, notice }) {
  const raw = localParse(text, { ...context, today, hasReceipt: !!receiptDataUrl });
  const draft = normalizeDraft(raw, { ...context, today, sourceText: text });
  const notices = [notice];
  if (receiptDataUrl) notices.push('這次未辨識單據內容，圖片仍會隨帳目保存');
  return { provider: 'local', model: null, draft, notices };
}

app.post('/api/groups/:id/ai/parse', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: '請提供正確的智慧記帳內容' });
  }
  const text = trimmedString(body.text);
  if (text.length > 2000) return res.status(400).json({ error: '記帳文字最多 2000 字' });
  const receiptDataUrl = typeof body.receiptDataUrl === 'string' ? body.receiptDataUrl : '';
  if (!text && !receiptDataUrl) return res.status(400).json({ error: '請輸入記帳內容或附上單據' });
  if (receiptDataUrl) {
    const receipt = decodeReceipt(receiptDataUrl);
    if (receipt.error) return res.status(400).json({ error: receipt.error });
  }

  const context = getAiContext(req.params.id, body.defaultMemberId);
  if (!context) return res.status(404).json({ error: '找不到帳本' });
  const today = isValidDate(body.localDate) ? body.localDate : todayInTaipei();
  const startedAt = Date.now();

  if (!openai) {
    recordAiUsage({
      provider: 'local', hasReceipt: !!receiptDataUrl, success: true, startedAt,
    });
    return res.json(buildLocalAnalysis({
      text, receiptDataUrl, context, today,
      notice: '伺服器尚未設定 OPENAI_API_KEY，目前使用基本文字規則分析',
    }));
  }

  const retryAfter = consumeAiQuota(req.ip);
  if (retryAfter) {
    recordAiUsage({
      provider: 'openai', model: OPENAI_MODEL, hasReceipt: !!receiptDataUrl,
      success: false, startedAt, errorCode: 'rate_limit',
    });
    return res.json(buildLocalAnalysis({
      text, receiptDataUrl, context, today,
      notice: '智慧分析次數已達上限，已改用基本文字規則分析',
    }));
  }

  const clientAbort = bindClientAbort(req, res);

  try {
    const result = await analyzeWithOpenAI({
      client: openai,
      model: OPENAI_MODEL,
      text,
      receiptDataUrl: receiptDataUrl || null,
      context,
      today,
      safetyIdentifier: `ledger_${sha256(req.params.id).slice(0, 32)}`,
      signal: clientAbort.controller.signal,
    });
    recordAiUsage({
      provider: 'openai', model: OPENAI_MODEL, hasReceipt: !!receiptDataUrl,
      success: true, startedAt, usage: result.usage,
    });
    return res.json({
      provider: 'openai', model: OPENAI_MODEL, draft: result.draft, notices: [],
    });
  } catch (error) {
    const cancelled = clientAbort.controller.signal.aborted;
    recordAiUsage({
      provider: 'openai', model: OPENAI_MODEL, hasReceipt: !!receiptDataUrl,
      success: false, startedAt, usage: error.aiUsage,
      errorCode: classifyAiError(error, cancelled),
    });
    if (cancelled) return;
    const status = Number(error?.status);
    console.error('AI 帳目分析失敗:', status || '', error?.message || error);
    const fallbackReason = status === 429
      ? 'AI 服務目前忙碌'
      : status === 401 || status === 403
        ? 'AI 服務設定暫時無法使用'
        : 'AI 分析暫時失敗';
    return res.json(buildLocalAnalysis({
      text, receiptDataUrl, context, today,
      notice: `${fallbackReason}，已改用基本文字規則分析`,
    }));
  } finally {
    clientAbort.cleanup();
  }
});

// 個人模式：取得（或自動建立）預設帳本
app.get('/api/me', (req, res) => {
  let group = db.prepare('SELECT * FROM groups ORDER BY created_at LIMIT 1').get();
  if (!group) {
    const groupId = uid();
    const memberId = uid();
    db.transaction(() => {
      db.prepare('INSERT INTO groups (id, name, code) VALUES (?, ?, ?)')
        .run(groupId, '我的帳本', genCode());
      db.prepare('INSERT INTO members (id, group_id, name) VALUES (?, ?, ?)')
        .run(memberId, groupId, '我');
      db.seedCategories(groupId);
      db.seedFund(groupId);
    })();
    group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  }
  let me = db
    .prepare('SELECT * FROM members WHERE group_id = ? AND is_fund = 0 ORDER BY created_at LIMIT 1')
    .get(group.id);
  if (!me) {
    let name = '我';
    let suffix = 2;
    const exists = db.prepare('SELECT 1 FROM members WHERE group_id = ? AND name = ?');
    while (exists.get(group.id, name)) name = `我 ${suffix++}`;
    const memberId = uid();
    db.prepare('INSERT INTO members (id, group_id, name) VALUES (?, ?, ?)')
      .run(memberId, group.id, name);
    me = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  }
  res.json({ groupId: group.id, memberId: me.id, groupName: group.name });
});

// 修改帳本名稱
app.patch('/api/groups/:id', requireAdmin, (req, res) => {
  const group = db.prepare('SELECT name, currency FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: '找不到帳本' });
  const name = req.body?.name === undefined ? group.name : trimmedString(req.body.name);
  const currency = req.body?.currency === undefined
    ? group.currency
    : trimmedString(req.body.currency);
  if (!name) return res.status(400).json({ error: '請填寫帳本名稱' });
  if (name.length > 30) return res.status(400).json({ error: '帳本名稱最多 30 字' });
  if (!/^[A-Za-z$€£¥₩₹₫₱฿₽₺₪₴₦₲₡₭₮₵₸]{1,5}$/u.test(currency)) {
    return res.status(400).json({ error: '幣別限 1 至 5 個英文字母或貨幣符號' });
  }
  db.prepare('UPDATE groups SET name = ?, currency = ? WHERE id = ?')
    .run(name, currency, req.params.id);
  res.json({ ok: true });
});

// 取得群組完整資料
app.get('/api/groups/:id', (req, res) => {
  const data = getGroupData(req.params.id);
  if (!data) return res.status(404).json({ error: '找不到群組' });
  res.json(data);
});

// 新增成員
app.post('/api/groups/:id/members', requireAdmin, (req, res) => {
  const name = trimmedString(req.body?.name);
  if (!name) return res.status(400).json({ error: '請填寫成員名字' });
  if (name.length > 20) return res.status(400).json({ error: '成員名字最多 20 字' });
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: '找不到群組' });
  const exists = db
    .prepare('SELECT 1 FROM members WHERE group_id = ? AND name = ?')
    .get(group.id, name);
  if (exists) return res.status(409).json({ error: '已有同名成員' });
  const memberId = uid();
  db.prepare('INSERT INTO members (id, group_id, name) VALUES (?, ?, ?)')
    .run(memberId, group.id, name);
  res.json({ memberId });
});

// 刪除成員（公帳或有帳務紀錄則不可刪）
app.delete('/api/groups/:id/members/:memberId', requireAdmin, (req, res) => {
  const { id, memberId } = req.params;
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND group_id = ?').get(memberId, id);
  if (!member) return res.status(404).json({ error: '找不到成員' });
  if (member.is_fund) return res.status(400).json({ error: '「公帳」為系統帳戶，無法刪除' });
  const regularCount = db
    .prepare('SELECT COUNT(*) AS count FROM members WHERE group_id = ? AND is_fund = 0')
    .get(id).count;
  if (regularCount <= 1) return res.status(400).json({ error: '帳本至少需要保留一位一般成員' });
  const involved = db
    .prepare(`SELECT 1 FROM expenses WHERE group_id = ? AND payer_id = ?
              UNION SELECT 1 FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
              WHERE e.group_id = ? AND s.member_id = ?`)
    .get(id, memberId, id, memberId);
  if (involved) return res.status(409).json({ error: '此成員已有帳務紀錄，無法刪除' });
  db.prepare('DELETE FROM members WHERE id = ? AND group_id = ?').run(memberId, id);
  res.json({ ok: true });
});

// 新增類別
app.post('/api/groups/:id/categories', (req, res) => {
  const name = trimmedString(req.body?.name);
  const groupId = req.params.id;
  if (!name) return res.status(400).json({ error: '請填寫類別名稱' });
  if (name.length > 10) return res.status(400).json({ error: '類別名稱最多 10 字' });
  if (TRANSFER_CATEGORIES.includes(name) || name === '全部') {
    return res.status(400).json({ error: `「${name}」為系統保留名稱` });
  }
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: '找不到帳本' });
  const dup = db.prepare('SELECT 1 FROM categories WHERE group_id = ? AND name = ?').get(groupId, name);
  if (dup) return res.status(409).json({ error: '已有同名類別' });
  const categoryId = uid();
  const sort = db
    .prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE group_id = ?')
    .get(groupId).s;
  db.prepare('INSERT INTO categories (id, group_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)')
    .run(categoryId, groupId, name, 'tag', sort);
  res.json({ categoryId });
});

// 刪除類別（使用中或備援類別不可刪）
app.delete('/api/groups/:id/categories/:categoryId', requireAdmin, (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ? AND group_id = ?')
    .get(req.params.categoryId, req.params.id);
  if (!cat) return res.status(404).json({ error: '找不到類別' });
  if (cat.name === '其他') {
    return res.status(400).json({ error: '「其他」為預設備援類別，無法刪除' });
  }
  const used = db.prepare('SELECT 1 FROM expenses WHERE group_id = ? AND category = ? LIMIT 1')
    .get(req.params.id, cat.name);
  if (used) return res.status(409).json({ error: '有支出（含回收桶）使用此類別，無法刪除' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  res.json({ ok: true });
});

function createExpense(req, res, withReceipt = false) {
  const groupId = req.params.id;
  if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) {
    return res.status(404).json({ error: '找不到帳本' });
  }
  const parsed = validateExpenseInput(groupId, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const expense = parsed.value;
  const requestKey = req.body?.clientRequestId === undefined
    ? null
    : trimmedString(req.body.clientRequestId);
  if (req.body?.clientRequestId !== undefined
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
    return res.status(400).json({ error: '新增請求識別碼格式不正確' });
  }
  if (requestKey) {
    const existing = db.prepare(`SELECT id, group_id, version, receipt FROM expenses
      WHERE request_key = ?`).get(requestKey);
    if (existing) {
      if (existing.group_id !== groupId) {
        return res.status(409).json({ error: '新增請求識別碼已被使用' });
      }
      return res.json({
        expenseId: existing.id, version: existing.version, receipt: existing.receipt,
        duplicate: true,
      });
    }
  }

  const expenseId = uid();
  let receiptFilename = null;
  if (withReceipt) {
    const decoded = decodeReceipt(req.body?.receiptDataUrl);
    if (decoded.error) return res.status(400).json({ error: decoded.error });
    receiptFilename = `${expenseId}-${uid()}.${decoded.extension}`;
    try {
      writeReceiptAtomic(receiptFilename, decoded.buffer);
    } catch (error) {
      unlinkReceipt(receiptFilename);
      throw error;
    }
  }

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO expenses (
          id, group_id, payer_id, description, amount, category, expense_date, note, kind,
          receipt, request_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        expenseId, groupId, expense.payerId, expense.description, expense.amount,
        expense.category, expense.expenseDate, expense.note, expense.kind, receiptFilename, requestKey
      );
      const ins = db.prepare(
        'INSERT INTO expense_splits (expense_id, member_id, amount) VALUES (?, ?, ?)'
      );
      for (const split of expense.splits) {
        ins.run(expenseId, split.memberId, centsToMoney(split.amountCents));
      }
    })();
  } catch (error) {
    if (receiptFilename) unlinkReceipt(receiptFilename);
    if (requestKey && String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const existing = db.prepare(`SELECT id, group_id, version, receipt FROM expenses
        WHERE request_key = ?`).get(requestKey);
      if (existing?.group_id === groupId) {
        return res.json({
          expenseId: existing.id, version: existing.version, receipt: existing.receipt,
          duplicate: true,
        });
      }
    }
    throw error;
  }
  return res.json({ expenseId, version: 1, receipt: receiptFilename });
}

// 新增支出／收入
app.post('/api/groups/:id/expenses', (req, res) => {
  createExpense(req, res);
});

// 編輯支出／收入
app.put('/api/groups/:id/expenses/:expenseId', (req, res) => {
  const groupId = req.params.id;
  const expenseId = req.params.expenseId;

  const existing = db
    .prepare('SELECT id, version FROM expenses WHERE id = ? AND group_id = ? AND deleted_at IS NULL')
    .get(expenseId, groupId);
  if (!existing) return res.status(404).json({ error: '找不到這筆支出' });
  if (!Number.isSafeInteger(req.body?.version) || req.body.version < 1) {
    return res.status(400).json({ error: '缺少有效的紀錄版本，請重新整理後再試' });
  }
  if (req.body.version !== existing.version) {
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，請重新開啟後再編輯' });
  }
  const parsed = validateExpenseInput(groupId, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const expense = parsed.value;

  const saved = db.transaction(() => {
    const result = db.prepare(
      `UPDATE expenses SET payer_id = ?, description = ?, amount = ?, category = ?, expense_date = ?,
       note = ?, kind = ?, version = version + 1 WHERE id = ? AND version = ?`
    ).run(
      expense.payerId, expense.description, expense.amount, expense.category,
      expense.expenseDate, expense.note, expense.kind, expenseId, existing.version
    );
    if (result.changes === 0) return false;
    db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expenseId);
    const ins = db.prepare(
      'INSERT INTO expense_splits (expense_id, member_id, amount) VALUES (?, ?, ?)'
    );
    for (const split of expense.splits) {
      ins.run(expenseId, split.memberId, centsToMoney(split.amountCents));
    }
    return true;
  })();
  if (!saved) {
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，請重新開啟後再編輯' });
  }
  res.json({ ok: true, version: existing.version + 1 });
});

// 上傳／替換單據照片（base64 data URL）
app.post('/api/groups/:id/expenses/:expenseId/receipt', (req, res) => {
  const expense = db
    .prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ? AND deleted_at IS NULL')
    .get(req.params.expenseId, req.params.id);
  if (!expense) return res.status(404).json({ error: '找不到這筆支出' });
  if (!Number.isSafeInteger(req.body?.version) || req.body.version < 1) {
    return res.status(400).json({ error: '缺少有效的紀錄版本，請重新整理後再試' });
  }
  if (req.body.version !== expense.version) {
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，單據未上傳' });
  }

  const decoded = decodeReceipt(req.body?.dataUrl);
  if (decoded.error) return res.status(400).json({ error: decoded.error });

  const filename = `${expense.id}-${uid()}.${decoded.extension}`;
  writeReceiptAtomic(filename, decoded.buffer);
  let updated;
  try {
    updated = db.prepare(`UPDATE expenses SET receipt = ?, version = version + 1
      WHERE id = ? AND version = ?`).run(filename, expense.id, expense.version);
  } catch (error) {
    unlinkReceipt(filename);
    throw error;
  }
  if (updated.changes === 0) {
    unlinkReceipt(filename);
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，單據未上傳' });
  }
  if (expense.receipt && expense.receipt !== filename) unlinkReceipt(expense.receipt);
  res.json({ receipt: filename, version: expense.version + 1 });
});

// 移除單據照片
app.delete('/api/groups/:id/expenses/:expenseId/receipt', (req, res) => {
  const expense = db
    .prepare('SELECT * FROM expenses WHERE id = ? AND group_id = ? AND deleted_at IS NULL')
    .get(req.params.expenseId, req.params.id);
  if (!expense) return res.status(404).json({ error: '找不到這筆支出' });
  const version = Number(req.query.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    return res.status(400).json({ error: '缺少有效的紀錄版本，請重新整理後再試' });
  }
  if (version !== expense.version) {
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，單據未移除' });
  }
  const updated = db.prepare(`UPDATE expenses SET receipt = NULL, version = version + 1
    WHERE id = ? AND version = ?`).run(expense.id, version);
  if (updated.changes === 0) {
    return res.status(409).json({ error: '此紀錄已在其他裝置更新，單據未移除' });
  }
  unlinkReceipt(expense.receipt);
  res.json({ ok: true, version: version + 1 });
});

// 刪除支出（軟刪除：進回收桶，可由管理面板復原）
app.delete('/api/groups/:id/expenses/:expenseId', (req, res) => {
  const version = Number(req.query.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    return res.status(400).json({ error: '缺少有效的紀錄版本，請重新整理後再試' });
  }
  const result = db
    .prepare(`UPDATE expenses SET deleted_at = datetime('now'), version = version + 1
              WHERE id = ? AND group_id = ? AND deleted_at IS NULL AND version = ?`)
    .run(req.params.expenseId, req.params.id, version);
  if (result.changes === 0) {
    const active = db.prepare(
      'SELECT 1 FROM expenses WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(req.params.expenseId, req.params.id);
    if (active) {
      return res.status(409).json({ error: '此紀錄已在其他裝置更新，請重新整理後再刪除' });
    }
    return res.status(404).json({ error: '找不到這筆支出' });
  }
  res.json({ ok: true });
});

/* ============================================
   管理員面板（隱藏入口 /admin，密碼驗證）
   ============================================ */
const getConf = (key) =>
  db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key)?.value;
const setConf = (key, value) =>
  db.prepare(`INSERT INTO admin_config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !/^[0-9a-f]{128}$/i.test(hash || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 64));
  } catch {
    return false;
  }
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

const SESSION_DAYS = 7;
function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)')
    .run(sha256(token), expires);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function hasSession(req) {
  if (!getConf('password')) return false;
  const token = getCookie(req, 'admin_session');
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?')
    .get(sha256(token));
  return !!row && row.expires_at > new Date().toISOString();
}
function requireAdmin(req, res, next) {
  return hasSession(req) ? next() : res.status(401).json({ error: '未登入' });
}

// 登入防爆破：每個來源 15 分鐘內最多 8 次失敗
const loginFails = new Map();
function blocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginFails.delete(ip); return false; }
  return rec.count >= 8;
}
function recordFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  rec.count++;
  loginFails.set(ip, rec);
  if (loginFails.size > 1000) loginFails.delete(loginFails.keys().next().value);
}

// 隱藏入口：不在主畫面提供任何連結
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/status', (req, res) => {
  res.json({ setup: !!getConf('password'), authed: hasSession(req) });
});

// 首次使用：設定管理密碼（僅在尚未設定時允許）
app.post('/api/admin/setup', (req, res) => {
  if (getConf('password')) return res.status(409).json({ error: '已設定過密碼' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || password.length < 8) return res.status(400).json({ error: '密碼至少 8 碼' });
  if (password.length > 128) return res.status(400).json({ error: '密碼最多 128 碼' });
  db.transaction(() => {
    setConf('password', hashPassword(password));
    db.prepare('DELETE FROM admin_sessions').run();
    issueSession(req, res);
  })();
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
  const stored = getConf('password');
  if (!stored) return res.status(409).json({ error: '尚未設定密碼' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || password.length > 128 || !verifyPassword(password, stored)) {
    recordFail(req.ip);
    return res.status(401).json({ error: '密碼錯誤' });
  }
  loginFails.delete(req.ip);
  issueSession(req, res);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = getCookie(req, 'admin_session');
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const current = typeof req.body?.current === 'string' ? req.body.current : '';
  const next = typeof req.body?.next === 'string' ? req.body.next : '';
  const stored = getConf('password');
  if (!current || !verifyPassword(current, stored)) {
    return res.status(401).json({ error: '目前密碼錯誤' });
  }
  if (!next || next.length < 8) return res.status(400).json({ error: '新密碼至少 8 碼' });
  if (next.length > 128) return res.status(400).json({ error: '新密碼最多 128 碼' });
  db.transaction(() => {
    setConf('password', hashPassword(next));
    db.prepare('DELETE FROM admin_sessions').run();
    issueSession(req, res);
  })();
  res.json({ ok: true });
});

// 面板總覽：成員（含紀錄數）＋回收桶
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const group = db.prepare('SELECT * FROM groups ORDER BY created_at LIMIT 1').get();
  if (!group) return res.status(404).json({ error: '尚無帳本' });

  const members = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM expenses e WHERE e.payer_id = m.id) AS paid_count,
      (SELECT COUNT(*) FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
        WHERE s.member_id = m.id) AS split_count
    FROM members m WHERE m.group_id = ? ORDER BY m.created_at`).all(group.id);

  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const deleted = db.prepare(`SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC`).all(group.id);
  const splitStmt = db.prepare('SELECT member_id, amount FROM expense_splits WHERE expense_id = ?');
  for (const e of deleted) {
    delete e.request_key;
    e.payer_name = nameOf.get(e.payer_id) || '?';
    e.split_names = splitStmt.all(e.id).map((s) => nameOf.get(s.member_id) || '?');
  }

  const categories = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM expenses e WHERE e.group_id = c.group_id AND e.category = c.name)
        AS used_count
    FROM categories c WHERE c.group_id = ? ORDER BY c.sort, c.rowid`).all(group.id);

  const usageRow = db.prepare(`SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(success), 0) AS successes,
      COALESCE(SUM(has_receipt), 0) AS receipt_requests,
      COALESCE(ROUND(AVG(latency_ms)), 0) AS average_latency_ms,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(provider = 'openai'), 0) AS openai_requests,
      COALESCE(SUM(provider = 'local'), 0) AS local_requests,
      MAX(created_at) AS last_request_at
    FROM ai_usage WHERE created_at >= datetime('now', '-30 days')`).get();
  const usageErrors = db.prepare(`SELECT error_code, COUNT(*) AS count
    FROM ai_usage
    WHERE created_at >= datetime('now', '-30 days') AND error_code IS NOT NULL
    GROUP BY error_code ORDER BY count DESC`).all();
  const aiUsage = {
    periodDays: 30,
    ...usageRow,
    failures: usageRow.requests - usageRow.successes,
    errors: Object.fromEntries(usageErrors.map((row) => [row.error_code, row.count])),
  };

  res.json({ group, members, deleted, categories, aiUsage });
});

// 成員改名
app.post('/api/admin/members/:memberId/rename', requireAdmin, (req, res) => {
  const name = trimmedString(req.body?.name);
  if (!name) return res.status(400).json({ error: '請填寫名字' });
  if (name.length > 20) return res.status(400).json({ error: '成員名字最多 20 字' });
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).json({ error: '找不到成員' });
  const dup = db.prepare('SELECT 1 FROM members WHERE group_id = ? AND name = ? AND id != ?')
    .get(member.group_id, name, member.id);
  if (dup) return res.status(409).json({ error: '已有同名成員' });
  db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, member.id);
  res.json({ ok: true });
});

// 復原回收桶的支出
app.post('/api/admin/expenses/:expenseId/restore', requireAdmin, (req, res) => {
  const result = db.prepare(`UPDATE expenses SET deleted_at = NULL, version = version + 1
    WHERE id = ? AND deleted_at IS NOT NULL`)
    .run(req.params.expenseId);
  if (result.changes === 0) return res.status(404).json({ error: '找不到這筆紀錄' });
  res.json({ ok: true });
});

// 永久刪除（僅限已在回收桶的紀錄，連同單據檔案）
app.delete('/api/admin/expenses/:expenseId', requireAdmin, (req, res) => {
  const expense = db.prepare('SELECT receipt FROM expenses WHERE id = ? AND deleted_at IS NOT NULL')
    .get(req.params.expenseId);
  if (!expense) return res.status(404).json({ error: '找不到這筆紀錄' });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.expenseId);
  unlinkReceipt(expense.receipt);
  res.json({ ok: true });
});

// 清空回收桶
app.delete('/api/admin/trash', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, receipt FROM expenses WHERE deleted_at IS NOT NULL').all();
  const del = db.prepare('DELETE FROM expenses WHERE id = ?');
  db.transaction(() => { for (const r of rows) del.run(r.id); })();
  for (const r of rows) unlinkReceipt(r.receipt);
  res.json({ deleted: rows.length });
});

app.use('/api', (req, res) => res.status(404).json({ error: '找不到 API' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON 格式不正確' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '請求內容過大' });
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: '請求格式不受支援' });
  }
  console.error(err);
  return res.status(500).json({ error: '伺服器發生錯誤' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`分帳 App 已啟動： http://localhost:${PORT}`);
  });
}

module.exports = app;
