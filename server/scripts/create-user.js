'use strict';

// Create (or update) a login. Usage:
//   npm run create-user -- <username> <password> [fullName] [role]
// role defaults to "user"; pass "admin" for an admin account.
// Re-running with an existing username updates that user's password/role.

const bcrypt = require('bcryptjs');
const db = require('../src/db');

async function main() {
  const [, , username, password, fullName, roleArg] = process.argv;
  if (!username || !password) {
    console.error('Usage: npm run create-user -- <username> <password> [fullName] [role]');
    process.exit(1);
  }
  const role = roleArg === 'admin' ? 'admin' : 'user';
  const hash = await bcrypt.hash(password, 10);

  await db.execute(
    `INSERT INTO users (username, password_hash, full_name, role)
       VALUES (:username, :hash, :fullName, :role)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       full_name     = VALUES(full_name),
       role          = VALUES(role),
       is_active     = 1`,
    { username, hash, fullName: fullName || null, role }
  );

  console.log(`User "${username}" (role: ${role}) saved.`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to create user:', err.message);
  process.exit(1);
});
