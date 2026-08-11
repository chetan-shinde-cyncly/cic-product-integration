const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    const connectionString = String(process.env.DATABASE_URL || "").trim();
    const hasPgConfiguration =
      process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD;
    if (!connectionString && !hasPgConfiguration) {
      throw new Error(
        "DATABASE_URL or PGHOST/PGUSER/PGPASSWORD is required. See server/.env.example.",
      );
    }
    pool = new Pool({
      ...(connectionString
        ? { connectionString }
        : {
            host: process.env.PGHOST,
            port: Number(process.env.PGPORT || 5432),
            database: process.env.PGDATABASE || "cic_catalogs",
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
          }),
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
