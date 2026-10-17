import assert from "node:assert/strict";
import test from "node:test";
import { GameSession } from "../src/game-session.js";

function isApiError(error, status, code) {
  return error && error.status === status && error.code === code;
}

test("client seed cannot be changed while a server round is active", async () => {
  const session = {
    readState: () => ({ balance: 800, currentEpoch: 1, clientSeed: "client-seed-1234" }),
    getActiveRound: () => ({ id: "active-round", status: "running" })
  };

  await assert.rejects(
    GameSession.prototype.setClientSeed.call(session, { clientSeed: "replacement-seed-123" }),
    (error) => isApiError(error, 409, "round_in_progress")
  );
});

test("game reset cannot run while a server round is active", async () => {
  const session = {
    readState: () => ({ balance: 800, currentEpoch: 1, clientSeed: "client-seed-1234" }),
    cachedIdempotent: () => null,
    getActiveRound: () => ({ id: "active-round", status: "running" })
  };

  await assert.rejects(
    GameSession.prototype.resetGame.call(session, "reset-guard-test-0001"),
    (error) => isApiError(error, 409, "round_in_progress")
  );
});

test("fairness endpoint never returns the crash point for a running round", async () => {
  const calls = [];
  const session = {
    readState: () => ({ currentEpoch: 1, edgePercent: 1 }),
    currentCommitment: () => "a".repeat(64),
    sql: {
      exec(query, ...args) {
        calls.push({ query, args });
        if (query.includes("COUNT(*) AS count FROM seeds")) return { toArray: () => [{ count: 1 }] };
        if (query.includes("COUNT(*) AS count FROM rounds")) return { toArray: () => [{ count: 1 }] };
        if (query.includes("FROM seeds ORDER BY epoch ASC")) {
          return { toArray: () => [{ epoch: 1, commitment: "a".repeat(64), revealed_seed: null }] };
        }
        if (query.includes("FROM rounds ORDER BY started_at ASC")) {
          assert.match(query, /CASE WHEN status='running' THEN NULL ELSE crash_point END AS crash_point/);
          return { toArray: () => [{ id: "active-round", epoch: 1, nonce: 1, status: "running", crash_point: null }] };
        }
        throw new Error(`Unexpected SQL in fairness test: ${query}`);
      }
    }
  };

  const response = await GameSession.prototype.fairness.call(session, new URLSearchParams("limit=10"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rounds.length, 1);
  assert.equal(body.rounds[0].status, "running");
  assert.equal(body.rounds[0].crash_point, null);
});

test("setting the same client seed again avoids a redundant state write", async () => {
  let writes = 0;
  const session = {
    readState: () => ({ clientSeed: "same-client-seed-123", currentEpoch: 1 }),
    getActiveRound: () => null,
    currentCommitment: () => "a".repeat(64),
    writeState: () => { writes += 1; },
    ctx: { storage: { transactionSync(callback) { return callback(); } } }
  };

  const response = await GameSession.prototype.setClientSeed.call(session, {
    clientSeed: "same-client-seed-123"
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.clientSeed, "same-client-seed-123");
  assert.equal(data.commitment, "a".repeat(64));
  assert.equal(writes, 0);
});




function fakeStartReservationSession() {
  let reservation = null;
  const metadata = new Map();
  return {
    ctx: { storage: { transactionSync(callback) { return callback(); } } },
    sql: {
      exec(query, ...args) {
        if (query.startsWith("SELECT idempotency_key,created_at FROM start_reservations")) {
          return { toArray: () => reservation ? [{ ...reservation }] : [] };
        }
        if (query.startsWith("SELECT value FROM meta WHERE key='last_start_completed_at'")) {
          const value = metadata.get("last_start_completed_at");
          return { toArray: () => value === undefined ? [] : [{ value }] };
        }
        if (query.startsWith("INSERT INTO start_reservations")) {
          reservation = { id: 1, idempotency_key: args[0], received_at: args[1], created_at: args[2] };
          return { toArray: () => [] };
        }
        if (query.startsWith("DELETE FROM start_reservations WHERE id=1 AND idempotency_key=?")) {
          if (reservation?.idempotency_key === args[0]) reservation = null;
          return { toArray: () => [] };
        }
        if (query.startsWith("DELETE FROM start_reservations WHERE id=1")) {
          reservation = null;
          return { toArray: () => [] };
        }
        if (query.startsWith("INSERT INTO meta(key,value)")) {
          metadata.set(args[0], args[1]);
          return { toArray: () => [] };
        }
        throw new Error(`Unexpected SQL in reservation test: ${query}`);
      }
    },
    getReservation: () => reservation,
    setLastCompletedAt: (value) => metadata.set("last_start_completed_at", String(value))
  };
}

test("start reservation rejects a second concurrent start before crypto can interleave", () => {
  const session = fakeStartReservationSession();
  const firstKey = "start-key-00000001";
  const secondKey = "start-key-00000002";
  GameSession.prototype.reserveStartSlot.call(session, firstKey, Date.now());
  assert.equal(session.getReservation().idempotency_key, firstKey);
  assert.throws(
    () => GameSession.prototype.reserveStartSlot.call(session, secondKey, Date.now()),
    (error) => error?.status === 409 && error?.code === "round_start_in_progress"
  );
  assert.equal(session.getReservation().idempotency_key, firstKey,
    "A rejected concurrent request must not release the original reservation.");
});

test("a start received before the previous start completed stays rejected if it was queued", () => {
  const session = fakeStartReservationSession();
  const completedAt = Date.now();
  session.setLastCompletedAt(completedAt);
  assert.throws(
    () => GameSession.prototype.reserveStartSlot.call(session, "start-key-00000003", completedAt - 1),
    (error) => error?.status === 409 && error?.code === "round_start_in_progress"
  );
  assert.equal(session.getReservation(), null,
    "The rejected queued request must not acquire the start reservation.");
});
