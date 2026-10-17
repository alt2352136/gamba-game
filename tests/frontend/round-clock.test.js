import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisibleMultiplier,
  estimateServerTime,
  nextServerTimeAnchor
} from "../../round-clock.js";

test("server time advances from a performance-clock anchor", () => {
  assert.equal(estimateServerTime(10_000, 500, 750, 999), 10_250);
});

test("server time falls back to the local clock before an anchor exists", () => {
  assert.equal(estimateServerTime(null, null, 750, 1_234), 1_234);
});

test("a late server response cannot move the estimated clock backwards", () => {
  assert.deepEqual(nextServerTimeAnchor(10_000, 500, 10_100, 700), {
    serverTimeAnchor: 10_200,
    performanceTimeAnchor: 700
  });
});

test("the first valid server timestamp initializes the anchor", () => {
  assert.deepEqual(nextServerTimeAnchor(null, null, "12345", 700), {
    serverTimeAnchor: 12_345,
    performanceTimeAnchor: 700
  });
});

test("invalid server timestamps are ignored", () => {
  assert.equal(nextServerTimeAnchor(10_000, 500, "not-a-time", 700), null);
});

test("visible multiplier begins at x1, grows with elapsed time, and respects the cap", () => {
  assert.equal(calculateVisibleMultiplier(900, 1_000, 0.8, 10), 1);
  assert.equal(calculateVisibleMultiplier(2_000, 1_000, 0.8, 10), 1.8);
  assert.equal(calculateVisibleMultiplier(20_000, 1_000, 0.8, 10), 10);
});
