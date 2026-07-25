#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const secret = process.env.WEBHOOK_SECRET;
const port = Number(process.env.WEBHOOK_PORT || 3200);
const host = process.env.WEBHOOK_HOST || '192.168.1.120';
const branch = process.env.BRANCH || 'main';
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024);
const deployScript = process.env.DEPLOY_SCRIPT
  || '/home/fearnot/projects/split-bill/deploy/pi2/split-bill-deploy.sh';

if (!secret) throw new Error('WEBHOOK_SECRET is required');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('WEBHOOK_PORT must be a valid TCP port');
}
if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024) {
  throw new Error('MAX_BODY_BYTES must be an integer of at least 1024');
}
fs.accessSync(deployScript, fs.constants.X_OK);

let running = false;
let rerunRequested = false;

function verifySignature(body, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function runDeploy() {
  if (running) {
    rerunRequested = true;
    return false;
  }
  running = true;
  const childEnv = { ...process.env };
  delete childEnv.WEBHOOK_SECRET;
  const child = spawn(deployScript, {
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', (error) => {
    console.error(`${new Date().toISOString()} deploy spawn failed: ${error.message}`);
  });
  child.once('close', (code, signal) => {
    running = false;
    console.log(`${new Date().toISOString()} deploy exited code=${code} signal=${signal || 'none'}`);
    if (rerunRequested) {
      rerunRequested = false;
      setImmediate(runDeploy);
    }
  });
  return true;
}

function reply(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/github-webhook') {
    reply(response, 404, 'not found');
    return;
  }

  const chunks = [];
  let received = 0;
  let rejected = false;
  request.on('data', (chunk) => {
    if (rejected) return;
    received += chunk.length;
    if (received > maxBodyBytes) {
      rejected = true;
      reply(response, 413, 'payload too large');
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
    if (!verifySignature(body, request.headers['x-hub-signature-256'])) {
      reply(response, 401, 'bad signature');
      return;
    }

    const event = request.headers['x-github-event'];
    if (event === 'ping') {
      reply(response, 200, 'pong');
      return;
    }
    if (event !== 'push') {
      reply(response, 202, 'ignored event');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      reply(response, 400, 'bad json');
      return;
    }
    if (payload.ref !== `refs/heads/${branch}`) {
      reply(response, 202, 'ignored ref');
      return;
    }

    const queued = runDeploy();
    reply(response, 202, queued ? 'deploy queued' : 'deploy already running');
  });
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  console.log(`split-bill webhook listening on ${host}:${port}`);
});
