#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_CRASH_CENTS = 100_000_000;

function isHexSeed(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{2}){32}$/i.test(value);
}

function crashPointFromDigest(digestHex, edgePercent) {
  // This intentionally uses Node's crypto and a separately written formula instead
  // of importing the Worker implementation, making it a useful independent check.
  const first52Bits = BigInt(`0x${digestHex.slice(0, 13)}`);
  const range = 1n << 52n;
  const returnToPlayerPercent = BigInt(Math.round(100 - edgePercent));
  let cents = (returnToPlayerPercent * range) / (range - first52Bits);
  if (cents < 100n) cents = 100n;
  if (cents > BigInt(MAX_CRASH_CENTS)) cents = BigInt(MAX_CRASH_CENTS);
  return Number(cents) / 100;
}

export function calculateRoundOutcome(serverSeedHex, round, edgePercent = 1) {
  if (!isHexSeed(serverSeedHex)) throw new Error("Server seed must be exactly 32 bytes encoded as hexadecimal.");
  if (typeof round?.client_seed !== "string" || !Number.isSafeInteger(Number(round.nonce)) || Number(round.nonce) < 1) {
    throw new Error("Round must contain a client_seed and a positive integer nonce.");
  }
  if (!Number.isInteger(edgePercent) || edgePercent < 0 || edgePercent > 10) {
    throw new Error("House edge must be an integer between 0 and 10 percent.");
  }
  const digest = createHmac("sha256", Buffer.from(serverSeedHex, "hex"))
    .update(`${round.client_seed}:${Number(round.nonce)}`, "utf8")
    .digest("hex");
  return { digest, crashPoint: crashPointFromDigest(digest, edgePercent) };
}

export function verifyFairnessData(data) {
  const failures = [];
  if (!data || !Array.isArray(data.seeds) || !Array.isArray(data.rounds)) {
    return {
      passed: false,
      complete: false,
      verifiedSeeds: 0,
      verifiedRounds: 0,
      pendingSeeds: 0,
      pendingRounds: 0,
      failures: ["Input must be a JSON object with seeds and rounds arrays."]
    };
  }

  const seedsByEpoch = new Map();
  let verifiedSeeds = 0;
  let pendingSeeds = 0;
  let verifiedRounds = 0;
  let pendingRounds = 0;

  for (const seed of data.seeds) {
    const epoch = Number(seed?.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1 || seedsByEpoch.has(epoch)) {
      failures.push(`Invalid or duplicate seed epoch: ${String(seed?.epoch)}`);
      continue;
    }
    seedsByEpoch.set(epoch, seed);
    if (typeof seed.revealed_seed !== "string") {
      pendingSeeds += 1;
      continue;
    }
    if (!isHexSeed(seed.revealed_seed)) {
      failures.push(`Seed epoch ${epoch}: invalid revealed seed format.`);
      continue;
    }
    const actualCommitment = createHash("sha256").update(seed.revealed_seed, "utf8").digest("hex");
    if (actualCommitment !== String(seed.commitment || "").toLowerCase()) {
      failures.push(`Seed epoch ${epoch}: commitment mismatch.`);
      continue;
    }
    verifiedSeeds += 1;
  }

  for (const round of data.rounds) {
    const roundLabel = typeof round?.id === "string" ? round.id : "(missing round ID)";
    const epoch = Number(round?.epoch);
    const seed = seedsByEpoch.get(epoch);
    if (!seed) {
      failures.push(`Round ${roundLabel}: no seed record for epoch ${String(round?.epoch)}.`);
      continue;
    }
    if (typeof seed.revealed_seed !== "string") {
      pendingRounds += 1;
      continue;
    }
    if (!isHexSeed(seed.revealed_seed)) continue; // The seed-format failure was already reported.
    const commitment = createHash("sha256").update(seed.revealed_seed, "utf8").digest("hex");
    if (commitment !== String(seed.commitment || "").toLowerCase()) continue;

    if (round.status === "running" || round.crash_point === null || round.crash_point === undefined) {
      pendingRounds += 1;
      continue;
    }
    const edge = Number(round.edge_percent ?? data.houseEdgePercent ?? 1);
    let calculated;
    try {
      calculated = calculateRoundOutcome(seed.revealed_seed, round, edge).crashPoint;
    } catch (error) {
      failures.push(`Round ${roundLabel}: ${error.message}`);
      continue;
    }
    const recorded = Number(round.crash_point);
    if (!Number.isFinite(recorded) || Math.abs(calculated - recorded) > 1e-9) {
      failures.push(`Round ${roundLabel}: crash point mismatch (recorded ${String(round.crash_point)}, calculated ${calculated.toFixed(2)}).`);
      continue;
    }
    verifiedRounds += 1;
  }

  return {
    passed: failures.length === 0,
    complete: failures.length === 0 && pendingSeeds === 0 && pendingRounds === 0,
    verifiedSeeds,
    verifiedRounds,
    pendingSeeds,
    pendingRounds,
    failures
  };
}

async function main(args) {
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("Usage: node tools/verify-fairness.js <fairness-export.json>\n\nInput JSON must contain the combined seeds and rounds arrays returned by /api/fairness. See docs/fairness-verification.md.\n");
    process.exitCode = args.length === 1 ? 0 : 1;
    return;
  }
  let data;
  try {
    data = JSON.parse(await readFile(args[0], "utf8"));
  } catch (error) {
    console.error(`Could not read valid JSON from ${args[0]}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const report = verifyFairnessData(data);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
