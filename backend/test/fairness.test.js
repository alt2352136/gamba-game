import test from "node:test";
import assert from "node:assert/strict";
import { crashPointFromDigest } from "../src/fairness.js";

test("crash formula clamps outcomes below x1.00", () => {
  assert.equal(crashPointFromDigest(new Uint8Array(32), 1), 1);
});

test("crash formula is deterministic and bounded", () => {
  const digest = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
  const first = crashPointFromDigest(digest, 1);
  const second = crashPointFromDigest(digest, 1);
  assert.equal(first, second);
  assert.ok(first >= 1);
  assert.ok(Number.isFinite(first));
});

test("a digest near the upper end produces a high crash point", () => {
  const digest = new Uint8Array(32).fill(255);
  const point = crashPointFromDigest(digest, 1);
  assert.ok(point > 10);
  assert.ok(point <= 1_000_000);
});

test("configured edge is reflected in the deterministic formula", () => {
  const digest = Uint8Array.from({ length: 32 }, (_, i) => (i * 19 + 3) & 255);
  assert.ok(crashPointFromDigest(digest, 1) >= crashPointFromDigest(digest, 3));
});
