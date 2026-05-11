'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const isVercel = process.env.VERCEL === '1';

if (isVercel) {
  // On Vercel: copy the bundled DB from db/ to /tmp so it becomes writable
  const tmpDir = '/tmp/data';
  const tmpDb = path.join(tmpDir, 'waitless.db');
  const bundledDb = path.join(__dirname, 'waitless.db');

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Copy bundled DB to /tmp only if /tmp copy doesn't exist yet
  if (!fs.existsSync(tmpDb) && fs.existsSync(bundledDb)) {
    fs.copyFileSync(bundledDb, tmpDb);
  }

  var DB_PATH = tmpDb;
} else {
  // Local dev: use data/ directory
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  var DB_PATH = path.join(dataDir, 'waitless.db');
}

const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000');   // 8 MB cache

// Run schema on first use
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
