'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('production fails closed unless protection is configured or explicitly delegated', () => {
  const baseEnv = { ...process.env, NODE_ENV: 'production', APP_USERNAME: 'ledger' };
  delete baseEnv.APP_PASSWORD;
  delete baseEnv.ALLOW_PUBLIC_ACCESS;

  const blocked = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: path.resolve(__dirname, '..'),
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Refusing to start an unprotected production server/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-bill-security-'));
  const delegated = spawnSync(process.execPath, ['-e', "require('./server'); require('./db').close()"], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...baseEnv,
      ALLOW_PUBLIC_ACCESS: '1',
      DB_PATH: path.join(tempDir, 'data.db'),
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
    },
    encoding: 'utf8',
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(delegated.status, 0, delegated.stderr);
});
