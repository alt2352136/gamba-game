import assert from "node:assert/strict";
import test from "node:test";
import { GameSession } from "../src/game-session.js";

function alarmHarness({ round, now = Date.now() } = {}) {
  const calls = { busted: 0, capped: 0, scheduled: [] };
  const state = { balance: 888 };
  const session = {
    ctx: { storage: { async setAlarm(at) { calls.scheduled.push(Number(at)); } } },
    getActiveRound() { return round || null; },
    readState() { return state; },
    settlementAt(value) {
      const target = Math.min(10, Math.max(1, Number(value.crash_point) || 1));
      return Number(value.started_at) + Math.max(0, Math.ceil(((target - 1) / 0.8) * 1000));
    },
    async settleBust(actualRound, actualState, at) {
      calls.busted += 1;
      calls.settledRound = actualRound;
      calls.settledState = actualState;
      calls.settledAt = at;
    },
    async settleAtCap(actualRound, actualState, at) {
      calls.capped += 1;
      calls.settledRound = actualRound;
      calls.settledState = actualState;
      calls.settledAt = at;
    },
    _now: now
  };
  return { session, calls };
}

test("Durable Object alarm settles a crashed round without a browser request", async () => {
  const startedAt = Date.now() - 5000;
  const round = { id: "alarm-bust", started_at: startedAt, crash_point: 2.25 };
  const { session, calls } = alarmHarness({ round });

  await GameSession.prototype.alarm.call(session);

  assert.equal(calls.busted, 1);
  assert.equal(calls.capped, 0);
  assert.equal(calls.settledRound.id, "alarm-bust");
});

test("Durable Object alarm automatically settles a round at x10 when crash point is higher", async () => {
  const startedAt = Date.now() - 20_000;
  const round = { id: "alarm-cap", started_at: startedAt, crash_point: 25 };
  const { session, calls } = alarmHarness({ round });

  await GameSession.prototype.alarm.call(session);

  assert.equal(calls.busted, 0);
  assert.equal(calls.capped, 1);
  assert.equal(calls.settledRound.id, "alarm-cap");
});

test("an early Durable Object alarm reschedules until the crash/cap deadline", async () => {
  const startedAt = Date.now() - 500;
  const round = { id: "alarm-early", started_at: startedAt, crash_point: 5 };
  const { session, calls } = alarmHarness({ round });

  await GameSession.prototype.alarm.call(session);

  assert.equal(calls.busted, 0);
  assert.equal(calls.capped, 0);
  assert.equal(calls.scheduled.length, 1);
  assert.ok(calls.scheduled[0] >= session.settlementAt(round));
});

test("an alarm after a round is already settled is a no-op", async () => {
  const { session, calls } = alarmHarness({ round: null });

  await GameSession.prototype.alarm.call(session);

  assert.equal(calls.busted, 0);
  assert.equal(calls.capped, 0);
  assert.equal(calls.scheduled.length, 0);
});
