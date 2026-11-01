const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function supabaseConfig() {
  const env = readEnv();
  const cmd = env.SUPABASE_DATABASE_URL || '';
  const host = (cmd.match(/-h\s+(\S+)/) || [])[1];
  const port = Number((cmd.match(/-p\s+(\d+)/) || [])[1] || 5432);
  const database = (cmd.match(/-d\s+(\S+)/) || [])[1] || 'postgres';
  const user = (cmd.match(/-U\s+(\S+)/) || [])[1];
  return { host, port, database, user, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } };
}

module.exports = { readEnv, supabaseConfig };

if (require.main === module) {
  const cfg = supabaseConfig();
  const uri = `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${cfg.database}`;
  console.log('masked uri:', uri.replace(/:[^:@]*@/, ':***@'));
  const client = new Client(cfg);
  client.connect()
    .then(() => client.query('SELECT current_database() AS db, (SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\') AS public_tables'))
    .then(r => { console.log('connected', r.rows[0]); return client.end(); })
    .catch(e => { console.log('FAILED:', e.code || '', e.message); process.exit(1); });
}
