'use strict';

// Ensure a single super-admin "support" account exists — a login that can see
// every user's campaigns and reports.
//
// The password is NEVER stored in this repository. It comes from either:
//   • a command-line argument:   node scripts/ensure-support-admin.js '<password>'
//   • or SUPPORT_ADMIN_PASSWORD in server/.env  (which is gitignored)
// If neither is set, this is a no-op (so it can run safely on every deploy
// without a password being committed anywhere).
//
// On first run it creates the account. On later runs it re-asserts the admin
// role / active flag; the password is only (re)set when you pass one, so a
// password you rotate later isn't clobbered by a plain deploy.

const bcrypt = require('bcryptjs');
const db = require('../src/db');

const USERNAME = process.env.SUPPORT_ADMIN_USER || 'support';
const PASSWORD = process.argv[2] || process.env.SUPPORT_ADMIN_PASSWORD || '';

async function main() {
  if (!PASSWORD) {
    console.log(
      `No password provided — skipping "${USERNAME}" creation.\n` +
        `  To create it over SSH:   npm run ensure-support-admin -- '<password>'\n` +
        `  Or set SUPPORT_ADMIN_PASSWORD in server/.env and it is ensured on every deploy.`
    );
    await db.pool.end();
    return;
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  // Passing a password (re)sets it; a bare deploy with only .env still updates
  // it, which is fine — the source of truth is .env, not the repo.
  await db.execute(
    `INSERT INTO users (username, password_hash, full_name, role, is_active)
       VALUES (:username, :hash, 'Support (super-admin)', 'admin', 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', is_active = 1`,
    { username: USERNAME, hash }
  );
  console.log(`Support admin "${USERNAME}" ensured (role: admin).`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to ensure support admin:', err.message);
  process.exit(1);
});
