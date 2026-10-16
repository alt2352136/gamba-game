import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CLI = path.join(BACKEND_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const ALLOWED_ORIGIN = "http://localhost:5500";
const SECOND_ALLOWED_ORIGIN = "https://candidate.github.io";
const COMPATIBILITY_DATE = "2026-10-12";
const STARTING_GOLD = 888;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    // Stop Wrangler and any local workerd child it spawned, not just its parent.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await Promise.race([once(killer, "exit").catch(() => {}), pause(2500)]);
  } else {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit").catch(() => {}), pause(2500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function crashPointFromDigest(digest, edgePercent = 1) {
  const first13Hex = digest.toString("hex").slice(0, 13);
  const random52 = BigInt(`0x${first13Hex}`);
  const denominator = 1n << 52n;
  const rtpPercent = BigInt(Math.round(100 - edgePercent));
  let cents = (rtpPercent * denominator) / (denominator - random52);
  if (cents < 100n) cents = 100n;
  if (cents > 100_000_000n) cents = 100_000_000n;
  return Number(cents) / 100;
}

function locallyVerifyRound(serverSeedHex, round, edgePercent = 1) {
  const digest = createHmac("sha256", Buffer.from(serverSeedHex, "hex"))
    .update(`${round.client_seed}:${round.nonce}`, "utf8")
    .digest();
  return crashPointFromDigest(digest, edgePercent);
}

async function waitForHealth(baseUrl, child, getLogs, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "No response yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before the Worker became healthy.\n${getLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.service === "gamba-crash-backend") return;
        lastError = `Unexpected health response: ${JSON.stringify(body)}`;
      } else {
        lastError = `Health endpoint returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await pause(250);
  }
  throw new Error(`Timed out waiting for the local Worker. Last error: ${lastError}\n${getLogs()}`);
}

async function api(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin) headers.set("origin", options.origin);
  let body = options.rawBody;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* retained as raw text */ }
  return { status: response.status, data, text, headers: response.headers };
}

function idempotencyKey() {
  return randomUUID().replace(/-/g, "");
}

// This suite launches a fresh, local Wrangler Worker with test-only secrets and
// temporary SQLite Durable Object storage. It never calls or mutates production.
test("gamba backend local integration and regression suite", { timeout: 120_000 }, async (t) => {
  assert.ok(await readFile(WRANGLER_CLI).then(() => true).catch(() => false),
    `Wrangler CLI not found at ${WRANGLER_CLI}. Run npm install in the backend folder first.`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gamba-backend-tests-"));
  const tempSrc = path.join(tempRoot, "src");
  await mkdir(tempSrc, { recursive: true });
  await copyFile(path.join(BACKEND_DIR, "src", "index.js"), path.join(tempSrc, "index.js"));

  const testSessionSecret = randomBytes(32).toString("hex");
  const testSeedKey = randomBytes(32).toString("base64");
  const testConfig = `name = "gamba-test-worker"\nmain = "src/index.js"\ncompatibility_date = "${COMPATIBILITY_DATE}"\n\n[[durable_objects.bindings]]\nname = "GAME_SESSIONS"\nclass_name = "GameSession"\n\n[exports.GameSession]\ntype = "durable-object"\nstorage = "sqlite"\n\n[vars]\nALLOWED_ORIGINS = "${ALLOWED_ORIGIN},${SECOND_ALLOWED_ORIGIN}"\nHOUSE_EDGE_PERCENT = "1"\n`;
  await writeFile(path.join(tempRoot, "wrangler.toml"), testConfig, "utf8");
  await writeFile(
    path.join(tempRoot, ".dev.vars"),
    `SESSION_SECRET="${testSessionSecret}"\nSEED_ENCRYPTION_KEY="${testSeedKey}"\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(process.execPath, [
    WRANGLER_CLI, "dev", "--config", path.join(tempRoot, "wrangler.toml"),
    "--port", String(port), "--ip", "127.0.0.1", "--log-level", "error"
  ], {
    cwd: BACKEND_DIR,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.on("error", (error) => { logs = (logs + `\n[wrangler spawn error] ${error.message}`).slice(-12_000); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-12_000); });
  child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-12_000); });

  try {
    await waitForHealth(baseUrl, child, () => logs);

    await t.test("health, CORS, and token authentication", async () => {
      const health = await api(baseUrl, "/health", { origin: ALLOWED_ORIGIN });
      assert.equal(health.status, 200);
      assert.equal(health.data.ok, true);
      assert.equal(health.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
      assert.equal(health.headers.get("x-content-type-options"), "nosniff");
      assert.equal(health.headers.get("x-frame-options"), "DENY");
      assert.equal(health.headers.get("cache-control"), "no-store");

      const pagesHealth = await api(baseUrl, "/health", { origin: SECOND_ALLOWED_ORIGIN });
      assert.equal(pagesHealth.status, 200);
      assert.equal(pagesHealth.headers.get("access-control-allow-origin"), SECOND_ALLOWED_ORIGIN);

      const rejectedOrigin = await api(baseUrl, "/health", { origin: "https://not-our-site.example" });
      assert.equal(rejectedOrigin.status, 403);
      assert.equal(rejectedOrigin.data.error, "origin_not_allowed");

      const noAuth = await api(baseUrl, "/api/state");
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.data.error, "unauthorized");

      const noAuthReleaseIntent = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", body: { startKey: idempotencyKey() }
      });
      assert.equal(noAuthReleaseIntent.status, 401);
      assert.equal(noAuthReleaseIntent.data.error, "unauthorized");
    });

    const created = await api(baseUrl, "/api/session", { method: "POST", body: {} });
    assert.equal(created.status, 201, `Session creation failed: ${created.text}`);
    const session = created.data;
    assert.equal(session.state.balance, STARTING_GOLD);
    assert.equal(session.state.roundNumber, 0);
    assert.equal(session.epoch, 1);
    assert.match(session.commitment, /^[0-9a-f]{64}$/);
    assert.equal(session.clientSeedRequired, true);
    assert.equal(session.profile?.stats?.roundsPlayed, 0);
    assert.deepEqual(session.profile?.leaderboard, []);
    assert.ok(session.token);
    const auth = session.token;

    await t.test("session initializes with separate, authenticated state", async () => {
      const state = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(state.status, 200);
      assert.equal(state.data.state.balance, STARTING_GOLD);
      assert.equal(state.data.state.activeRound, null);

      const tamperedToken = await api(baseUrl, "/api/state", { token: `${auth}x` });
      assert.equal(tamperedToken.status, 401);

      const noSeedStart = await api(baseUrl, "/api/round/start", {
        method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { stake: 1 }
      });
      assert.equal(noSeedStart.status, 409);
      assert.equal(noSeedStart.data.error, "client_seed_required");
    });

    const clientSeed = randomBytes(16).toString("hex");
    const seedSet = await api(baseUrl, "/api/client-seed", { method: "POST", token: auth, body: { clientSeed } });
    assert.equal(seedSet.status, 200, seedSet.text);
    assert.equal(seedSet.data.clientSeed, clientSeed);
    assert.equal(seedSet.data.commitment, session.commitment);

    await t.test("rejects invalid client seeds and malformed/oversized requests", async () => {
      const invalidSeed = await api(baseUrl, "/api/client-seed", { method: "POST", token: auth, body: { clientSeed: "has spaces" } });
      assert.equal(invalidSeed.status, 400);
      assert.equal(invalidSeed.data.error, "invalid_client_seed");

      const invalidReleaseKey = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", token: auth, headers: { "idempotency-key": "bad" }, body: { startKey: idempotencyKey() }
      });
      assert.equal(invalidReleaseKey.status, 400);
      assert.equal(invalidReleaseKey.data.error, "idempotency_key_required");

      const invalidStartKey = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { startKey: "bad" }
      });
      assert.equal(invalidStartKey.status, 400);
      assert.equal(invalidStartKey.data.error, "start_key_required");

      const malformed = await api(baseUrl, "/api/session", { method: "POST", rawBody: "{not-json" });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.data.error, "invalid_json");

      const tooLarge = await api(baseUrl, "/api/session", {
        method: "POST", rawBody: JSON.stringify({ padding: "x".repeat(9000) })
      });
      assert.equal(tooLarge.status, 413);
      assert.equal(tooLarge.data.error, "request_too_large");
    });

    await t.test("rejects invalid stakes and loans without mutating the wallet", async () => {
      for (const stake of [0, -1, 1.5, 888.5, Math.floor(Number.MAX_SAFE_INTEGER / 10) + 1]) {
        const response = await api(baseUrl, "/api/round/start", {
          method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { stake }
        });
        assert.equal(response.status, 400, `Stake ${stake} should be rejected: ${response.text}`);
        assert.equal(response.data.error, "invalid_stake");
      }

      for (const principal of [123, 444.5]) {
        const response = await api(baseUrl, "/api/loan", {
          method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { principal }
        });
        assert.equal(response.status, 400);
        assert.equal(response.data.error, "invalid_loan");
      }
      const loanTooEarly = await api(baseUrl, "/api/loan", {
        method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { principal: 444 }
      });
      assert.equal(loanTooEarly.status, 409);
      assert.equal(loanTooEarly.data.error, "loan_requires_zero_balance");

      const state = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(state.data.state.balance, STARTING_GOLD);
      assert.equal(state.data.state.roundNumber, 0);
      assert.equal(state.data.state.activeRound, null);
      assert.equal(state.data.state.activeLoans.length, 0);
    });

    const startKey = idempotencyKey();
    const firstStart = await api(baseUrl, "/api/round/start", {
      method: "POST", token: auth, headers: { "idempotency-key": startKey }, body: { stake: 1 }
    });
    assert.equal(firstStart.status, 200, firstStart.text);
    assert.equal(firstStart.data.state.balance, STARTING_GOLD - 1);
    assert.ok(Number.isFinite(firstStart.data.serverTime), "Start response must include a server-clock sample.");
    assert.equal(Object.hasOwn(firstStart.data, "crashPoint"), false, "Crash point must not be sent while round is running.");
    const firstRoundId = firstStart.data.round.id;

    await t.test("start response hides the crash point and duplicate starts replay without creating rounds", async () => {
      assert.equal(Object.hasOwn(firstStart.data, "crashPoint"), false);
      const roundsBeforeReplay = await api(baseUrl, "/api/fairness?limit=10", { token: auth });
      assert.equal(roundsBeforeReplay.status, 200);

      const replayStart = await api(baseUrl, "/api/round/start", {
        method: "POST", token: auth, headers: { "idempotency-key": startKey }, body: { stake: 1 }
      });
      assert.equal(replayStart.status, 200, replayStart.text);
      assert.equal(replayStart.data.round.id, firstRoundId);
      assert.ok(Number.isFinite(replayStart.data.serverTime), "Idempotent replay should get a fresh server-clock sample.");
      const roundsAfterReplay = await api(baseUrl, "/api/fairness?limit=10", { token: auth });
      assert.equal(roundsAfterReplay.status, 200);
      assert.equal(roundsAfterReplay.data.totalRounds, roundsBeforeReplay.data.totalRounds,
        "Replaying a start request must not create another round.");

      const wrongActionReuse = await api(baseUrl, "/api/round/cashout", {
        method: "POST", token: auth, headers: { "idempotency-key": startKey }, body: { roundId: firstRoundId }
      });
      assert.equal(wrongActionReuse.status, 409);
      assert.equal(wrongActionReuse.data.error, "idempotency_key_reused");
    });

    const cashKey = idempotencyKey();
    let firstCashout = await api(baseUrl, "/api/round/cashout", {
      method: "POST", token: auth, headers: { "idempotency-key": cashKey }, body: { roundId: firstRoundId }
    });
    const cashOutRequestWasAccepted = firstCashout.status === 200;
    if (firstCashout.status === 409 && firstCashout.data?.error === "round_not_running") {
      // A very low crash may have been settled by its alarm before this request arrived.
      firstCashout = await api(baseUrl, `/api/round/status?id=${encodeURIComponent(firstRoundId)}`, { token: auth });
    }
    assert.equal(firstCashout.status, 200, firstCashout.text);
    assert.ok(["cashed_out", "busted"].includes(firstCashout.data.result));

    await t.test("settles a round once and handles duplicate cash-out safely", async () => {
      const initialCashBalance = firstCashout.data.state.balance;
      assert.equal(initialCashBalance, STARTING_GOLD - 1 + firstCashout.data.payout);

      const replayCashout = await api(baseUrl, "/api/round/cashout", {
        method: "POST", token: auth, headers: { "idempotency-key": cashKey }, body: { roundId: firstRoundId }
      });
      if (cashOutRequestWasAccepted) {
        assert.equal(replayCashout.status, 200, replayCashout.text);
        assert.equal(replayCashout.data.result, firstCashout.data.result);
        assert.equal(replayCashout.data.payout, firstCashout.data.payout);
      } else {
        // The alarm already settled the round before the cash-out request reached the server,
        // so that request was correctly rejected and has no idempotency cache entry.
        assert.equal(replayCashout.status, 409, replayCashout.text);
        assert.equal(replayCashout.data.error, "round_not_running");
      }

      const currentState = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(currentState.data.state.balance, initialCashBalance);
      assert.equal(currentState.data.state.roundNumber, 1);
      assert.equal(currentState.data.state.activeRound, null);
      assert.equal(currentState.data.profile.stats.roundsPlayed, 1);
      assert.equal(currentState.data.profile.stats.totalStaked, 1);
      assert.equal(currentState.data.profile.stats.totalPayout, firstCashout.data.payout);
      assert.ok(Array.isArray(currentState.data.profile.leaderboard));
      assert.ok(currentState.data.profile.leaderboard.length <= 5);
    });

    await t.test("serializes simultaneous round starts so only one stake is deducted", async () => {
      const before = await api(baseUrl, "/api/state", { token: auth });
      const fairnessBefore = await api(baseUrl, "/api/fairness?limit=100", { token: auth });
      const keyA = idempotencyKey();
      const keyB = idempotencyKey();
      const [a, b] = await Promise.all([
        api(baseUrl, "/api/round/start", { method: "POST", token: auth, headers: { "idempotency-key": keyA }, body: { stake: 2 } }),
        api(baseUrl, "/api/round/start", { method: "POST", token: auth, headers: { "idempotency-key": keyB }, body: { stake: 3 } })
      ]);
      const successes = [a, b].filter((result) => result.status === 200);
      const conflicts = [a, b].filter((result) => result.status === 409);
      assert.equal(successes.length, 1, `Expected one successful start, got ${a.status} and ${b.status}: ${a.text}; ${b.text}`);
      assert.equal(conflicts.length, 1, `Expected one conflict, got ${a.status} and ${b.status}: ${a.text}; ${b.text}`);
      const winner = successes[0].data;
      assert.equal(winner.state.balance, before.data.state.balance - winner.round.stake,
        "The winning start response must show one stake deduction.");
      const fairnessAfter = await api(baseUrl, "/api/fairness?limit=100", { token: auth });
      assert.equal(fairnessAfter.data.totalRounds, fairnessBefore.data.totalRounds + 1,
        "Concurrent starts must create exactly one round record.");

      let settle = await api(baseUrl, "/api/round/cashout", {
        method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: { roundId: winner.round.id }
      });
      if (settle.status === 409 && settle.data?.error === "round_not_running") {
        settle = await api(baseUrl, `/api/round/status?id=${encodeURIComponent(winner.round.id)}`, { token: auth });
      }
      assert.equal(settle.status, 200, settle.text);
      assert.ok(["cashed_out", "busted"].includes(settle.data.result));
      const settledState = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(settledState.data.state.activeRound, null);
      assert.equal(settledState.data.profile.stats.roundsPlayed, 2);
      assert.equal(settledState.data.profile.stats.totalStaked, 1 + winner.round.stake);
      assert.ok(settledState.data.profile.leaderboard.length <= 5);
      for (let i = 1; i < settledState.data.profile.leaderboard.length; i += 1) {
        const previous = settledState.data.profile.leaderboard[i - 1];
        const current = settledState.data.profile.leaderboard[i];
        assert.ok(previous.payout > current.payout ||
          (previous.payout === current.payout && previous.multiplier >= current.multiplier),
          "Personal-best payouts must stay ordered by payout then multiplier.");
      }
    });

    const reset = await api(baseUrl, "/api/game/reset", {
      method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: {}
    });
    assert.equal(reset.status, 200, reset.text);

    await t.test("revealed seed matches its original commitment and recomputes stored crash points", async () => {
      assert.equal(reset.data.revealed.epoch, 1);
      assert.equal(reset.data.epoch, 2);
      assert.equal(reset.data.state.balance, STARTING_GOLD);
      assert.equal(reset.data.state.roundNumber, 0);
      const revealedSeed = reset.data.revealed.serverSeed;
      assert.match(revealedSeed, /^[0-9a-f]{64}$/);
      const calculatedCommitment = createHash("sha256").update(revealedSeed, "utf8").digest("hex");
      assert.equal(calculatedCommitment, reset.data.revealed.commitment);

      const fairness = await api(baseUrl, "/api/fairness?limit=100", { token: auth });
      assert.equal(fairness.status, 200);
      assert.equal(fairness.data.currentEpoch, 2);
      const oldSeedRecord = fairness.data.seeds.find((seed) => seed.epoch === 1);
      assert.ok(oldSeedRecord);
      assert.equal(oldSeedRecord.revealed_seed, revealedSeed);
      assert.equal(oldSeedRecord.commitment, calculatedCommitment);

      const oldRounds = fairness.data.rounds.filter((round) => round.epoch === 1);
      assert.ok(oldRounds.length >= 2, "Expected both test rounds to remain in the round history.");

      const pageOne = await api(baseUrl, "/api/fairness?limit=1&roundOffset=0&seedOffset=0", { token: auth });
      const pageTwo = await api(baseUrl, "/api/fairness?limit=1&roundOffset=1&seedOffset=1", { token: auth });
      assert.equal(pageOne.status, 200);
      assert.equal(pageTwo.status, 200);
      assert.equal(pageOne.data.totalRounds, fairness.data.totalRounds);
      assert.equal(pageOne.data.rounds.length, 1);
      assert.equal(pageTwo.data.rounds.length, 1);
      assert.notEqual(pageOne.data.rounds[0].id, pageTwo.data.rounds[0].id,
        "roundOffset must return the next page rather than repeat page one");
      assert.equal(pageTwo.data.seeds[0].epoch, 2,
        "seedOffset must return the second seed epoch when requested");

      const refreshedAfterReset = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(refreshedAfterReset.data.profile.stats.roundsPlayed, 2,
        "Session statistics must persist across game resets");
      for (const round of oldRounds) {
        assert.ok(["cashed_out", "busted"].includes(round.status), `Round ${round.id} was not settled.`);
        assert.equal(typeof round.crash_point, "number");
        assert.equal(locallyVerifyRound(revealedSeed, round, 1), round.crash_point,
          `Crash point mismatch for round ${round.id}, nonce ${round.nonce}`);
      }
    });

    await t.test("new epoch is isolated and has no inherited active round or loans", async () => {
      const state = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(state.data.state.balance, STARTING_GOLD);
      assert.equal(state.data.state.roundNumber, 0);
      assert.equal(state.data.state.clientSeed, null);
      assert.equal(state.data.state.activeRound, null);
      assert.equal(state.data.state.activeLoans.length, 0);
      assert.equal(state.data.epoch, 2);
    });

    await t.test("a second session is independent", async () => {
      const second = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(second.status, 201, second.text);
      assert.notEqual(second.data.sessionId, session.sessionId);
      assert.notEqual(second.data.commitment, session.commitment);
      const secondState = await api(baseUrl, "/api/state", { token: second.data.token });
      assert.equal(secondState.status, 200);
      assert.equal(secondState.data.state.balance, STARTING_GOLD);
      assert.equal(secondState.data.state.roundNumber, 0);
      assert.equal(secondState.data.epoch, 1);

      const firstState = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(firstState.data.state.balance, STARTING_GOLD);
      assert.equal(firstState.data.epoch, 2);
    });

    await t.test("keeps only the five highest personal payouts and preserves profile across resets", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const freshToken = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token: freshToken, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      const stakes = Array.from({ length: 15 }, (_, index) => index + 1);
      for (const stake of stakes) {
        const started = await api(baseUrl, "/api/round/start", {
          method: "POST", token: freshToken,
          headers: { "idempotency-key": idempotencyKey() }, body: { stake }
        });
        assert.equal(started.status, 200, started.text);

        const cashed = await api(baseUrl, "/api/round/cashout", {
          method: "POST", token: freshToken,
          headers: { "idempotency-key": idempotencyKey() }, body: { roundId: started.data.round.id }
        });
        let result;
        if (cashed.status === 200) {
          result = cashed.data;
        } else {
          assert.equal(cashed.status, 409, `Unexpected cash-out failure: ${cashed.text}`);
          // An x1.00 crash can settle before the cash-out request reaches the Durable Object.
          result = await api(baseUrl, `/api/round/status?id=${encodeURIComponent(started.data.round.id)}`, { token: freshToken });
          assert.equal(result.status, 200, result.text);
          result = result.data;
        }
        assert.ok(["cashed_out", "busted"].includes(result.result || result.status),
          `Round must be settled before starting the next one: ${JSON.stringify(result)}`);
      }

      const finalState = await api(baseUrl, "/api/state", { token: freshToken });
      assert.equal(finalState.status, 200, finalState.text);
      assert.equal(finalState.data.profile.stats.roundsPlayed, stakes.length);
      assert.equal(finalState.data.profile.stats.totalStaked, stakes.reduce((sum, value) => sum + value, 0));
      assert.equal(finalState.data.profile.leaderboard.length, 5,
        "A session with at least five positive cash-outs should retain exactly five personal bests.");
      const entries = finalState.data.profile.leaderboard;
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        assert.ok(previous.payout > current.payout ||
          (previous.payout === current.payout && previous.multiplier >= current.multiplier),
          "Personal bests must be ordered by payout then multiplier.");
      }

      const resetProfile = await api(baseUrl, "/api/game/reset", {
        method: "POST", token: freshToken,
        headers: { "idempotency-key": idempotencyKey() }, body: {}
      });
      assert.equal(resetProfile.status, 200, resetProfile.text);
      assert.equal(resetProfile.data.profile.stats.roundsPlayed, stakes.length,
        "Lifetime session statistics must survive a new game epoch.");
      assert.deepEqual(resetProfile.data.profile.leaderboard, entries,
        "Personal bests should persist across game resets.");
    });

    await t.test("cash-out result never exceeds the multiplier sent by the visible release", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const token = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      let matchedCap = false;
      for (let attempt = 0; attempt < 12 && !matchedCap; attempt += 1) {
        const startKey = idempotencyKey();
        const started = await api(baseUrl, "/api/round/start", {
          method: "POST", token, headers: { "idempotency-key": startKey }, body: { stake: 1 }
        });
        assert.equal(started.status, 200, started.text);
        if (started.data.result) continue; // A fast x1.00 crash is legitimately settled at start.
        await new Promise(resolve => setTimeout(resolve, 100));
        const requestedMultiplierCents = 100;
        let cashout = await api(baseUrl, "/api/round/cashout", {
          method: "POST", token, headers: { "idempotency-key": idempotencyKey() },
          body: { roundId: started.data.round.id, requestedMultiplierCents }
        });
        if (cashout.status === 409 && cashout.data?.error === "round_not_running") {
          cashout = await api(baseUrl, `/api/round/status?id=${encodeURIComponent(started.data.round.id)}`, { token });
        }
        assert.equal(cashout.status, 200, cashout.text);
        assert.ok(Number.isFinite(cashout.data.timing?.serverSettledAt), "Settlement responses should include a server settlement timestamp.");
        assert.ok(cashout.data.timing?.settlementSource, "Settlement responses should identify what triggered settlement.");
        if (cashout.data.timing?.serverReceivedAt !== null && cashout.data.timing?.serverReceivedAt !== undefined) {
          assert.ok(Number.isFinite(cashout.data.timing.serverProcessingMs), "Request-triggered settlements should report server processing time.");
        }
        if (cashout.data.result === "cashed_out") {
          assert.equal(cashout.data.multiplier, 1,
            "A delayed successful request is capped at the multiplier displayed when release occurred.");
          matchedCap = true;
        } else {
          assert.equal(cashout.data.result, "busted", "Requests processed after crash must still lose.");
        }
      }
      assert.equal(matchedCap, true, "Expected at least one round to survive long enough to test the release cap.");
    });

    await t.test("early release queued before round commit settles atomically at the x1 boundary", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const token = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      const startKey = idempotencyKey();
      const releaseKey = idempotencyKey();
      const queued = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", token, headers: { "idempotency-key": releaseKey }, body: { startKey }
      });
      assert.equal(queued.status, 200, queued.text);
      assert.equal(queued.data.releaseMode, "queued");
      assert.ok(Number.isFinite(queued.data.timing?.serverReceivedAt));
      assert.ok(Number.isFinite(queued.data.timing?.serverProcessingMs));

      const started = await api(baseUrl, "/api/round/start", {
        method: "POST", token, headers: { "idempotency-key": startKey }, body: { stake: 1 }
      });
      assert.equal(started.status, 200, started.text);
      assert.ok(["cashed_out", "busted"].includes(started.data.result),
        `An early release must be settled in the start response: ${JSON.stringify(started.data)}`);
      assert.ok(Number.isFinite(started.data.timing?.serverReceivedAt));
      assert.ok(Number.isFinite(started.data.timing?.serverSettledAt));
      assert.equal(started.data.timing?.settlementSource, "early-release-at-start");
      assert.equal(started.data.roundId, started.data.round.id);
      assert.equal(started.data.state.roundNumber, 1);
      assert.equal(started.data.state.activeRound, null);
      assert.equal(started.data.payout, started.data.result === "cashed_out" ? 1 : 0);

      const replay = await api(baseUrl, "/api/round/start", {
        method: "POST", token, headers: { "idempotency-key": startKey }, body: { stake: 1 }
      });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.data.result, started.data.result);
      assert.equal(replay.data.state.balance, started.data.state.balance,
        "Replaying start must not settle or credit the round a second time.");
      const state = await api(baseUrl, "/api/state", { token });
      assert.equal(state.data.profile.stats.roundsPlayed, 1);
    });

    await t.test("release intent after round commit settles once and is idempotent", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const token = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      const startKey = idempotencyKey();
      const started = await api(baseUrl, "/api/round/start", {
        method: "POST", token, headers: { "idempotency-key": startKey }, body: { stake: 1 }
      });
      assert.equal(started.status, 200, started.text);
      const releaseKey = idempotencyKey();
      const release = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", token, headers: { "idempotency-key": releaseKey }, body: { startKey }
      });
      assert.equal(release.status, 200, release.text);
      assert.equal(release.data.releaseMode, "settled");
      assert.ok(["cashed_out", "busted"].includes(release.data.result || release.data.status));
      assert.ok(Number.isFinite(release.data.timing?.serverSettledAt));
      assert.equal(release.data.state.activeRound, null);
      assert.equal(release.data.state.roundNumber, 1);

      const replay = await api(baseUrl, "/api/round/release-intent", {
        method: "POST", token, headers: { "idempotency-key": releaseKey }, body: { startKey }
      });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.data.result, release.data.result);
      assert.equal(replay.data.state.balance, release.data.state.balance);
      const state = await api(baseUrl, "/api/state", { token });
      assert.equal(state.data.profile.stats.roundsPlayed, 1,
        "Duplicate early release requests must not double-settle the round.");
    });

    await t.test("public state returns only the ten history rows shown by the UI while fairness records remain available", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const token = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      for (let index = 0; index < 12; index += 1) {
        const started = await api(baseUrl, "/api/round/start", {
          method: "POST", token, headers: { "idempotency-key": idempotencyKey() }, body: { stake: 1 }
        });
        assert.equal(started.status, 200, started.text);
        if (started.data.result) continue; // The early x1 boundary can legitimately bust.
        const result = await api(baseUrl, "/api/round/cashout", {
          method: "POST", token, headers: { "idempotency-key": idempotencyKey() }, body: { roundId: started.data.round.id }
        });
        assert.equal(result.status, 200, result.text);
      }
      const state = await api(baseUrl, "/api/state", { token });
      assert.equal(state.status, 200, state.text);
      assert.equal(state.data.state.roundNumber, 12);
      assert.equal(state.data.state.history.length, 10);
      const fairness = await api(baseUrl, "/api/fairness?limit=20", { token });
      assert.equal(fairness.status, 200, fairness.text);
      assert.equal(fairness.data.totalRounds, 12, "Public-history trimming must not delete fairness records.");
    });

    await t.test("Durable Object alarm pushes settlement without any status poll", { timeout: 25_000 }, async () => {
      const isolated = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(isolated.status, 201, isolated.text);
      const isolatedToken = isolated.data.token;
      const setSeed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token: isolatedToken, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(setSeed.status, 200, setSeed.text);

      const socket = new WebSocket(`${baseUrl.replace(/^http:/, "ws:")}/api/round/events`,
        ["gamba-events-v1", `gamba-auth.${isolatedToken}`]);
      const messages = [];
      const waiters = [];
      socket.addEventListener("message", (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        messages.push(payload);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (!waiters[i].predicate(payload)) continue;
          clearTimeout(waiters[i].timer);
          waiters[i].resolve(payload);
          waiters.splice(i, 1);
        }
      });
      const waitFor = (predicate, timeoutMs = 15_000) => {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, reject, timer: null };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Timed out waiting for the alarm settlement push."));
          }, timeoutMs);
          waiters.push(waiter);
        });
      };
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("WebSocket handshake timed out.")), 5000);
            socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed.")); }, { once: true });
          })
        ]);
        await waitFor((message) => message.type === "ready", 5000);
        assert.equal(socket.protocol, "gamba-events-v1", "The bearer token subprotocol must never be echoed back.");
        const started = await api(baseUrl, "/api/round/start", {
          method: "POST", token: isolatedToken, headers: { "idempotency-key": idempotencyKey() }, body: { stake: 1 }
        });
        assert.equal(started.status, 200, started.text);
        const roundId = started.data.round.id;
        assert.ok(roundId);

        // Do not request /api/round/status while waiting. The Durable Object alarm itself must
        // settle the round and publish the same authoritative result over the live socket.
        const pushed = await waitFor((message) => message.type === "round-settled" && message.roundId === roundId);
        assert.ok(["cashed_out", "busted"].includes(pushed.result));
        assert.equal(pushed.state.activeRound, null);
        assert.equal(pushed.state.roundNumber, 1);

        const recovered = await api(baseUrl, "/api/state", { token: isolatedToken });
        assert.equal(recovered.status, 200, recovered.text);
        assert.equal(recovered.data.state.activeRound, null, "the server alarm should settle the active round");
        assert.equal(recovered.data.state.roundNumber, 1);
        assert.equal(recovered.data.profile.stats.roundsPlayed, 1);
      } finally {
        try { socket.close(); } catch { /* already closed */ }
        for (const waiter of waiters) clearTimeout(waiter.timer);
      }
    });

    await t.test("authenticated WebSocket receives settlement events without waiting for status polling", async () => {
      const fresh = await api(baseUrl, "/api/session", { method: "POST", body: {} });
      assert.equal(fresh.status, 201, fresh.text);
      const token = fresh.data.token;
      const seed = await api(baseUrl, "/api/client-seed", {
        method: "POST", token, body: { clientSeed: randomBytes(16).toString("hex") }
      });
      assert.equal(seed.status, 200, seed.text);

      const wsBase = baseUrl.replace(/^http:/, "ws:");
      const socket = new WebSocket(`${wsBase}/api/round/events`, ["gamba-events-v1", `gamba-auth.${token}`]);
      const seen = [];
      const waiters = [];
      socket.addEventListener("message", (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        seen.push(payload);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (!waiters[i].predicate(payload)) continue;
          clearTimeout(waiters[i].timer);
          waiters[i].resolve(payload);
          waiters.splice(i, 1);
        }
      });
      const waitFor = (predicate, timeoutMs = 5000) => {
        const existing = seen.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, reject, timer: null };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Timed out waiting for WebSocket settlement event."));
          }, timeoutMs);
          waiters.push(waiter);
        });
      };
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
          }),
          pause(5000).then(() => { throw new Error("WebSocket handshake timed out."); })
        ]);
        await waitFor((message) => message.type === "ready");
        const startKey = idempotencyKey();
        const started = await api(baseUrl, "/api/round/start", {
          method: "POST", token, headers: { "idempotency-key": startKey }, body: { stake: 1 }
        });
        assert.equal(started.status, 200, started.text);
        assert.ok(started.data.round.id);
        const roundId = started.data.round.id;
        const cashout = await api(baseUrl, "/api/round/cashout", {
          method: "POST", token, headers: { "idempotency-key": idempotencyKey() }, body: { roundId }
        });
        assert.ok(cashout.status === 200 || (cashout.status === 409 && cashout.data.error === "round_not_running"), cashout.text);
        const pushed = await waitFor((message) => message.type === "round-settled" && message.roundId === roundId);
        assert.ok(["cashed_out", "busted"].includes(pushed.result));
        assert.equal(pushed.state.activeRound, null);
        assert.equal(pushed.state.roundNumber, 1);
      } finally {
        try { socket.close(); } catch { /* already closed */ }
        for (const waiter of waiters) clearTimeout(waiter.timer);
      }
    });

    await t.test("does not allow ending a healthy game with a positive balance", async () => {
      const before = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(before.data.state.balance, STARTING_GOLD);
      const ended = await api(baseUrl, "/api/game/end", {
        method: "POST", token: auth, headers: { "idempotency-key": idempotencyKey() }, body: {}
      });
      assert.equal(ended.status, 409, ended.text);
      assert.equal(ended.data.error, "game_not_awaiting_decision");
      const after = await api(baseUrl, "/api/state", { token: auth });
      assert.equal(after.data.state.balance, STARTING_GOLD);
      assert.equal(after.data.state.gameOver, false);
    });
  } finally {
    await stopProcess(child);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});
