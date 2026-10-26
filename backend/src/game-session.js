import { bytesToHex, hexToBytes, sha256Hex, hmacBytesWithKey } from "./crypto-utils.js";
import { crashPointFromDigest } from "./fairness.js";
import { logOperationalError, logUnexpectedRequestError } from "./request-logging.js";
import { ApiError, json, readJsonLimited, safeParse } from "./api-utils.js";
import { decryptSeed, encryptSeed } from "./seed-crypto.js";
import { initializeGameSessionSchema } from "./database-schema.js";
import { readProfileData, recordSettledRound } from "./session-stats.js";
import {
  GROWTH_PER_SECOND,
  LOANS,
  MAX_CLIENT_SEED_LENGTH,
  MAX_MULTIPLIER,
  PUBLIC_HISTORY_LIMIT,
  STARTING_GOLD,
  calculatePayout,
  readRequestedMultiplierCents,
  resolveCashoutMultiplierCents
} from "./game-rules.js";

export class GameSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    // Cache only a non-extractable HMAC CryptoKey, never the decrypted server-seed string.
    // The key is scoped to an immutable seed epoch/commitment and replaced on rotation.
    this.cachedRoundHmacKey = null;
    this.pendingStartPromises = new Map();
    initializeGameSessionSchema(this.sql);
    // Recover an active round created before a deploy or browser interruption.
    this.ctx.blockConcurrencyWhile(async () => {
      const active = this.getActiveRound();
      if (!active) return;
      const dueAt = this.settlementAt(active);
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > dueAt) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 25, dueAt));
      }
    });
  }

  readState() {
    const row = this.sql.exec("SELECT value FROM meta WHERE key='state'").toArray()[0];
    return row ? safeParse(row.value, null) : null;
  }

  writeState(state) {
    this.sql.exec("INSERT INTO meta(key,value) VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state));
  }

  getActiveRound() {
    return this.sql.exec("SELECT * FROM rounds WHERE status='running' ORDER BY started_at DESC LIMIT 1").toArray()[0] || null;
  }

  settlementAt(round) {
    const target = Math.min(MAX_MULTIPLIER, Math.max(1, Number(round.crash_point) || 1));
    const durationMs = Math.ceil(((target - 1) / GROWTH_PER_SECOND) * 1000);
    return Number(round.started_at) + Math.max(0, durationMs);
  }

  async clearSettlementAlarm(settledRoundId = null) {
    try {
      // A background cleanup for an older round must never delete a newer round's alarm.
      const active = settledRoundId ? this.getActiveRound() : null;
      if (active && active.id !== settledRoundId) return;
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      logOperationalError("settlement_alarm_cleanup_failed", { roundId: settledRoundId }, error);
    }
  }

  deferSettlementAlarmCleanup(roundId) {
    // Alarm cleanup is housekeeping, not part of payout confirmation. Keep it off the
    // response's critical path while ensuring it cannot cancel a later round's alarm.
    const cleanup = this.clearSettlementAlarm(roundId);
    if (typeof this.ctx.waitUntil === "function") this.ctx.waitUntil(cleanup);
    else void cleanup;
  }

  async getRoundHmacKey(seedRow) {
    const epoch = Number(seedRow.epoch);
    const commitment = seedRow.commitment;
    const cached = this.cachedRoundHmacKey;
    if (cached && cached.epoch === epoch && cached.commitment === commitment) return cached.key;

    // Concurrent cold starts for the same epoch share one decrypt/import operation.
    const pending = this.roundHmacKeyPromise;
    if (pending && pending.epoch === epoch && pending.commitment === commitment) return pending.promise;

    const record = { epoch, commitment, promise: null };
    record.promise = (async () => {
      const seed = await decryptSeed(seedRow.seed_iv, seedRow.seed_cipher, this.env.SEED_ENCRYPTION_KEY);
      const seedBytes = hexToBytes(seed);
      let key;
      try {
        key = await crypto.subtle.importKey(
          "raw", seedBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
      } finally {
        seedBytes.fill(0);
      }
      // A reset can rotate epochs while the decrypt/import promise is in flight.
      // Do not let an old epoch overwrite a newer epoch's cache.
      if (this.roundHmacKeyPromise === record) this.cachedRoundHmacKey = { epoch, commitment, key };
      return key;
    })();
    this.roundHmacKeyPromise = record;
    try {
      return await record.promise;
    } finally {
      if (this.roundHmacKeyPromise === record) this.roundHmacKeyPromise = null;
    }
  }

  async alarm() {
    const round = this.getActiveRound();
    if (!round) return;
    const state = this.readState();
    if (!state) return;
    const now = Date.now();
    const elapsed = Math.max(0, (now - Number(round.started_at)) / 1000);
    const liveMultiplier = Math.min(MAX_MULTIPLIER, 1 + elapsed * GROWTH_PER_SECOND);
    // Preserve the same boundary rule as cash-out/status: crash check precedes the x10 cap.
    if (liveMultiplier >= Number(round.crash_point)) {
      await this.settleBust(round, state, now);
      return;
    }
    if (liveMultiplier >= MAX_MULTIPLIER) {
      await this.settleAtCap(round, state, now);
      return;
    }
    // Alarms are at-least-once; if the platform fires a little early, reschedule once the due time is reached.
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, this.settlementAt(round)));
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/round/events" && request.method === "GET") return this.openRoundEvents(request);
      if (url.pathname === "/internal/init" && request.method === "POST") return await this.initialize(await readJsonLimited(request));
      if (url.pathname === "/api/state" && request.method === "GET") return this.stateResponse();
      if (url.pathname === "/api/client-seed" && request.method === "POST") return await this.setClientSeed(await readJsonLimited(request));
      if (url.pathname === "/api/round/start" && request.method === "POST") return await this.startRound(
        await readJsonLimited(request), request.headers.get("idempotency-key"),
        request.headers.get("x-gamba-internal-received-at")
      );
      if (url.pathname === "/api/round/release-intent" && request.method === "POST") {
        const releaseReceivedAt = Date.now();
        return await this.releaseIntent(await readJsonLimited(request), request.headers.get("idempotency-key"), releaseReceivedAt);
      }
      if (url.pathname === "/api/round/cashout" && request.method === "POST") return await this.cashOut(await readJsonLimited(request), request.headers.get("idempotency-key"));
      if (url.pathname === "/api/round/status" && request.method === "GET") return await this.roundStatus(url.searchParams.get("id"));
      if (url.pathname === "/api/loan" && request.method === "POST") return await this.takeLoan(await readJsonLimited(request), request.headers.get("idempotency-key"));
      if (url.pathname === "/api/game/reset" && request.method === "POST") {
        await readJsonLimited(request);
        return await this.resetGame(request.headers.get("idempotency-key"));
      }
      if (url.pathname === "/api/game/end" && request.method === "POST") {
        await readJsonLimited(request);
        return await this.endGame(request.headers.get("idempotency-key"));
      }
      if (url.pathname === "/api/fairness" && request.method === "GET") return this.fairness(url.searchParams);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      const requestId = request.headers.get("x-gamba-request-id") || crypto.randomUUID();
      logUnexpectedRequestError({ requestId, method: request.method, path: url.pathname, error });
      // Keep client responses generic; requestId lets operators correlate provider logs.
      return json({ error: "internal_error", requestId }, 500);
    }
  }

  openRoundEvents(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426, { upgrade: "websocket" });
    }
    const protocols = String(request.headers.get("sec-websocket-protocol") || "")
      .split(",").map(value => value.trim());
    if (!protocols.includes("gamba-events-v1")) return json({ error: "websocket_protocol_required" }, 400);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // The token-bearing subprotocol is not selected or echoed to the browser.
    server.send(JSON.stringify({ type: "ready", serverTime: Date.now() }));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "gamba-events-v1", "cache-control": "no-store" }
    });
  }

  webSocketMessage(socket, message) {
    // This channel is server-push only. Ignore client data rather than treating it as gameplay input.
    if (typeof message === "string" && message.length > 0) {
      try { socket.send(JSON.stringify({ type: "error", error: "server_push_only" })); } catch { /* disconnected */ }
    }
  }

  broadcastRoundSettled(response, roundId, startKey = null) {
    const message = JSON.stringify({
      ...response,
      type: "round-settled",
      roundId,
      ...(startKey ? { startKey } : {}),
      serverTime: Date.now()
    });
    let sockets = [];
    try { sockets = this.ctx.getWebSockets(); } catch { return; }
    for (const socket of sockets) {
      try { socket.send(message); } catch { /* A stale socket must not block durable settlement. */ }
    }
  }

  cleanupExpiredRecords(now = Date.now()) {
    // A round's durable response is also saved on its rounds row, so the short-lived
    // idempotency cache for round-start can be pruned without losing safe replay lookup.
    const roundStartRetentionMs = 30 * 24 * 60 * 60 * 1000;
    this.sql.exec(
      "DELETE FROM idempotency WHERE action='round-start' AND created_at < ? AND key IN (SELECT idempotency_key FROM rounds WHERE response_json IS NOT NULL)",
      now - roundStartRetentionMs
    );
    // Early intents only bridge the short window between a start request and its commit.
    this.sql.exec("DELETE FROM early_release_intents WHERE created_at < ?", now - 60_000);
  }

  cachedIdempotent(key, action) {
    const row = this.sql.exec("SELECT action,response_json FROM idempotency WHERE key=?", key).toArray()[0];
    if (!row) return null;
    if (row.action !== action) throw new ApiError(409, "idempotency_key_reused", "This idempotency key was already used for a different action.");
    return safeParse(row.response_json, null);
  }

  storeIdempotent(key, action, response) {
    this.sql.exec("INSERT INTO idempotency(key,action,response_json,created_at) VALUES(?,?,?,?)", key, action, JSON.stringify(response), Date.now());
  }

  async initialize(body) {
    if (this.readState()) return json({ error: "already_initialized" }, 409);
    const edge = Number(body.edgePercent);
    if (!Number.isInteger(edge) || edge < 0 || edge > 10) throw new ApiError(500, "invalid_house_edge_config", "House edge configuration must be 0–10%.");
    const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const encrypted = await encryptSeed(seed, this.env.SEED_ENCRYPTION_KEY);
    const commitment = await sha256Hex(seed);
    const state = {
      sessionId: body.sessionId,
      balance: STARTING_GOLD,
      roundNumber: 0,
      gameOver: false,
      waitingForLoan: false,
      clientSeed: null,
      edgePercent: edge,
      currentEpoch: 1,
      activeLoans: [],
      loansTaken: { "444": false, "888": false, "1500": false },
      loansRepaid: { "444": false, "888": false, "1500": false },
      history: []
    };
    this.ctx.storage.transactionSync(() => {
      this.writeState(state);
      this.sql.exec("INSERT INTO seeds(epoch,commitment,seed_iv,seed_cipher,created_at) VALUES(1,?,?,?,?)", commitment, encrypted.iv, encrypted.ciphertext, Date.now());
      this.sql.exec("INSERT OR IGNORE INTO session_stats(id,updated_at) VALUES(1,?)", Date.now());
    });
    return json({ state: this.publicState(state), commitment, epoch: 1, clientSeedRequired: true, serverTime: Date.now(), profile: readProfileData(this.sql) });
  }

  publicState(state, activeRoundOverride = undefined) {
    const active = activeRoundOverride === null ? null : this.getActiveRound();
    return {
      balance: state.balance, roundNumber: state.roundNumber, gameOver: state.gameOver,
      waitingForLoan: state.waitingForLoan, clientSeed: state.clientSeed,
      activeLoans: state.activeLoans, loansTaken: state.loansTaken,
      loansRepaid: state.loansRepaid || { "444": false, "888": false, "1500": false },
      activeRound: active ? { id: active.id, stake: active.stake, startedAt: active.started_at, commitment: this.currentCommitment() } : null,
      history: state.history.slice(-PUBLIC_HISTORY_LIMIT)
    };
  }

  currentCommitment() {
    const state = this.readState();
    const row = this.sql.exec("SELECT commitment FROM seeds WHERE epoch=?", state.currentEpoch).toArray()[0];
    return row?.commitment || null;
  }

  stateResponse() {
    const state = this.readState();
    if (!state) return json({ error: "session_not_initialized" }, 409);
    return json({ state: this.publicState(state), commitment: this.currentCommitment(), epoch: state.currentEpoch, serverTime: Date.now(), profile: readProfileData(this.sql) });
  }

  async setClientSeed(body) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (this.getActiveRound()) throw new ApiError(409, "round_in_progress", "Client seed cannot change during a round.");
    const seed = body?.clientSeed;
    if (typeof seed !== "string" || seed.length < 8 || seed.length > MAX_CLIENT_SEED_LENGTH || !/^[\x21-\x7E]+$/.test(seed)) {
      throw new ApiError(400, "invalid_client_seed", "Client seed must be 8–128 printable ASCII characters without spaces.");
    }
    if (state.clientSeed === seed) {
      return json({ clientSeed: seed, commitment: this.currentCommitment() });
    }
    state.clientSeed = seed;
    this.ctx.storage.transactionSync(() => this.writeState(state));
    return json({ clientSeed: seed, commitment: this.currentCommitment() });
  }

  async storeReleaseIntentResponse(idempotencyKey, responseData) {
    let result = responseData;
    this.ctx.storage.transactionSync(() => {
      const cached = this.cachedIdempotent(idempotencyKey, "round-release-intent");
      if (cached) result = cached;
      else this.storeIdempotent(idempotencyKey, "round-release-intent", responseData);
    });
    return json(result);
  }

  async releaseIntent(body, idempotencyKey, releaseReceivedAt = Date.now()) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    // Prefixing the internal cash-out key must remain inside the common 100-character limit.
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,90}$/.test(idempotencyKey)) {
      throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header (16–90 URL-safe characters).");
    }
    const startKey = body?.startKey;
    if (typeof startKey !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(startKey)) {
      throw new ApiError(400, "start_key_required", "Provide the idempotency key used to start the round.");
    }
    const requestedMultiplierCents = readRequestedMultiplierCents(body);
    const cached = this.cachedIdempotent(idempotencyKey, "round-release-intent");
    if (cached) return json(cached);

    const round = this.sql.exec("SELECT id,status FROM rounds WHERE idempotency_key=?", startKey).toArray()[0];
    if (round) {
      let resultResponse;
      if (round.status === "running") {
        const internalCashoutKey = `early_${idempotencyKey}`;
        const settledResponse = await this.cashOut({
          roundId: round.id,
          ...(requestedMultiplierCents === undefined ? {} : { requestedMultiplierCents })
        }, internalCashoutKey);
        const settledData = await settledResponse.json();
        if (settledResponse.ok) {
          resultResponse = settledData;
        } else if (settledResponse.status === 409 && settledData?.error === "round_not_running") {
          // An alarm/status request may have settled the round between our first read and cash-out.
          const statusResponse = await this.roundStatus(round.id);
          resultResponse = await statusResponse.json();
        } else {
          return json(settledData || { error: "release_not_confirmed" }, settledResponse.status);
        }
      } else {
        const statusResponse = await this.roundStatus(round.id);
        resultResponse = await statusResponse.json();
      }
      return this.storeReleaseIntentResponse(idempotencyKey, { ...resultResponse, releaseMode: "settled" });
    }

    if (state.gameOver || state.waitingForLoan || state.balance <= 0 || !state.clientSeed) {
      throw new ApiError(409, "round_not_startable", "There is no eligible round start to release.");
    }
    const active = this.getActiveRound();
    if (active && active.idempotency_key !== startKey) {
      throw new ApiError(409, "round_already_running", "Another round is already running.");
    }

    const now = Date.now();
    const queued = { releaseMode: "queued", startKey };
    let resultResponse = queued;
    this.ctx.storage.transactionSync(() => {
      const alreadyCached = this.cachedIdempotent(idempotencyKey, "round-release-intent");
      if (alreadyCached) {
        resultResponse = alreadyCached;
        return;
      }
      // Stale entries can only result from a start request that failed before creating a round.
      this.cleanupExpiredRecords(now);
      const previousIntent = this.sql.exec("SELECT start_key FROM early_release_intents WHERE start_key=?", startKey).toArray()[0];
      if (!previousIntent) {
        this.sql.exec("INSERT INTO early_release_intents(start_key,release_key,released_at,created_at) VALUES(?,?,?,?)",
          startKey, idempotencyKey, releaseReceivedAt, now);
      }
      this.storeIdempotent(idempotencyKey, "round-release-intent", queued);
      resultResponse = queued;
    });
    return json(resultResponse);
  }

  reserveStartSlot(idempotencyKey, requestReceivedAt) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      let reservation = this.sql.exec("SELECT idempotency_key,created_at FROM start_reservations WHERE id=1").toArray()[0];
      // Recover abandoned reservations after an isolate termination or unexpected exception.
      if (reservation && now - Number(reservation.created_at) > 30_000) {
        this.sql.exec("DELETE FROM start_reservations WHERE id=1");
        reservation = null;
      }
      if (reservation) {
        throw new ApiError(409, "round_start_in_progress", "Another start request is already being processed.");
      }
      const last = this.sql.exec("SELECT value FROM meta WHERE key='last_start_completed_at'").toArray()[0];
      if (last && Number.isFinite(Number(last.value)) && requestReceivedAt <= Number(last.value)) {
        // The request reached the edge before the previous start completed, but was queued
        // until after that round settled (including an immediate x1.00 bust).
        throw new ApiError(409, "round_start_in_progress", "This start request overlapped the previous start.");
      }
      this.sql.exec("INSERT INTO start_reservations(id,idempotency_key,received_at,created_at) VALUES(1,?,?,?)",
        idempotencyKey, requestReceivedAt, now);
    });
  }

  finishStartSlot(idempotencyKey) {
    const completedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta(key,value) VALUES('last_start_completed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        String(completedAt));
      this.sql.exec("DELETE FROM start_reservations WHERE id=1 AND idempotency_key=?", idempotencyKey);
    });
  }

  releaseStartSlot(idempotencyKey) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM start_reservations WHERE id=1 AND idempotency_key=?", idempotencyKey);
    });
  }

  async replayRoundStart(response) {
    const active = this.getActiveRound();
    if (active && active.id === response.round?.id) {
      await this.ctx.storage.setAlarm(this.settlementAt(active));
    }
    return json({ ...response, serverTime: Date.now() });
  }

  async startRound(body, idempotencyKey, receivedAtHeader = null) {
    // Let the core perform the standard key validation for malformed requests.
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      return this.startRoundCore(body, idempotencyKey);
    }
    const cached = this.cachedIdempotent(idempotencyKey, "round-start");
    if (cached) return this.replayRoundStart(cached);
    const existing = this.sql.exec("SELECT response_json FROM rounds WHERE idempotency_key=?", idempotencyKey).toArray()[0];
    if (existing?.response_json) return this.replayRoundStart(safeParse(existing.response_json, { error: "idempotency_replay" }));

    // Reuse the same in-flight operation for retries with the same idempotency key.
    const pending = this.pendingStartPromises.get(idempotencyKey);
    if (pending) {
      const result = await pending;
      return json(result.data, result.status);
    }

    const parsedReceivedAt = Number(receivedAtHeader);
    const requestReceivedAt = Number.isSafeInteger(parsedReceivedAt) && parsedReceivedAt > 0
      ? parsedReceivedAt : Date.now();
    const operation = (async () => {
      try {
        this.reserveStartSlot(idempotencyKey, requestReceivedAt);
        const response = await this.startRoundCore(body, idempotencyKey);
        const result = { status: response.status, data: await response.json() };
        this.finishStartSlot(idempotencyKey);
        return result;
      } catch (error) {
        this.releaseStartSlot(idempotencyKey);
        throw error;
      }
    })();
    this.pendingStartPromises.set(idempotencyKey, operation);
    try {
      const result = await operation;
      return json(result.data, result.status);
    } finally {
      if (this.pendingStartPromises.get(idempotencyKey) === operation) {
        this.pendingStartPromises.delete(idempotencyKey);
      }
    }
  }

  async startRoundCore(body, idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header (16–100 URL-safe characters).");
    // Bound orphaned intents from starts that failed before creating a round, but preserve
    // an intent associated with this same in-flight idempotency key.
    this.cleanupExpiredRecords();
    const cached = this.cachedIdempotent(idempotencyKey, "round-start");
    if (cached) return this.replayRoundStart(cached);
    const existing = this.sql.exec("SELECT response_json FROM rounds WHERE idempotency_key=?", idempotencyKey).toArray()[0];
    if (existing?.response_json) return this.replayRoundStart(safeParse(existing.response_json, { error: "idempotency_replay" }));
    if (state.gameOver) throw new ApiError(409, "game_over", "Start a new game before playing again.");
    if (state.waitingForLoan) throw new ApiError(409, "loan_decision_required", "Take a loan or end the game before starting another round.");
    if (!state.clientSeed) throw new ApiError(409, "client_seed_required", "Set a client seed before starting a round.");
    if (this.getActiveRound()) throw new ApiError(409, "round_already_running", "Cash out or wait for the current round to finish.");
    const stake = body?.stake;
    // No arbitrary gameplay cap: only retain a safe-integer ceiling so stake × x10 payouts stay precise.
    const safeStakeCeiling = Math.max(0, Math.min(
      Math.floor(Number.MAX_SAFE_INTEGER / MAX_MULTIPLIER),
      Math.floor((Number.MAX_SAFE_INTEGER - state.balance) / (MAX_MULTIPLIER - 1))
    ));
    if (!Number.isSafeInteger(stake) || stake < 1 || stake > safeStakeCeiling) throw new ApiError(400, "invalid_stake", `Stake must be a whole number from 1 to ${safeStakeCeiling} to preserve exact integer arithmetic.`);
    if (stake > state.balance) throw new ApiError(409, "insufficient_balance", "Stake exceeds the current balance.");

    const epoch = state.currentEpoch;
    const clientSeed = state.clientSeed;
    const seedRow = this.sql.exec("SELECT * FROM seeds WHERE epoch=?", epoch).toArray()[0];
    if (!seedRow) throw new ApiError(500, "seed_missing", "Current fairness seed is unavailable.");
    const hmacKey = await this.getRoundHmacKey(seedRow);
    const nonce = state.roundNumber + 1;
    const digest = await hmacBytesWithKey(hmacKey, `${clientSeed}:${nonce}`);
    const crashPoint = crashPointFromDigest(digest, state.edgePercent);
    const roundId = crypto.randomUUID();
    const startedAt = Date.now();
    const roundPayload = { id: roundId, nonce, epoch, stake, startedAt, commitment: seedRow.commitment };
    let response;
    const duplicateAfterCrypto = this.cachedIdempotent(idempotencyKey, "round-start");
    if (duplicateAfterCrypto) return this.replayRoundStart(duplicateAfterCrypto);

    this.ctx.storage.transactionSync(() => {
      // Recheck under the serialized SQLite transaction to reject concurrent starts.
      const latest = this.readState();
      if (!latest || latest.gameOver || latest.waitingForLoan || latest.balance < stake ||
          latest.currentEpoch !== epoch || latest.roundNumber + 1 !== nonce ||
          latest.clientSeed !== clientSeed || this.getActiveRound()) {
        throw new ApiError(409, "round_state_changed", "Game state changed; refresh and try again.");
      }
      latest.balance -= stake;
      this.writeState(latest);
      // Persist a replay copy so old cache rows can eventually be removed without losing start retries.
      this.sql.exec("INSERT INTO rounds(id,nonce,epoch,client_seed,stake,started_at,crash_point,status,idempotency_key,edge_percent) VALUES(?,?,?,?,?,?,?,'running',?,?)",
        roundId, nonce, epoch, clientSeed, stake, startedAt, crashPoint, idempotencyKey, state.edgePercent);

      const roundRecord = { id: roundId, nonce, epoch, client_seed: clientSeed, stake,
        started_at: startedAt, crash_point: crashPoint, status: "running", edge_percent: state.edgePercent };
      const earlyRelease = this.sql.exec(
        "SELECT released_at FROM early_release_intents WHERE start_key=? AND created_at>=?",
        idempotencyKey, startedAt - 60_000
      ).toArray()[0];
      if (earlyRelease) {
        // The release reached the server before this round was committed. Its only fair
        // interpretation is cash-out at the start boundary (x1.00), still subject to bust-at-x1.
        const bustedAtStart = 1 >= crashPoint;
        const settled = this.settleRound(
          roundRecord, latest, bustedAtStart ? "BUSTED" : "CASHED OUT",
          bustedAtStart ? crashPoint : 1, bustedAtStart ? 0 : stake, startedAt
        );
        this.sql.exec("UPDATE rounds SET status=?,payout=?,cashed_out_at=? WHERE id=? AND status='running'",
          bustedAtStart ? "busted" : "cashed_out", bustedAtStart ? 0 : stake, startedAt, roundId);
        this.writeState(settled.state);
        recordSettledRound(this.sql, roundRecord, settled.historyItem);
        this.sql.exec("DELETE FROM early_release_intents WHERE start_key=?", idempotencyKey);
        response = {
          round: roundPayload,
          result: bustedAtStart ? "busted" : "cashed_out",
          roundId,
          ...(bustedAtStart ? { crashPoint } : {}),
          multiplier: bustedAtStart ? crashPoint : 1,
          payout: bustedAtStart ? 0 : stake,
          net: settled.historyItem.net,
          state: this.publicState(settled.state, null),
          historyItem: settled.historyItem,
          repayments: settled.repayments,
          defaultedLoan: settled.defaultedLoan,
          profile: readProfileData(this.sql)
        };
      } else {
        response = { round: roundPayload, state: { balance: latest.balance, roundNumber: latest.roundNumber } };
      }
      this.sql.exec("UPDATE rounds SET response_json=? WHERE id=?", JSON.stringify(response), roundId);
      this.storeIdempotent(idempotencyKey, "round-start", response);
    });

    if (!response.result) {
      // One Durable Object alarm settles a round if the browser disconnects. Alarm persistence
      // remains on the start path; it must be durable before the server confirms the round.
      try {
        await this.ctx.storage.setAlarm(this.settlementAt({ started_at: startedAt, crash_point: crashPoint }));
      } catch (error) {
        logOperationalError("round_alarm_scheduling_failed", { roundId }, error);
        throw new ApiError(503, "round_alarm_unavailable", "Retry this start with the same Idempotency-Key to confirm automatic settlement.");
      }
    } else {
      this.broadcastRoundSettled(response, roundId, idempotencyKey);
    }
    const serverTime = Date.now();
    return json(response.result
      ? { ...response, serverTime }
      : { ...response, crashPoint: undefined, serverTime });
  }

  settleRound(round, state, result, multiplier, payout, now) {
    state.balance += payout;
    state.roundNumber += 1;
    const repayments = [];
    if (!state.loansRepaid) state.loansRepaid = { "444": false, "888": false, "1500": false };
    // Collect affordable repayments in nearest-deadline order before advancing deadlines.
    const dueOrder = [...state.activeLoans].sort((a, b) => a.roundsLeft - b.roundsLeft || a.principal - b.principal);
    for (const loan of dueOrder) {
      if (state.balance >= loan.repayment) {
        state.balance -= loan.repayment;
        repayments.push({ principal: loan.principal, repayment: loan.repayment });
        state.loansRepaid[String(loan.principal)] = true;
        state.activeLoans = state.activeLoans.filter(x => x !== loan);
      }
    }
    for (const loan of state.activeLoans) loan.roundsLeft -= 1;
    const expired = state.activeLoans.find(loan => loan.roundsLeft <= 0 && state.balance < loan.repayment);
    if (expired && state.balance > 0) state.gameOver = true;
    state.waitingForLoan = state.balance <= 0 && !state.gameOver;
    const repaymentTotal = repayments.reduce((total, item) => total + item.repayment, 0);
    const net = payout - round.stake - repaymentTotal;
    const historyItem = { round: state.roundNumber, roundId: round.id, stake: round.stake, payout, multiplier, net, result, repayments, at: now };
    state.history.push(historyItem);
    if (state.history.length > 100) state.history = state.history.slice(-100);
    return { state, historyItem, repayments, defaultedLoan: expired || null };
  }

  async cashOut(body, idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header.");
    const cached = this.cachedIdempotent(idempotencyKey, "cashout");
    if (cached) return json(cached);
    const roundId = body?.roundId;
    if (typeof roundId !== "string") throw new ApiError(400, "round_id_required", "Provide the active round ID.");
    const requestedMultiplierCents = readRequestedMultiplierCents(body);
    const round = this.sql.exec("SELECT * FROM rounds WHERE id=?", roundId).toArray()[0];
    if (!round) throw new ApiError(404, "round_not_found", "Round was not found.");
    if (round.status !== "running") throw new ApiError(409, "round_not_running", "This round is already settled.");
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - round.started_at) / 1000);
    const liveMultiplier = Math.min(MAX_MULTIPLIER, 1 + elapsedSeconds * GROWTH_PER_SECOND);
    if (liveMultiplier >= round.crash_point) return await this.settleBust(round, state, now, idempotencyKey);
    if (liveMultiplier >= MAX_MULTIPLIER) return json(await this.settleAtCap(round, state, now, idempotencyKey, requestedMultiplierCents));
    // Never award more than either the visible release value or server time allows.
    // A delayed network request can reduce latency-induced display jumps, but cannot
    // make a late cash-out win after the server has reached the committed crash point.
    const multiplierCents = resolveCashoutMultiplierCents(liveMultiplier, requestedMultiplierCents);
    const multiplier = multiplierCents / 100;
    const payout = calculatePayout(round.stake, multiplierCents);
    const settled = this.settleRound(round, state, "CASHED OUT", multiplier, payout, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='cashed_out', payout=?, cashed_out_at=? WHERE id=? AND status='running'", payout, now, roundId);
      this.writeState(settled.state);
      recordSettledRound(this.sql, round, settled.historyItem);
      response = { result: "cashed_out", roundId, multiplier, payout, net: settled.historyItem.net,
        state: this.publicState(settled.state, null), historyItem: settled.historyItem,
        repayments: settled.repayments, defaultedLoan: settled.defaultedLoan, profile: readProfileData(this.sql) };
      this.storeIdempotent(idempotencyKey, "cashout", response);
    });
    this.broadcastRoundSettled(response, roundId, round.idempotency_key);
    this.deferSettlementAlarmCleanup(roundId);
    return json(response);
  }

  async settleBust(round, state, now, idempotencyKey = null) {
    // Re-read the row immediately before settlement so a late alarm/status/cash-out cannot settle twice.
    const latest = this.sql.exec("SELECT * FROM rounds WHERE id=?", round.id).toArray()[0];
    if (!latest || latest.status !== "running") {
      const currentState = this.readState();
      const historyItem = currentState?.history?.find((item) => item.roundId === round.id) || null;
      return json({ status: latest?.status || "not_found", result: latest?.status || "not_found", roundId: round.id,
        payout: latest?.payout ?? 0, historyItem, state: this.publicState(currentState), profile: readProfileData(this.sql) });
    }
    round = latest;
    const currentState = this.readState() || state;
    const settled = this.settleRound(round, currentState, "BUSTED", round.crash_point, 0, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='busted', payout=0, cashed_out_at=? WHERE id=? AND status='running'", now, round.id);
      this.writeState(settled.state);
      recordSettledRound(this.sql, round, settled.historyItem);
      response = { result: "busted", roundId: round.id, crashPoint: round.crash_point, payout: 0,
        net: settled.historyItem.net, state: this.publicState(settled.state, null),
        historyItem: settled.historyItem, repayments: settled.repayments,
        defaultedLoan: settled.defaultedLoan, profile: readProfileData(this.sql) };
      if (idempotencyKey) this.storeIdempotent(idempotencyKey, "cashout", response);
    });
    this.broadcastRoundSettled(response, round.id, round.idempotency_key);
    this.deferSettlementAlarmCleanup(round.id);
    return json(response);
  }

  async settleAtCap(round, state, now, idempotencyKey = null, requestedMultiplierCents = undefined) {
    const latest = this.sql.exec("SELECT * FROM rounds WHERE id=?", round.id).toArray()[0];
    if (!latest || latest.status !== "running") {
      const currentState = this.readState();
      const historyItem = currentState?.history?.find((item) => item.roundId === round.id) || null;
      return { result: latest?.status || "not_found", roundId: round.id, payout: latest?.payout ?? 0,
        historyItem, state: this.publicState(currentState), profile: readProfileData(this.sql) };
    }
    round = latest;
    const currentState = this.readState() || state;
    // An in-flight release that reaches the server at the x10 boundary still respects
    // the visible release cap. Automatic alarm settlement remains exactly x10.
    const multiplierCents = resolveCashoutMultiplierCents(MAX_MULTIPLIER, requestedMultiplierCents);
    const payoutMultiplier = multiplierCents / 100;
    const payout = calculatePayout(round.stake, multiplierCents);
    const settled = this.settleRound(round, currentState, "CASHED OUT", payoutMultiplier, payout, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='cashed_out', payout=?, cashed_out_at=? WHERE id=? AND status='running'", payout, now, round.id);
      this.writeState(settled.state);
      recordSettledRound(this.sql, round, settled.historyItem);
      response = { result: "cashed_out", roundId: round.id, multiplier: payoutMultiplier, payout,
        net: settled.historyItem.net, state: this.publicState(settled.state, null),
        historyItem: settled.historyItem, repayments: settled.repayments,
        defaultedLoan: settled.defaultedLoan, profile: readProfileData(this.sql) };
      if (idempotencyKey) this.storeIdempotent(idempotencyKey, "cashout", response);
    });
    this.broadcastRoundSettled(response, round.id, round.idempotency_key);
    this.deferSettlementAlarmCleanup(round.id);
    return response;
  }

  async roundStatus(id) {
    if (!id) return json({ error: "round_id_required" }, 400);
    const round = this.sql.exec("SELECT * FROM rounds WHERE id=?", id).toArray()[0];
    if (!round) throw new ApiError(404, "round_not_found", "Round was not found.");
    const state = this.readState();
    if (round.status === "running") {
      const serverTime = Date.now();
      const elapsed = Math.max(0, (serverTime - round.started_at) / 1000);
      const liveMultiplier = Math.min(MAX_MULTIPLIER, 1 + elapsed * GROWTH_PER_SECOND);
      if (liveMultiplier >= round.crash_point) return await this.settleBust(round, state, Date.now(), null);
      if (liveMultiplier >= MAX_MULTIPLIER) return json({ status: "cashed_out", ...await this.settleAtCap(round, state, Date.now()) });
      return json({ status: "running", round: { id: round.id, startedAt: round.started_at, stake: round.stake }, multiplier: Math.floor(liveMultiplier * 100) / 100, serverTime });
    }
    const historyItem = state?.history?.find((item) => item.roundId === id) || null;
    return json({ status: round.status, result: round.status, roundId: id,
      crashPoint: round.status === "busted" ? round.crash_point : undefined,
      multiplier: historyItem?.multiplier, payout: round.payout, net: historyItem?.net,
      cashedOutAt: round.cashed_out_at, historyItem, state: this.publicState(state), profile: readProfileData(this.sql) });
  }

  async takeLoan(body, idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header.");
    if (!state.loansRepaid) state.loansRepaid = { "444": false, "888": false, "1500": false };
    const cached = this.cachedIdempotent(idempotencyKey, "loan");
    if (cached) return json(cached);
    const principal = Number(body?.principal);
    const loan = LOANS[principal];
    if (!loan) throw new ApiError(400, "invalid_loan", "Choose one of the available loan amounts.");
    if (this.getActiveRound()) throw new ApiError(409, "round_in_progress", "Loans can only be taken between rounds.");
    if (state.gameOver) throw new ApiError(409, "game_over", "Start a new game first.");
    if (state.balance !== 0) throw new ApiError(409, "loan_requires_zero_balance", "Loans unlock only at zero gold.");
    if (state.loansTaken[String(principal)]) throw new ApiError(409, "loan_already_taken", "This loan was already used this game.");
    let extension = 0;
    if (state.activeLoans.length) {
      const nearest = Math.min(...state.activeLoans.map(x => x.roundsLeft));
      extension = Math.ceil(nearest / 2);
      for (const active of state.activeLoans) active.roundsLeft += extension;
    }
    state.activeLoans.push({ principal, repayment: loan.repayment, roundsLeft: loan.rounds + extension });
    state.loansTaken[String(principal)] = true;
    state.balance += principal;
    const overdue = state.activeLoans.filter(item => item.roundsLeft <= 0);
    const immediateRepayments = [];
    for (const oldLoan of overdue) {
      if (state.balance >= oldLoan.repayment) {
        state.balance -= oldLoan.repayment;
        immediateRepayments.push({ principal: oldLoan.principal, repayment: oldLoan.repayment });
        state.loansRepaid[String(oldLoan.principal)] = true;
        state.activeLoans = state.activeLoans.filter(item => item !== oldLoan);
      } else {
        state.gameOver = true;
        state.waitingForLoan = false;
        break;
      }
    }
    if (!state.gameOver) state.waitingForLoan = false;
    const response = { state: this.publicState(state), loan: { ...loan, roundsLeft: loan.rounds + extension }, extension, immediateRepayments, defaulted: state.gameOver };
    this.ctx.storage.transactionSync(() => {
      this.writeState(state);
      this.storeIdempotent(idempotencyKey, "loan", response);
    });
    return json(response);
  }

  async resetGame(idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header.");
    const cached = this.cachedIdempotent(idempotencyKey, "reset");
    if (cached) return json(cached);
    if (this.getActiveRound()) throw new ApiError(409, "round_in_progress", "A round must settle before resetting.");
    const oldEpoch = state.currentEpoch;
    const resetStateSnapshot = JSON.stringify(state);
    const oldSeedRow = this.sql.exec("SELECT * FROM seeds WHERE epoch=?", oldEpoch).toArray()[0];
    const oldSeed = await decryptSeed(oldSeedRow.seed_iv, oldSeedRow.seed_cipher, this.env.SEED_ENCRYPTION_KEY);
    const newSeed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const encrypted = await encryptSeed(newSeed, this.env.SEED_ENCRYPTION_KEY);
    const commitment = await sha256Hex(newSeed);
    const duplicateAfterCrypto = this.cachedIdempotent(idempotencyKey, "reset");
    if (duplicateAfterCrypto) return json(duplicateAfterCrypto);
    const newState = {
      ...state, balance: STARTING_GOLD, roundNumber: 0, gameOver: false, waitingForLoan: false,
      clientSeed: null, currentEpoch: oldEpoch + 1, activeLoans: [],
      loansTaken: { "444": false, "888": false, "1500": false },
      loansRepaid: { "444": false, "888": false, "1500": false }, history: []
    };
    this.ctx.storage.transactionSync(() => {
      const latestState = this.readState();
      if (!latestState || JSON.stringify(latestState) !== resetStateSnapshot || latestState.currentEpoch !== oldEpoch) {
        throw new ApiError(409, "game_state_changed", "Game state changed while reset was being prepared. Refresh and try again.");
      }
      if (this.getActiveRound()) {
        throw new ApiError(409, "round_in_progress", "A round must settle before resetting.");
      }
      this.sql.exec("UPDATE seeds SET revealed_seed=?, revealed_at=? WHERE epoch=? AND revealed_seed IS NULL", oldSeed, Date.now(), oldEpoch);
      this.sql.exec("INSERT INTO seeds(epoch,commitment,seed_iv,seed_cipher,created_at) VALUES(?,?,?,?,?)", oldEpoch + 1, commitment, encrypted.iv, encrypted.ciphertext, Date.now());
      this.writeState(newState);
      const response = { state: this.publicState(newState), revealed: { epoch: oldEpoch, serverSeed: oldSeed, commitment: oldSeedRow.commitment }, commitment, epoch: oldEpoch + 1, profile: readProfileData(this.sql) };
      this.storeIdempotent(idempotencyKey, "reset", response);
    });
    return json(this.cachedIdempotent(idempotencyKey, "reset"));
  }

  async endGame(idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header.");
    }
    const cached = this.cachedIdempotent(idempotencyKey, "end-game");
    if (cached) return json(cached);
    if (this.getActiveRound()) throw new ApiError(409, "round_in_progress", "A round must settle before ending the game.");
    if (state.gameOver) return json({ state: this.publicState(state), gameOver: true });
    if (!state.waitingForLoan && state.balance > 0) {
      throw new ApiError(409, "game_not_awaiting_decision", "The game can be ended here only at the zero-balance loan decision.");
    }
    state.gameOver = true;
    state.waitingForLoan = false;
    const response = { state: this.publicState(state), gameOver: true, profile: readProfileData(this.sql) };
    this.ctx.storage.transactionSync(() => {
      this.writeState(state);
      this.storeIdempotent(idempotencyKey, "end-game", response);
    });
    return json(response);
  }

  fairness(searchParams) {
    const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams();
    const rawLimit = Number.parseInt(params.get("limit") || "100", 10);
    const rawRoundOffset = Number.parseInt(params.get("roundOffset") || "0", 10);
    const rawSeedOffset = Number.parseInt(params.get("seedOffset") || "0", 10);
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 100;
    const roundOffset = Number.isSafeInteger(rawRoundOffset) ? Math.max(0, Math.min(2_000_000_000, rawRoundOffset)) : 0;
    const seedOffset = Number.isSafeInteger(rawSeedOffset) ? Math.max(0, Math.min(2_000_000_000, rawSeedOffset)) : 0;
    const state = this.readState();
    if (!state) return json({ error: "session_not_initialized" }, 409);
    const totalSeeds = Number(this.sql.exec("SELECT COUNT(*) AS count FROM seeds").toArray()[0]?.count || 0);
    const totalRounds = Number(this.sql.exec("SELECT COUNT(*) AS count FROM rounds").toArray()[0]?.count || 0);
    const seeds = this.sql.exec("SELECT epoch,commitment,created_at,revealed_seed,revealed_at FROM seeds ORDER BY epoch ASC LIMIT ? OFFSET ?", limit, seedOffset).toArray();
    const rounds = this.sql.exec("SELECT id,nonce,epoch,client_seed,stake,started_at,edge_percent,CASE WHEN status='running' THEN NULL ELSE crash_point END AS crash_point,status,payout,cashed_out_at FROM rounds ORDER BY started_at ASC,id ASC LIMIT ? OFFSET ?", limit, roundOffset).toArray();
    return json({ currentEpoch: state.currentEpoch, currentCommitment: this.currentCommitment(), houseEdgePercent: state.edgePercent,
      totalSeeds, totalRounds, seedOffset, roundOffset,
      hasMoreSeeds: seedOffset + seeds.length < totalSeeds, hasMoreRounds: roundOffset + rounds.length < totalRounds,
      seeds, rounds });
  }
}
