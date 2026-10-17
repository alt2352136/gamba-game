import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyFairnessHistory } from "../../fairness-client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "tools/fairness-test-vectors.json"), "utf8"));

function apiResponse(crashPoint = vector.crashPoint) {
  return {
    totalRounds: 1,
    totalSeeds: 1,
    houseEdgePercent: vector.edgePercent,
    seeds: [{ epoch: 1, commitment: vector.commitment, revealed_seed: vector.serverSeed }],
    rounds: [{ id: "known-round", epoch: 1, client_seed: vector.clientSeed,
      nonce: vector.nonce, edge_percent: vector.edgePercent, status: "busted", crash_point: crashPoint }]
  };
}

test("browser fairness verifier independently checks a valid supplied history", async () => {
  const report = await verifyFairnessHistory(async () => apiResponse());
  assert.equal(report.verifiedSeeds, 1);
  assert.equal(report.verifiedRounds, 1);
  assert.equal(report.failures.length, 0);
});

test("browser fairness verifier reports a mismatching crash point", async () => {
  const report = await verifyFairnessHistory(async () => apiResponse(1.4));
  assert.equal(report.verifiedSeeds, 1);
  assert.equal(report.verifiedRounds, 0);
  assert.match(report.failures.join(" "), /crash point mismatch/);
});
