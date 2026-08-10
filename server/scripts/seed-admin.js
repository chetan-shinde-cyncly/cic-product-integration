const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { getPool, initializeDatabase, closeDatabase } = require("../db");
const { hashPassword } = require("../services/passwords");

async function main() {
  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!username || !password) throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required.");
  await initializeDatabase();
  const passwordHash = await hashPassword(password);
  await getPool().query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'ADMIN')
     ON CONFLICT (lower(username)) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       role = 'ADMIN', is_active = true, updated_at = now()`,
    [username, passwordHash],
  );
  console.log(`Administrator ${username} is ready.`);
}

main()
  .catch((error) => {
    console.error("Administrator seed failed:", error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closeDatabase(); } catch (error) {
      console.error("Database shutdown failed:", error?.stack || error);
      process.exitCode = 1;
    }
  });
