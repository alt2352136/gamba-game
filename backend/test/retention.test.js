import assert from "node:assert/strict";
import test from "node:test";
import { GameSession } from "../src/game-session.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("retention cleanup prunes only replayable old round-start cache entries", () => {
  const statements = [];
  const session = {
    sql: {
      exec(statement, ...params) {
        statements.push({ statement, params });
        return { toArray: () => [] };
      }
    }
  };
  const now = 2_000_000_000_000;
  GameSession.prototype.cleanupExpiredRecords.call(session, now);

  const startCacheCleanup = statements.find((entry) => entry.statement.includes("DELETE FROM idempotency"));
  assert.ok(startCacheCleanup);
  assert.match(startCacheCleanup.statement, /action='round-start'/);
  assert.match(startCacheCleanup.statement, /response_json IS NOT NULL/);
  assert.equal(startCacheCleanup.params[0], now - 30 * DAY_MS);

  const intentCleanup = statements.find((entry) => entry.statement.includes("DELETE FROM early_release_intents"));
  assert.ok(intentCleanup);
  assert.equal(intentCleanup.params[0], now - 60_000);
});

test("start responses are persisted for safe replay after the cache retention window", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/game-session.js", import.meta.url), "utf8");
  assert.match(source, /UPDATE rounds SET response_json=\? WHERE id=\?/);
  assert.match(source, /SELECT response_json FROM rounds WHERE idempotency_key=\?/);
});
