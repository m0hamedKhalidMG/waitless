'use strict';
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || 'libsql://waitless-labuser15.aws-ap-south-1.turso.io';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, authToken });

function rowToObject(columns, row) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj;
}

const db = {
  client,
  prepare(sql) {
    return {
      async get(...args) {
        const rs = await client.execute({ sql, args });
        if (!rs.rows || rs.rows.length === 0) return undefined;
        return rowToObject(rs.columns, rs.rows[0]);
      },
      async all(...args) {
        const rs = await client.execute({ sql, args });
        if (!rs.rows) return [];
        return rs.rows.map(r => rowToObject(rs.columns, r));
      },
      async run(...args) {
        const rs = await client.execute({ sql, args });
        return { lastInsertRowid: rs.lastInsertRowid, changes: rs.rowsAffected };
      }
    };
  },
  async exec(sql) {
    await client.execute(sql);
  },
  async batch(stmts) {
    // stmts: array of { sql, args }
    return await client.batch(stmts);
  }
};

module.exports = db;
