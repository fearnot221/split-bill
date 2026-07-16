'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server start timed out: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}: ${output}`));
    });
  });
}

test('falls back to an editable local draft when OpenAI is unavailable', async (t) => {
  let upstreamRequests = 0;
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'split-bill-ai-fallback-'));
  const keyFile = path.join(tempDir, 'auth.json');
  await fs.writeFile(keyFile, JSON.stringify({ OPENAI_API_KEY: 'test-key' }), { mode: 0o600 });
  const child = spawn(process.execPath, ['-e', [
    "const app = require('./server')",
    "const server = app.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port))",
  ].join(';')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: path.join(tempDir, 'data.db'),
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_FILE: keyFile,
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENAI_TIMEOUT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const port = await waitForReady(child);
  const me = await fetch(`http://127.0.0.1:${port}/api/me`).then((response) => response.json());
  const receipt = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const safetySessionId = '5dfe2f93-6d45-4c88-a8d6-687bcad78668';
  const response = await fetch(`http://127.0.0.1:${port}/api/groups/${me.groupId}/ai/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '晚餐500我付不分攤',
      receiptDataUrl: `data:image/jpeg;base64,${receipt}`,
      defaultMemberId: me.memberId,
      participantIds: [me.memberId],
      localDate: '2026-07-14',
      safetySessionId,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider, 'local');
  assert.equal(body.draft.ready, true);
  assert.equal(body.draft.amount, 500);
  assert.deepEqual(body.draft.participantIds, [me.memberId]);
  assert.equal(body.draft.splitMode, 'equal');
  assert.match(body.notices.join(' '), /已改用基本文字規則/);
  assert.match(body.notices.join(' '), /已套用分帳對象/);
  assert.match(body.notices.join(' '), /未辨識單據內容/);
  assert.doesNotMatch(body.draft.warnings.join(' '), /尚未設定 AI/);
  assert.equal(upstreamRequests, 1);
  assert.ok(upstreamBodies.every((requestBody) => requestBody.store === false));
  assert.ok(upstreamBodies.every((requestBody) => requestBody.max_output_tokens === 1200));
  assert.ok(upstreamBodies.every((requestBody) => /^ledger_[0-9a-f]{32}$/.test(requestBody.safety_identifier)));
  assert.ok(upstreamBodies.every((requestBody) => !requestBody.safety_identifier.includes(safetySessionId)));
  assert.ok(upstreamBodies.every((requestBody) => requestBody.input[0].content[1].detail === 'low'));
});

test('keeps the low-detail receipt draft when the total analysis deadline stops high detail', async (t) => {
  const upstreamBodies = [];
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      upstreamBodies.push(requestBody);
      if (upstreamBodies.length > 1) return;
      const draft = {
        isLedgerEntry: true,
        kind: 'expense',
        description: '夜市晚餐',
        amount: 486,
        category: '餐飲',
        expenseDate: '2026-07-12',
        payerName: '我',
        participantNames: ['我'],
        splitMode: 'none',
        customSplits: [],
        transferToName: null,
        note: null,
        confidence: 0.5,
        warnings: ['影像小字較模糊'],
      };
      const responseBody = JSON.stringify({
        id: 'resp_low_detail',
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: 'gpt-5.6-sol',
        output: [{
          id: 'msg_low_detail',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: JSON.stringify(draft),
            annotations: [],
          }],
        }],
        output_text: JSON.stringify(draft),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          total_tokens: 120,
        },
      });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      }, 200);
    });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'split-bill-ai-deadline-'));
  const keyFile = path.join(tempDir, 'auth.json');
  await fs.writeFile(keyFile, JSON.stringify({ OPENAI_API_KEY: 'test-key' }), { mode: 0o600 });
  const child = spawn(process.execPath, ['-e', [
    "const app = require('./server')",
    "const server = app.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port))",
  ].join(';')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: path.join(tempDir, 'data.db'),
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_FILE: keyFile,
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENAI_MODEL: 'gpt-5.6-sol',
      OPENAI_TIMEOUT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const port = await waitForReady(child);
  const me = await fetch(`http://127.0.0.1:${port}/api/me`).then((response) => response.json());
  const receipt = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/groups/${me.groupId}/ai/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '',
      receiptDataUrl: `data:image/jpeg;base64,${receipt}`,
      defaultMemberId: me.memberId,
      localDate: '2026-07-14',
    }),
  });
  const elapsedMs = Date.now() - startedAt;
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider, 'openai', JSON.stringify({ body, attempts: upstreamBodies.length }));
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.equal(body.draft.amount, 486);
  assert.equal(body.draft.expenseDate, '2026-07-12');
  assert.equal(body.draft.ready, true);
  assert.match(body.notices.join(' '), /單據細節確認時間較長/);
  assert.ok(elapsedMs >= 400, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 650, `total deadline was not applied: ${elapsedMs}ms`);
  assert.deepEqual(
    upstreamBodies.map((requestBody) => requestBody.input[0].content[1].detail),
    ['low', 'high']
  );
});
