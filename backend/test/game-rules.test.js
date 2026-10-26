import assert from "node:assert/strict";
import test from "node:test";
import { calculatePayout, readRequestedMultiplierCents, resolveCashoutMultiplierCents } from "../src/game-rules.js";

test("cash-out uses the lower of the server multiplier and the client display cap", () => {
  assert.equal(resolveCashoutMultiplierCents(2.349, 200), 200);
  assert.equal(resolveCashoutMultiplierCents(2.349, 900), 234);
  assert.equal(resolveCashoutMultiplierCents(10), 1000);
});

test("cash-out input accepts omitted legacy values and rejects invalid cents", () => {
  assert.equal(readRequestedMultiplierCents({}), undefined);
  assert.equal(readRequestedMultiplierCents({ requestedMultiplierCents: 125 }), 125);
  for (const value of [0, 99, 1001, 100.5, "200", null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => readRequestedMultiplierCents({ requestedMultiplierCents: value }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_cashout_multiplier");
      return true;
    });
  }
});


test("payouts use whole multiplier cents without floating-point loss", () => {
  assert.equal(calculatePayout(100, 113), 113);
  assert.equal(calculatePayout(75, 113), 84);
  assert.equal(calculatePayout(100, 1000), 1000);
});
