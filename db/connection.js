'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use /tmp on Vercel (read-only filesystem except /tmp)
const isVercel = process.env.VERCEL === '1';
const DATA_DIR = isVercel ? '/tmp/data' : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'waitless.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
