const { pool } = require('./db');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS strategies (
     id SERIAL PRIMARY KEY,
     save_name TEXT UNIQUE NOT NULL,
     source_url TEXT,
     config JSONB NOT NULL,
     years_back INT NOT NULL DEFAULT 5,
     active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS series_points (
     strategy_id INT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     line_label TEXT NOT NULL,
     trade_date DATE NOT NULL,
     value DOUBLE PRECISION NOT NULL,
     PRIMARY KEY (strategy_id, line_label, trade_date)
   )`,
  `CREATE TABLE IF NOT EXISTS daily_scores (
     strategy_id INT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     score_date DATE NOT NULL,
     direction INT,
     reliability DOUBLE PRECISION,
     strength DOUBLE PRECISION,
     tracking DOUBLE PRECISION,
     stretch_score DOUBLE PRECISION,
     setup_score DOUBLE PRECISION,
     in_window BOOLEAN,
     flagged BOOLEAN,
     details JSONB,
     PRIMARY KEY (strategy_id, score_date)
   )`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
     id SERIAL PRIMARY KEY,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     status TEXT NOT NULL DEFAULT 'running',
     detail JSONB
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL
   )`,
  // Analog-matching pivot (2026-07-08): per-year features + Claude verdict.
  `ALTER TABLE daily_scores ADD COLUMN IF NOT EXISTS analog JSONB`,
  `ALTER TABLE daily_scores ADD COLUMN IF NOT EXISTS verdict JSONB`,
];

async function migrate() {
  for (const sql of MIGRATIONS) await pool.query(sql);
}

module.exports = { migrate, MIGRATIONS };
