import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { calculateRoundOutcome, verifyFairnessData } from "../../tools/verify-fairness.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "tools/fairness-test-vectors.json"), "utf8"));

function validExport() {
  return {
    houseEdgePercent: vector.edgePercent,
    seeds: [{ epoch: 1, commitment: vector.commitment, revealed_seed: vector.serverSeed }],
    rounds: [{ id: "known-round", epoch: 1, client_seed: vector.clientSeed, nonce: vector.nonce,
      edge_percent: vector.edgePercent, status: "busted", crash_point: vector.crashPoint }]
  };
}

test("fixed fairness vector reproduces the published digest and crash point", () => {
  const actual = calculateRoundOutcome(vector.serverSeed, {
    client_seed: vector.clientSeed,
    nonce: vector.nonce
  }, vector.edgePercent);
  assert.equal(actual.digest, vector.hmacSha256);
  assert.equal(actual.crashPoint, vector.crashPoint);
});

test("standalone verifier accepts a correctly committed seed and recorded round", () => {
  const report = verifyFairnessData(validExport());
  assert.equal(report.passed, true);
  assert.equal(report.complete, true);
  assert.equal(report.verifiedSeeds, 1);
  assert.equal(report.verifiedRounds, 1);
  assert.deepEqual(report.failures, []);
});

test("standalone verifier catches a tampered crash point", () => {
  const data = validExport();
  data.rounds[0].crash_point = 1.4;
  const report = verifyFairnessData(data);
  assert.equal(report.passed, false);
  assert.match(report.failures[0], /crash point mismatch/);
});

test("unrevealed seeds are reported as pending, not falsely failed", () => {
  const data = validExport();
  data.seeds[0].revealed_seed = null;
  const report = verifyFairnessData(data);
  assert.equal(report.passed, true);
  assert.equal(report.complete, false);
  assert.equal(report.pendingSeeds, 1);
  assert.equal(report.pendingRounds, 1);
});

test("standalone verifier catches a seed commitment mismatch", () => {
  const data = validExport();
  data.seeds[0].commitment = "f".repeat(64);
  const report = verifyFairnessData(data);
  assert.equal(report.passed, false);
  assert.match(report.failures.join(" "), /commitment mismatch/);
});
