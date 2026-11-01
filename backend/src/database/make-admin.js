// Usage: npm run make-admin -- <username>   (add --revoke to remove admin rights)
require('dotenv').config();
const db = require('./db');

(async () => {
  const [username, flag] = process.argv.slice(2);
  if (!username) {
    console.error('Usage: npm run make-admin -- <username> [--revoke]');
    process.exit(1);
  }
  const result = await db.query(
    'UPDATE users SET is_admin = $2 WHERE LOWER(username) = LOWER($1) RETURNING username, is_admin',
    [username, flag !== '--revoke']
  );
  console.log(result.rows[0] ? `@${result.rows[0].username} is_admin = ${result.rows[0].is_admin}` : 'User not found');
  process.exit(result.rows[0] ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
