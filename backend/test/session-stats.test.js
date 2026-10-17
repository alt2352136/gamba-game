import assert from "node:assert/strict";
import test from "node:test";
import { readProfileData, recordSettledRound } from "../src/session-stats.js";

function createSqlMock(results = []) {
  const calls = [];
  return {
    calls,
    exec(statement, ...parameters) {
      calls.push({ statement: String(statement), parameters });
      const next = results.shift();
      return { toArray: () => next ?? [] };
    }
  };
}

test("profile data maps stored totals and calculates the win rate", () => {
  const sql = createSqlMock([
    [{ rounds_played: 4, wins: 2, losses: 1, pushes: 1, total_staked: 100, total_payout: 120,
      net_result: 20, best_multiplier: 2.5, best_payout: 60 }],
    [{ epoch: 1, round_number: 4, payout: 60 }]
  ]);

  const profile = readProfileData(sql);

  assert.deepEqual(profile.stats, {
    roundsPlayed: 4, wins: 2, losses: 1, pushes: 1, totalStaked: 100, totalPayout: 120,
    netResult: 20, bestMultiplier: 2.5, bestPayout: 60, winRate: 50
  });
  assert.deepEqual(profile.leaderboard, [{ epoch: 1, round_number: 4, payout: 60 }]);
  assert.equal(sql.calls.length, 2);
});

test("settling a round updates session totals", () => {
  const sql = createSqlMock();
  recordSettledRound(sql, { id: "round-1", epoch: 1 }, {
    payout: 20, stake: 10, multiplier: 2, net: 10, result: "CASHED OUT", round: 1, at: 123
  });

  assert.match(sql.calls[0].statement, /ON CONFLICT\(id\) DO UPDATE/);
  assert.deepEqual(sql.calls[0].parameters, [1, 0, 0, 10, 20, 10, 2, 20, 123]);
  assert.equal(sql.calls.length, 5, "eligible cash-outs update stats and evaluate leaderboard entries");
});

test("a busted round updates totals without performing leaderboard writes", () => {
  const sql = createSqlMock();
  recordSettledRound(sql, { id: "round-2", epoch: 1 }, {
    payout: 0, stake: 10, multiplier: 1, net: -10, result: "BUSTED", round: 2, at: 124
  });

  assert.equal(sql.calls.length, 1);
  assert.deepEqual(sql.calls[0].parameters, [0, 1, 0, 10, 0, -10, 0, 0, 124]);
});
