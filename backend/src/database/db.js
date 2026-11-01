const { Pool } = require('pg');

function buildPoolConfig() {
  if (process.env.DB_TARGET === 'supabase') {
    const cmd = process.env.SUPABASE_DATABASE_URL || '';
    const user = (cmd.match(/-U\s+(\S+)/) || [])[1];
    const host = (cmd.match(/-h\s+(\S+)/) || [])[1];
    if (!host || !user || !process.env.SUPABASE_DB_PASSWORD) {
      throw new Error('DB_TARGET=supabase needs SUPABASE_DATABASE_URL and SUPABASE_DB_PASSWORD in backend/.env.');
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
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Configure it in backend/.env before starting the server.');
  }
  return { connectionString: process.env.DATABASE_URL };
}

const pool = new Pool(buildPoolConfig());

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
