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
      OPENAI_API_KEY: 'test-key',
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
      localDate: '2026-07-14',
      safetySessionId,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider, 'local');
  assert.equal(body.draft.ready, true);
  assert.equal(body.draft.amount, 500);
  assert.match(body.notices.join(' '), /已改用基本文字規則/);
  assert.match(body.notices.join(' '), /未辨識單據內容/);
  assert.ok(upstreamRequests >= 1);
  assert.ok(upstreamBodies.every((requestBody) => requestBody.store === false));
  assert.ok(upstreamBodies.every((requestBody) => requestBody.max_output_tokens === 2000));
  assert.ok(upstreamBodies.every((requestBody) => /^ledger_[0-9a-f]{32}$/.test(requestBody.safety_identifier)));
  assert.ok(upstreamBodies.every((requestBody) => !requestBody.safety_identifier.includes(safetySessionId)));
  assert.ok(upstreamBodies.every((requestBody) => requestBody.input[0].content[1].detail === 'high'));
});
