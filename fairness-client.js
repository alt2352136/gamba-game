// Browser-side verifier for the public fairness history. UI updates stay in game.js.
function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) {
    throw new Error("Invalid hexadecimal server seed.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256HexUtf8(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyFairnessHistory(api, onProgress = () => {}) {
  const pageSize = 100;
  const first = await api(`/api/fairness?limit=${pageSize}&roundOffset=0&seedOffset=0`);
  const totalRounds = Number(first.totalRounds ?? first.rounds?.length ?? 0);
  const totalSeeds = Number(first.totalSeeds ?? first.seeds?.length ?? 0);
  const rounds = [...(first.rounds || [])];
  const seeds = [...(first.seeds || [])];
  const totalPages = Math.max(totalRounds, totalSeeds);

  for (let offset = pageSize; offset < totalPages; offset += pageSize) {
    onProgress(`Loading records… ${Math.min(offset, totalPages).toLocaleString("en-US")} of ${totalPages.toLocaleString("en-US")}`);
    const roundOffset = Math.min(offset, totalRounds);
    const seedOffset = Math.min(offset, totalSeeds);
    const page = await api(`/api/fairness?limit=${pageSize}&roundOffset=${roundOffset}&seedOffset=${seedOffset}`);
    rounds.push(...(page.rounds || []));
    seeds.push(...(page.seeds || []));
  }
  if (rounds.length !== totalRounds || seeds.length !== totalSeeds) {
    throw new Error(`History pagination incomplete (loaded ${rounds.length}/${totalRounds} rounds and ${seeds.length}/${totalSeeds} seeds). Try again.`);
  }

  const seedsByEpoch = new Map(seeds.map((row) => [Number(row.epoch), row]));
  let verifiedSeeds = 0;
  let verifiedRounds = 0;
  let pendingRounds = 0;
  const failures = [];
  const invalidSeedEpochs = new Set();

  for (const seedRow of seeds) {
    if (typeof seedRow.revealed_seed !== "string") continue;
    if (!/^(?:[0-9a-f]{2}){32}$/i.test(seedRow.revealed_seed)) {
      failures.push(`Seed batch ${seedRow.epoch}: invalid revealed seed format`);
      invalidSeedEpochs.add(Number(seedRow.epoch));
      continue;
    }
    const expectedCommitment = await sha256HexUtf8(seedRow.revealed_seed);
    if (expectedCommitment !== seedRow.commitment) {
      failures.push(`Seed batch ${seedRow.epoch}: commitment mismatch`);
      invalidSeedEpochs.add(Number(seedRow.epoch));
      continue;
    }
    verifiedSeeds += 1;
  }

  for (const round of rounds) {
    const epoch = Number(round.epoch);
    const seedRow = seedsByEpoch.get(epoch);
    if (!seedRow) {
      failures.push(`Round ${round.id}: no seed commitment record for batch ${round.epoch}`);
      continue;
    }
    if (typeof seedRow.revealed_seed !== "string") {
      pendingRounds += 1;
      continue;
    }
    if (invalidSeedEpochs.has(epoch)) continue;
    if (round.crash_point === null || round.crash_point === undefined || round.status === "running") {
      failures.push(`Round ${round.id}: revealed batch has an unsettled round`);
      continue;
    }
    const serverKey = await crypto.subtle.importKey("raw", hexToBytes(seedRow.revealed_seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", serverKey, new TextEncoder().encode(`${round.client_seed}:${round.nonce}`)));
    const first13 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 13);
    const random52 = BigInt(`0x${first13}`);
    const denominator = 1n << 52n;
    const edge = Number(round.edge_percent ?? first.houseEdgePercent ?? 1);
    const rtp = BigInt(Math.round(100 - edge));
    let cents = (rtp * denominator) / (denominator - random52);
    if (cents < 100n) cents = 100n;
    if (cents > 100_000_000n) cents = 100_000_000n;
    const calculated = Number(cents) / 100;
    if (Math.abs(calculated - Number(round.crash_point)) > 1e-9) failures.push(`Round ${round.id}: crash point mismatch`);
    else verifiedRounds += 1;
  }

  return { verifiedSeeds, verifiedRounds, pendingRounds, totalRounds, totalSeeds, failures };
}
