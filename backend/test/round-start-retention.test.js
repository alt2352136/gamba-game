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

test("a saved round-start response can be replayed after the idempotency cache expires", async () => {
  const idempotencyKey = "start-key-00000001";
  const savedResponse = {
    state: { balance: 878, roundNumber: 1 },
    round: { id: "round-1", status: "running" }
  };
  const session = {
    cachedIdempotent: () => null,
    sql: {
      exec(statement, ...parameters) {
        assert.match(statement, /SELECT response_json FROM rounds WHERE idempotency_key/);
        assert.deepEqual(parameters, [idempotencyKey]);
        return { toArray: () => [{ response_json: JSON.stringify(savedResponse) }] };
      }
    }
  };

  const response = await GameSession.prototype.startRound.call(session, {}, idempotencyKey);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.state, savedResponse.state);
  assert.deepEqual(body.round, savedResponse.round);
  assert.equal(typeof body.serverTime, "number");
});
