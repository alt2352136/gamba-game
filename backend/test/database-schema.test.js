import assert from "node:assert/strict";
import test from "node:test";
import { initializeGameSessionSchema } from "../src/database-schema.js";

test("session schema creates the expected tables and indexes", () => {
  const statements = [];
  const sql = {
    exec(statement) {
      statements.push(String(statement));
      if (String(statement).startsWith("ALTER TABLE rounds ADD COLUMN")) {
        throw new Error("duplicate column name: edge_percent");
      }
      return { toArray: () => [] };
    }
  };

  initializeGameSessionSchema(sql);
  for (const table of ["meta", "seeds", "rounds", "idempotency", "start_reservations", "early_release_intents", "session_stats", "personal_bests"]) {
    assert.ok(statements.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), `Missing ${table} schema`);
  }
  assert.ok(statements.some((statement) => statement.includes("rounds_status_idx")));
  assert.ok(statements.some((statement) => statement.includes("idempotency_action_created_idx")));
  assert.ok(statements.some((statement) => statement.includes("early_release_created_idx")));
});

test("schema migration rethrows errors other than duplicate-column", () => {
  const sql = {
    exec(statement) {
      if (String(statement).startsWith("ALTER TABLE rounds ADD COLUMN")) throw new Error("database unavailable");
      return { toArray: () => [] };
    }
  };
  assert.throws(() => initializeGameSessionSchema(sql), /database unavailable/);
});
