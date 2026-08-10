const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required. See server/.env.example.");
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return pool;
}

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await getPool().query(schema);
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, initializeDatabase, closeDatabase };

