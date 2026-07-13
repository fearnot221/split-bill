'use strict';

const fs = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.resolve(process.env.DB_PATH || path.join(PROJECT_ROOT, 'data.db'));
const UPLOADS_PATH = path.resolve(process.env.UPLOAD_DIR || path.join(PROJECT_ROOT, 'uploads'));
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(PROJECT_ROOT, 'backups'));
const SNAPSHOT_ATTEMPTS = 3;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function publish(tempDir, baseName) {
  for (let suffix = 0; ; suffix += 1) {
    const name = suffix === 0 ? baseName : `${baseName}-${suffix}`;
    const destination = path.join(backupRoot, name);

    try {
      await fs.rename(tempDir, destination);
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
  }
}

function verifySnapshot(filename) {
  const snapshot = new Database(filename, { readonly: true, fileMustExist: true });

  try {
    const integrity = snapshot.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    const columns = snapshot.prepare('PRAGMA table_info(expenses)').all();
    if (!columns.some((column) => column.name === 'receipt')) return [];
    return snapshot.prepare(
      'SELECT receipt FROM expenses WHERE receipt IS NOT NULL ORDER BY receipt'
    ).all().map((row) => row.receipt);
  } finally {
    snapshot.close();
  }
}

async function createConsistentSnapshot(tempDir) {
  const backupDatabasePath = path.join(tempDir, 'data.db');
  const backupUploadsPath = path.join(tempDir, 'uploads');
  let lastError;

  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt += 1) {
    let sourceDatabase;
    try {
      await Promise.all([
        fs.rm(backupDatabasePath, { force: true }),
        fs.rm(`${backupDatabasePath}-wal`, { force: true }),
        fs.rm(`${backupDatabasePath}-shm`, { force: true }),
        fs.rm(backupUploadsPath, { recursive: true, force: true }),
      ]);

      sourceDatabase = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });
      await sourceDatabase.backup(backupDatabasePath);
      sourceDatabase.close();
      sourceDatabase = undefined;

      const receipts = verifySnapshot(backupDatabasePath);
      if (await pathExists(UPLOADS_PATH)) {
        await fs.cp(UPLOADS_PATH, backupUploadsPath, { recursive: true });
      } else {
        await fs.mkdir(backupUploadsPath);
      }

      for (const receipt of receipts) {
        if (typeof receipt !== 'string' || path.basename(receipt) !== receipt) {
          throw new Error(`invalid receipt filename in database: ${receipt}`);
        }
        let stat;
        try { stat = await fs.stat(path.join(backupUploadsPath, receipt)); } catch {}
        if (!stat?.isFile()) throw new Error(`receipt changed or is missing: ${receipt}`);
      }

      await fs.chmod(backupDatabasePath, 0o600);
      await Promise.all([
        fs.rm(`${backupDatabasePath}-wal`, { force: true }),
        fs.rm(`${backupDatabasePath}-shm`, { force: true }),
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (sourceDatabase?.open) sourceDatabase.close();
      if (attempt < SNAPSHOT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  throw new Error(`could not create a consistent database/uploads snapshot: ${lastError.message}`);
}

async function main() {
  if (isInside(UPLOADS_PATH, backupRoot)) {
    throw new Error('BACKUP_DIR cannot be uploads/ or one of its subdirectories');
  }
  if (!(await pathExists(DATABASE_PATH))) {
    throw new Error(`database not found: ${DATABASE_PATH}`);
  }

  await fs.mkdir(backupRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(backupRoot, '.backup-in-progress-'));

  try {
    await createConsistentSnapshot(tempDir);
    const destination = await publish(tempDir, timestamp());
    console.log(`Backup created: ${destination}`);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
