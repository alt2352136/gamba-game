// Keep table definitions and schema migrations in one place. Transactions that mutate game
// state remain in GameSession so wallet and round records can still change atomically.
export function initializeGameSessionSchema(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec(`CREATE TABLE IF NOT EXISTS seeds (
    epoch INTEGER PRIMARY KEY, commitment TEXT NOT NULL, seed_iv TEXT NOT NULL,
    seed_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, revealed_seed TEXT, revealed_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY, nonce INTEGER NOT NULL, epoch INTEGER NOT NULL, client_seed TEXT NOT NULL,
    stake INTEGER NOT NULL, started_at INTEGER NOT NULL, crash_point REAL NOT NULL,
    status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0, cashed_out_at INTEGER,
    idempotency_key TEXT UNIQUE, response_json TEXT, edge_percent REAL NOT NULL DEFAULT 1
  )`);
  // Older Durable Objects do not have edge_percent. Ignore only SQLite's duplicate-column case.
  try { sql.exec("ALTER TABLE rounds ADD COLUMN edge_percent REAL NOT NULL DEFAULT 1"); }
  catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
  }
  sql.exec("CREATE INDEX IF NOT EXISTS rounds_status_idx ON rounds(status)");
  sql.exec("CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, action TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS idempotency_action_created_idx ON idempotency(action, created_at)");
  sql.exec(`CREATE TABLE IF NOT EXISTS start_reservations (
    id INTEGER PRIMARY KEY CHECK(id=1), idempotency_key TEXT NOT NULL,
    received_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS early_release_intents (
    start_key TEXT PRIMARY KEY, release_key TEXT NOT NULL, released_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS early_release_created_idx ON early_release_intents(created_at)");
  sql.exec(`CREATE TABLE IF NOT EXISTS session_stats (
    id INTEGER PRIMARY KEY CHECK(id=1), rounds_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, pushes INTEGER NOT NULL DEFAULT 0,
    total_staked INTEGER NOT NULL DEFAULT 0, total_payout INTEGER NOT NULL DEFAULT 0,
    net_result INTEGER NOT NULL DEFAULT 0, best_multiplier REAL NOT NULL DEFAULT 0,
    best_payout INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS personal_bests (
    round_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, round_number INTEGER NOT NULL,
    stake INTEGER NOT NULL, payout INTEGER NOT NULL, multiplier REAL NOT NULL,
    net INTEGER NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
}
