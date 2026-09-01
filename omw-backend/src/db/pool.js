/**
 * Database connection — Supabase PostgreSQL
 * Supabase provides a free managed PostgreSQL instance (500MB, forever free).
 * Uses a single DATABASE_URL connection string for simplicity.
 * When migrating to AWS RDS later, just swap the DATABASE_URL value.
 */
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Supabase
  max:               5,   // Free tier — keep pool small
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("DB pool error:", err.message);
});

// Test connection on startup
pool.query("SELECT 1").then(() => {
  console.log("✅ Database connected (Supabase PostgreSQL)");
}).catch(err => {
  console.error("❌ Database connection failed:", err.message);
});

module.exports = pool;
