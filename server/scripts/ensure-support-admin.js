'use strict';

// Ensure a single super-admin "support" account exists. Run automatically on
// every deploy (see deploy/update.sh and deploy/provision-debian.sh) so the
// operator always has a login that can see every user's campaigns and reports.
//
// Credentials come from the environment (put them in server/.env, which is NOT
// committed), falling back to the built-in defaults below. Because this file is
// committed, the default password is only as private as the repository —
// override SUPPORT_ADMIN_PASSWORD in .env and keep the repo private.
//
// On first run it creates the account. On later runs it only re-asserts the
// admin role / active flag and does NOT overwrite the password, so a password
// you change later isn't reverted by the next deploy.

const bcrypt = require('bcryptjs');
const db = require('../src/db');

const USERNAME = process.env.SUPPORT_ADMIN_USER || 'support';
const PASSWORD = process.env.SUPPORT_ADMIN_PASSWORD || 'SweetCMSB2026!';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  await db.execute(
    `INSERT INTO users (username, password_hash, full_name, role, is_active)
       VALUES (:username, :hash, 'Support (super-admin)', 'admin', 1)
     ON DUPLICATE KEY UPDATE role = 'admin', is_active = 1`,
    { username: USERNAME, hash }
  );
  console.log(`Support admin "${USERNAME}" ensured (role: admin).`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to ensure support admin:', err.message);
  process.exit(1);
});
