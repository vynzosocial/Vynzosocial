const { Pool } = require('pg');

function buildPoolConfig() {
  if (process.env.DB_TARGET !== 'supabase') {
    throw new Error('DB_TARGET must be "supabase"; configure the Supabase database settings in the environment.');
  }
  const cmd = process.env.SUPABASE_DATABASE_URL || '';
  const user = (cmd.match(/-U\s+(\S+)/) || [])[1];
  const host = (cmd.match(/-h\s+(\S+)/) || [])[1];
  if (!host || !user || !process.env.SUPABASE_DB_PASSWORD) {
    throw new Error('DB_TARGET=supabase needs SUPABASE_DATABASE_URL and SUPABASE_DB_PASSWORD in the environment.');
  }
  return {
    host,
    port: Number((cmd.match(/-p\s+(\d+)/) || [])[1] || 5432),
    database: (cmd.match(/-d\s+(\S+)/) || [])[1] || 'postgres',
    user,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 10
  };
}

const pool = new Pool(buildPoolConfig());

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
