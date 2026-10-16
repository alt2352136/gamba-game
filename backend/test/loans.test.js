import assert from "node:assert/strict";
import test from "node:test";
import { GameSession } from "../src/index.js";

function state(overrides = {}) {
  return {
    balance: 0,
    roundNumber: 0,
    gameOver: false,
    waitingForLoan: true,
    activeLoans: [],
    history: [],
    loansTaken: { "444": false, "888": false, "1500": false },
    ...overrides
  };
}

function settleRound(gameState, { stake = 1, payout = 0, result = "BUSTED" } = {}) {
  return GameSession.prototype.settleRound.call(
    {},
    { id: "test-round", stake },
    gameState,
    result,
    result === "BUSTED" ? 0 : 1,
    payout,
    1_800_000_000_000
  );
}

function makeLoanHarness(initialState, { activeRound = null } = {}) {
  let storedState = structuredClone(initialState);
  const idempotency = new Map();

  const session = {
    ctx: { storage: { transactionSync(callback) { return callback(); } } },
    readState() { return storedState; },
    getActiveRound() { return activeRound; },
    cachedIdempotent(key, action) {
      const saved = idempotency.get(key);
      if (!saved) return null;
      if (saved.action !== action) {
        const error = new Error("Idempotency key reused for another action");
        error.status = 409;
        error.code = "idempotency_key_reused";
        throw error;
      }
      return saved.response;
    },
    publicState(value) {
      return structuredClone({
        balance: value.balance,
        roundNumber: value.roundNumber,
        gameOver: value.gameOver,
        waitingForLoan: value.waitingForLoan,
        activeLoans: value.activeLoans,
        loansTaken: value.loansTaken
      });
    },
    writeState(value) { storedState = structuredClone(value); },
    storeIdempotent(key, action, response) { idempotency.set(key, { action, response }); }
  };

  return {
    session,
    getState: () => structuredClone(storedState),
    idempotency
  };
}

async function takeLoan(harness, principal, key = "test-loan-key-0001") {
  const response = await GameSession.prototype.takeLoan.call(
    harness.session,
    { principal },
    key
  );
  return { status: response.status, data: await response.json() };
}

test("loan deadline decreases by exactly one after a settled round", () => {
  const gameState = state({
    activeLoans: [{ principal: 444, repayment: 533, roundsLeft: 4 }]
  });

  settleRound(gameState);

  assert.equal(gameState.activeLoans[0].roundsLeft, 3);
  assert.equal(gameState.roundNumber, 1);
  assert.equal(gameState.waitingForLoan, true);
  assert.equal(gameState.gameOver, false);
});

test("an expired debt with positive but insufficient balance causes default", () => {
  const gameState = state({
    balance: 100,
    activeLoans: [{ principal: 444, repayment: 533, roundsLeft: 1 }]
  });

  const settlement = settleRound(gameState);

  assert.equal(gameState.activeLoans[0].roundsLeft, 0);
  assert.equal(gameState.gameOver, true);
  assert.equal(gameState.waitingForLoan, false);
  assert.equal(settlement.defaultedLoan.principal, 444);
});

test("an expired debt at zero balance gives the player a loan decision", () => {
  const gameState = state({
    balance: 0,
    activeLoans: [{ principal: 888, repayment: 1110, roundsLeft: 1 }]
  });

  const settlement = settleRound(gameState);

  assert.equal(gameState.activeLoans[0].roundsLeft, 0);
  assert.equal(gameState.gameOver, false);
  assert.equal(gameState.waitingForLoan, true);
  assert.equal(settlement.defaultedLoan.principal, 888);
});

test("repays only affordable debts and prioritizes the nearest deadline", () => {
  const gameState = state({
    balance: 0,
    activeLoans: [
      { principal: 888, repayment: 1110, roundsLeft: 5 },
      { principal: 444, repayment: 533, roundsLeft: 1 }
    ]
  });

  const settlement = settleRound(gameState, { payout: 700, result: "CASHED OUT" });

  assert.deepEqual(settlement.repayments, [{ principal: 444, repayment: 533 }]);
  assert.equal(gameState.balance, 167);
  assert.deepEqual(gameState.activeLoans, [{ principal: 888, repayment: 1110, roundsLeft: 4 }]);
  assert.equal(gameState.gameOver, false);
});

test("repays multiple affordable debts in deadline order", () => {
  const gameState = state({
    balance: 0,
    activeLoans: [
      { principal: 444, repayment: 533, roundsLeft: 2 },
      { principal: 888, repayment: 1110, roundsLeft: 1 }
    ]
  });

  const settlement = settleRound(gameState, { payout: 2000, result: "CASHED OUT" });

  assert.deepEqual(settlement.repayments, [
    { principal: 888, repayment: 1110 },
    { principal: 444, repayment: 533 }
  ]);
  assert.equal(gameState.balance, 357);
  assert.equal(gameState.activeLoans.length, 0);
  assert.equal(settlement.historyItem.net, 356);
});

test("valid 444-gold loan updates the wallet and establishes the deadline", async () => {
  const harness = makeLoanHarness(state());

  const result = await takeLoan(harness, 444);

  assert.equal(result.status, 200);
  assert.equal(result.data.loan.principal, 444);
  assert.equal(result.data.loan.repayment, 533);
  assert.equal(result.data.loan.roundsLeft, 8);
  assert.equal(result.data.extension, 0);
  assert.equal(result.data.state.balance, 444);
  assert.equal(result.data.state.waitingForLoan, false);
  assert.deepEqual(result.data.state.activeLoans, [
    { principal: 444, repayment: 533, roundsLeft: 8 }
  ]);
  assert.equal(result.data.state.loansTaken["444"], true);
});

test("replaying the same loan idempotency key does not issue a second loan", async () => {
  const harness = makeLoanHarness(state());

  const first = await takeLoan(harness, 444, "same-loan-key-0001");
  const replay = await takeLoan(harness, 444, "same-loan-key-0001");

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, first.data);
  assert.equal(harness.getState().balance, 444);
  assert.equal(harness.getState().activeLoans.length, 1);
});

test("taking a different loan extends existing deadlines by half the nearest remaining deadline", async () => {
  const harness = makeLoanHarness(state({
    balance: 0,
    activeLoans: [{ principal: 444, repayment: 533, roundsLeft: 7 }],
    loansTaken: { "444": true, "888": false, "1500": false }
  }));

  const result = await takeLoan(harness, 888, "extend-loan-key-0001");

  assert.equal(result.status, 200);
  assert.equal(result.data.extension, 4);
  assert.equal(result.data.state.balance, 888);
  assert.deepEqual(result.data.state.activeLoans, [
    { principal: 444, repayment: 533, roundsLeft: 11 },
    { principal: 888, repayment: 1110, roundsLeft: 10 }
  ]);
  assert.equal(result.data.loan.roundsLeft, 10);
});

test("active rounds and game-over state block loan issuance", async () => {
  const running = makeLoanHarness(state(), { activeRound: { id: "round" } });
  await assert.rejects(
    () => takeLoan(running, 444),
    (error) => error?.status === 409 && error?.code === "round_in_progress"
  );

  const over = makeLoanHarness(state({ gameOver: true }));
  await assert.rejects(
    () => takeLoan(over, 444),
    (error) => error?.status === 409 && error?.code === "game_over"
  );
});

test("unknown loan amounts and loans above zero balance are rejected", async () => {
  const harness = makeLoanHarness(state({ balance: 1 }));
  await assert.rejects(
    () => takeLoan(harness, 123),
    (error) => error?.status === 400 && error?.code === "invalid_loan"
  );

  await assert.rejects(
    () => takeLoan(harness, 444),
    (error) => error?.status === 409 && error?.code === "loan_requires_zero_balance"
  );
  assert.equal(harness.getState().balance, 1);
  assert.equal(harness.getState().activeLoans.length, 0);
});
