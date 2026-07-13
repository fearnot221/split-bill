'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tempDir;
let server;
let baseUrl;
let adminCookie = '';

const basicAuth = `Basic ${Buffer.from('tester:access-secret').toString('base64')}`;

async function request(pathname, options = {}) {
  const headers = { Authorization: basicAuth, ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.admin && adminCookie) headers.Cookie = adminCookie;
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'split-bill-api-'));
  process.env.DB_PATH = path.join(tempDir, 'data.db');
  process.env.UPLOAD_DIR = path.join(tempDir, 'uploads');
  process.env.APP_USERNAME = 'tester';
  process.env.APP_PASSWORD = 'access-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.OPENAI_API_KEY;

  const app = require('../server');
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  require('../db').close();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('API protects access, validates money, and rejects stale updates', async (t) => {
  let groupId;
  let payerId;
  let memberId;
  let expenseId;

  await t.test('requires the optional whole-app password', async () => {
    const response = await fetch(`${baseUrl}/api/me`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  await t.test('creates the ledger but protects management routes', async () => {
    const me = await request('/api/me');
    assert.equal(me.response.status, 200);
    assert.equal(me.response.headers.get('cache-control'), 'no-store');
    groupId = me.body.groupId;
    payerId = me.body.memberId;

    const unauthorized = await request(`/api/groups/${groupId}`, {
      method: 'PATCH',
      body: { name: '私人帳本' },
    });
    assert.equal(unauthorized.response.status, 401);
  });

  await t.test('establishes an admin session and updates ledger settings', async () => {
    const weakSetup = await request('/api/admin/setup', {
      method: 'POST',
      body: { password: '1234567' },
    });
    assert.equal(weakSetup.response.status, 400);
    assert.match(weakSetup.body.error, /8/);

    const setup = await request('/api/admin/setup', {
      method: 'POST',
      body: { password: 'admin-secret' },
    });
    assert.equal(setup.response.status, 200);
    const setCookie = setup.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    adminCookie = setCookie.split(';', 1)[0];

    const settings = await request(`/api/groups/${groupId}`, {
      method: 'PATCH',
      admin: true,
      body: { name: '私人帳本', currency: 'NT$' },
    });
    assert.equal(settings.response.status, 200);

    const member = await request(`/api/groups/${groupId}/members`, {
      method: 'POST',
      admin: true,
      body: { name: '小明' },
    });
    assert.equal(member.response.status, 200);
    memberId = member.body.memberId;

    const weakPasswordChange = await request('/api/admin/password', {
      method: 'POST',
      admin: true,
      body: { current: 'admin-secret', next: '1234567' },
    });
    assert.equal(weakPasswordChange.response.status, 400);
    assert.match(weakPasswordChange.body.error, /8/);
  });

  await t.test('creates an AI-ready draft with the local fallback', async () => {
    const status = await request('/api/ai/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.body.mode, 'local');
    assert.equal(status.body.receiptRecognition, false);

    const empty = await request(`/api/groups/${groupId}/ai/parse`, {
      method: 'POST',
      body: { text: '' },
    });
    assert.equal(empty.response.status, 400);

    const parsed = await request(`/api/groups/${groupId}/ai/parse`, {
      method: 'POST',
      body: {
        text: '昨天晚餐 NT$1,200，我跟小明均分，我付',
        defaultMemberId: payerId,
        localDate: '2026-07-14',
      },
    });
    assert.equal(parsed.response.status, 200);
    assert.equal(parsed.body.provider, 'local');
    assert.equal(parsed.body.draft.ready, true);
    assert.equal(parsed.body.draft.amount, 1200);
    assert.equal(parsed.body.draft.category, '餐飲');
    assert.equal(parsed.body.draft.expenseDate, '2026-07-13');
    assert.deepEqual(new Set(parsed.body.draft.participantIds), new Set([payerId, memberId]));

    const overview = await request('/api/admin/overview', { admin: true });
    assert.equal(overview.response.status, 200);
    assert.equal(overview.body.aiUsage.requests, 1);
    assert.equal(overview.body.aiUsage.successes, 1);
    assert.equal(overview.body.aiUsage.local_requests, 1);
    assert.equal(overview.body.aiUsage.openai_requests, 0);
    assert.deepEqual(overview.body.aiUsage.errors, {});

    const fakeReceipt = await request(`/api/groups/${groupId}/ai/parse`, {
      method: 'POST',
      body: {
        text: '請分析',
        receiptDataUrl: `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`,
      },
    });
    assert.equal(fakeReceipt.response.status, 400);
    assert.match(fakeReceipt.body.error, /格式不符/);
  });

  await t.test('rejects fractional cents, duplicate members, and invalid dates', async () => {
    const base = {
      payerId,
      description: '測試支出',
      amount: 1,
      category: '其他',
      expenseDate: '2026-07-13',
      kind: 'expense',
    };

    const fractional = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: { ...base, amount: 1.001, splits: [{ memberId, amount: 1.001 }] },
    });
    assert.equal(fractional.response.status, 400);
    assert.match(fractional.body.error, /兩位小數/);

    const amountTooLarge = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: { ...base, amount: 10_000_000_000, splits: [{ memberId, amount: 10_000_000_000 }] },
    });
    assert.equal(amountTooLarge.response.status, 400);
    assert.match(amountTooLarge.body.error, /上限/);

    const duplicate = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: {
        ...base,
        splits: [{ memberId, amount: 0.5 }, { memberId, amount: 0.5 }],
      },
    });
    assert.equal(duplicate.response.status, 400);
    assert.match(duplicate.body.error, /重複分攤/);

    const invalidDate = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: { ...base, expenseDate: '2026-02-30', splits: [{ memberId, amount: 1 }] },
    });
    assert.equal(invalidDate.response.status, 400);
    assert.match(invalidDate.body.error, /日期/);

    const oversized = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: { ...base, description: 'x'.repeat(110_000), splits: [{ memberId, amount: 1 }] },
    });
    assert.equal(oversized.response.status, 413);
  });

  await t.test('creates a new expense and receipt atomically', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const body = {
      payerId,
      description: '原子單據測試',
      amount: 2,
      category: '其他',
      expenseDate: '2026-07-13',
      kind: 'income',
      splits: [{ memberId: payerId, amount: 2 }],
    };
    const invalid = await request(`/api/groups/${groupId}/expenses-with-receipt`, {
      method: 'POST',
      body: {
        ...body,
        description: '不應建立',
        receiptDataUrl: `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`,
      },
    });
    assert.equal(invalid.response.status, 400);

    const created = await request(`/api/groups/${groupId}/expenses-with-receipt`, {
      method: 'POST',
      body: { ...body, receiptDataUrl: `data:image/jpeg;base64,${image.toString('base64')}` },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.version, 1);
    assert.match(created.body.receipt, /\.jpg$/);
    assert.equal(
      (await fs.stat(path.join(tempDir, 'uploads', created.body.receipt))).size,
      image.length
    );

    const ledger = await request(`/api/groups/${groupId}`);
    const saved = ledger.body.expenses.find((expense) => expense.id === created.body.expenseId);
    assert.equal(saved.receipt, created.body.receipt);
    assert.equal(ledger.body.expenses.some((expense) => expense.description === '不應建立'), false);
  });

  await t.test('settles exactly one cent and preserves the configured currency', async () => {
    const created = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: {
        payerId,
        description: '一分錢測試',
        amount: 0.01,
        category: '其他',
        expenseDate: '2026-07-13',
        kind: 'expense',
        splits: [{ memberId, amount: 0.01 }],
      },
    });
    assert.equal(created.response.status, 200);
    expenseId = created.body.expenseId;
    assert.equal(created.body.version, 1);

    const ledger = await request(`/api/groups/${groupId}`);
    assert.equal(ledger.response.status, 200);
    assert.equal(ledger.body.group.currency, 'NT$');
    assert.equal(ledger.body.total, 0.01);
    assert.deepEqual(ledger.body.settlements, [{ from: memberId, to: payerId, amount: 0.01 }]);

    const settled = await request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      body: {
        payerId: memberId,
        description: '結算轉帳',
        amount: 0.01,
        category: '轉帳',
        expenseDate: '2026-07-13',
        kind: 'expense',
        splits: [{ memberId: payerId, amount: 0.01 }],
      },
    });
    assert.equal(settled.response.status, 200);
    const afterSettlement = await request(`/api/groups/${groupId}`);
    assert.deepEqual(afterSettlement.body.settlements, []);
    assert.equal(afterSettlement.body.total, 0.01);
  });

  await t.test('uses optimistic versions for edits', async () => {
    const payload = {
      payerId,
      description: '更新後',
      amount: 0.01,
      category: '其他',
      expenseDate: '2026-07-13',
      kind: 'expense',
      splits: [{ memberId, amount: 0.01 }],
      version: 1,
    };
    const updated = await request(`/api/groups/${groupId}/expenses/${expenseId}`, {
      method: 'PUT',
      body: payload,
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.version, 2);

    const stale = await request(`/api/groups/${groupId}/expenses/${expenseId}`, {
      method: 'PUT',
      body: payload,
    });
    assert.equal(stale.response.status, 409);
    assert.match(stale.body.error, /其他裝置/);

    const staleDelete = await request(
      `/api/groups/${groupId}/expenses/${expenseId}?version=1`,
      { method: 'DELETE' }
    );
    assert.equal(staleDelete.response.status, 409);
  });

  await t.test('validates and versions receipt changes', async () => {
    const empty = await request(`/api/groups/${groupId}/expenses/${expenseId}/receipt`, {
      method: 'POST',
    });
    assert.equal(empty.response.status, 400);

    const receipt = await request(`/api/groups/${groupId}/expenses/${expenseId}/receipt`, {
      method: 'POST',
      body: {
        dataUrl: `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`,
        version: 2,
      },
    });
    assert.equal(receipt.response.status, 400);
    assert.match(receipt.body.error, /格式不符/);

    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const uploaded = await request(`/api/groups/${groupId}/expenses/${expenseId}/receipt`, {
      method: 'POST',
      body: { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`, version: 2 },
    });
    assert.equal(uploaded.response.status, 200);
    assert.equal(uploaded.body.version, 3);
    const uploadedPath = path.join(tempDir, 'uploads', uploaded.body.receipt);
    assert.equal((await fs.stat(uploadedPath)).size, image.length);

    const staleRemove = await request(
      `/api/groups/${groupId}/expenses/${expenseId}/receipt?version=2`,
      { method: 'DELETE' }
    );
    assert.equal(staleRemove.response.status, 409);

    const removed = await request(
      `/api/groups/${groupId}/expenses/${expenseId}/receipt?version=3`,
      { method: 'DELETE' }
    );
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.version, 4);
    await assert.rejects(fs.stat(uploadedPath), { code: 'ENOENT' });
  });

  await t.test('invalidates sessions when the admin password is reset out of band', async () => {
    require('../db').prepare("DELETE FROM admin_config WHERE key = 'password'").run();
    const overview = await request('/api/admin/overview', { admin: true });
    assert.equal(overview.response.status, 401);
  });
});
