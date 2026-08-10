const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { initializeDatabase, closeDatabase } = require("../db");

initializeDatabase()
  .then(() => console.log("Database schema is ready."))
  .catch((error) => {
    console.error("Database initialization failed:", error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closeDatabase(); } catch (error) {
      console.error("Database shutdown failed:", error?.stack || error);
      process.exitCode = 1;
    }
  });
