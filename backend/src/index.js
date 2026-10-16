const STARTING_GOLD = 888;
const MAX_MULTIPLIER = 10;
const GROWTH_PER_SECOND = 0.8;
const MAX_CLIENT_SEED_LENGTH = 128;
const PUBLIC_HISTORY_LIMIT = 10;
const LOANS = {
  444: { principal: 444, repayment: 533, rounds: 8 },
  888: { principal: 888, repayment: 1110, rounds: 6 },
  1500: { principal: 1500, repayment: 2025, rounds: 4 }
};

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid hex value");
  return Uint8Array.from(hex.match(/.{2}/g), pair => parseInt(pair, 16));
}

async function sha256Hex(text) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacBytes(secretBytes, message) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function hmacBytesWithKey(key, message) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function signedSessionToken(sessionId, secret) {
  const signature = await hmacBytes(new TextEncoder().encode(secret), sessionId);
  return `${sessionId}.${base64url(signature)}`;
}

let cachedSessionVerifier = null;
let sessionVerifierKeyPromise = null;

async function getSessionVerifierKey(secret) {
  const fingerprint = await sha256Hex(secret);
  if (cachedSessionVerifier?.fingerprint === fingerprint) return cachedSessionVerifier.key;
  if (sessionVerifierKeyPromise?.fingerprint === fingerprint) return sessionVerifierKeyPromise.promise;

  const record = { fingerprint, promise: null };
  record.promise = (async () => {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    // A secret rotation between awaits must not let the older request replace a newer cache.
    if (sessionVerifierKeyPromise === record) cachedSessionVerifier = { fingerprint, key };
    return key;
  })();
  sessionVerifierKeyPromise = record;
  try {
    return await record.promise;
  } finally {
    if (sessionVerifierKeyPromise === record) sessionVerifierKeyPromise = null;
  }
}

async function verifySessionToken(token, secret) {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const sessionId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[A-Za-z0-9_-]{40,50}$/.test(signature)) return null;
  const key = await getSessionVerifierKey(secret);
  let sigBytes;
  try {
    const padded = signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - signature.length % 4) % 4);
    sigBytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(sessionId));
  return ok ? sessionId : null;
}

async function encryptSeed(seedHex, keyB64) {
  const rawKey = fromBase64(keyB64);
  if (rawKey.length !== 32) throw new Error("SEED_ENCRYPTION_KEY must decode to exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, hexToBytes(seedHex));
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

async function decryptSeed(ivB64, cipherB64, keyB64) {
  const rawKey = fromBase64(keyB64);
  if (rawKey.length !== 32) throw new Error("SEED_ENCRYPTION_KEY must decode to exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const iv = fromBase64(ivB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - ivB64.length % 4) % 4));
  const cipher = fromBase64(cipherB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - cipherB64.length % 4) % 4));
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher));
  return bytesToHex(clear);
}

export function crashPointFromDigest(digest, edgePercent) {
  // Take the first 52 digest bits to define U in [0,1), then mirror
  // floor((100 - edgePercent) / (1-U)) / 100, clamped to x1.00.
  const first13Hex = bytesToHex(digest).slice(0, 13);
  const random52 = BigInt(`0x${first13Hex}`);
  const denominator = 1n << 52n;
  const rtpPercent = BigInt(Math.round(100 - edgePercent)); // 99 at the default 1% edge
  const remaining = denominator - random52;
  const cents = (rtpPercent * denominator) / remaining;
  // The game cash-out/display caps at x10; this tail ceiling is far above it.
  const boundedCents = cents < 100n ? 100n : cents > 100_000_000n ? 100_000_000n : cents;
  return Number(boundedCents) / 100;
}

function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

async function readJsonLimited(request, maxBytes = 8192) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  if (!request.body) {
    if (tooLarge) throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
    return {};
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        continue; // Drain without buffering the remainder, so the request stream is consumed.
      }
      if (!tooLarge) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (tooLarge) throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "invalid_json", "Request body must be valid JSON."); }
}

function configuredOrigins(env) {
  // ALLOWED_ORIGIN remains supported for upgrades from the first deployed version.
  const value = env.ALLOWED_ORIGINS ?? env.ALLOWED_ORIGIN ?? "";
  return new Set(String(value).split(",").map(origin => origin.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowedOrigins = configuredOrigins(env);
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, idempotency-key",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };

  // Non-browser clients do not send Origin and do not need CORS headers.
  if (origin && allowedOrigins.has(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("origin");
    const allowedOrigins = configuredOrigins(env);
    if (origin && !allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403, { vary: "Origin" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "gamba-crash-backend", protocol: 1 }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        if (!env.SESSION_SECRET || !env.SEED_ENCRYPTION_KEY) return json({ error: "server_not_configured" }, 503, cors);
        await readJsonLimited(request);
        const sessionId = crypto.randomUUID();
        const token = await signedSessionToken(sessionId, env.SESSION_SECRET);
        const id = env.GAME_SESSIONS.idFromName(sessionId);
        const stub = env.GAME_SESSIONS.get(id);
        const result = await stub.fetch("https://session.internal/internal/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, edgePercent: Number(env.HOUSE_EDGE_PERCENT ?? 1) }) });
        if (!result.ok) return json({ error: "session_init_failed" }, 500, cors);
        return json({ sessionId, token, ...(await result.json()) }, 201, cors);
      }

      const auth = request.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const sessionId = await verifySessionToken(token, env.SESSION_SECRET || "");
      if (!sessionId) return json({ error: "unauthorized" }, 401, cors);
      if (!url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404, cors);
      const id = env.GAME_SESSIONS.idFromName(sessionId);
      const stub = env.GAME_SESSIONS.get(id);
      const forwarded = new Request(`https://session.internal${url.pathname}${url.search}`, request);
      const response = await stub.fetch(forwarded);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status, cors);
      // Do not leak stack traces, seeds, or secret configuration in API responses.
      return json({ error: "internal_error", requestId: crypto.randomUUID() }, 500, cors);
    }
  }
};

export class GameSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    // Cache only a non-extractable HMAC CryptoKey, never the decrypted server-seed string.
    // The key is scoped to an immutable seed epoch/commitment and replaced on rotation.
    this.cachedRoundHmacKey = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seeds (
      epoch INTEGER PRIMARY KEY, commitment TEXT NOT NULL, seed_iv TEXT NOT NULL,
      seed_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, revealed_seed TEXT, revealed_at INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY, nonce INTEGER NOT NULL, epoch INTEGER NOT NULL, client_seed TEXT NOT NULL,
      stake INTEGER NOT NULL, started_at INTEGER NOT NULL, crash_point REAL NOT NULL,
      status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0, cashed_out_at INTEGER,
      idempotency_key TEXT UNIQUE, response_json TEXT, edge_percent REAL NOT NULL DEFAULT 1
    )`);
    // Safe schema migration for session objects created before edge metadata was stored per round.
    try { this.sql.exec("ALTER TABLE rounds ADD COLUMN edge_percent REAL NOT NULL DEFAULT 1"); }
    catch (error) { if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error; }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS rounds_status_idx ON rounds(status)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, action TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    // A release can arrive before the start request has finished its async crypto work.
    // Persist the release intent against the start idempotency key so the start transaction
    // can atomically create and settle the round instead of requiring two sequential requests.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS early_release_intents (
      start_key TEXT PRIMARY KEY, release_key TEXT NOT NULL, released_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS early_release_created_idx ON early_release_intents(created_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS session_stats (
      id INTEGER PRIMARY KEY CHECK(id=1), rounds_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, pushes INTEGER NOT NULL DEFAULT 0,
      total_staked INTEGER NOT NULL DEFAULT 0, total_payout INTEGER NOT NULL DEFAULT 0,
      net_result INTEGER NOT NULL DEFAULT 0, best_multiplier REAL NOT NULL DEFAULT 0,
      best_payout INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS personal_bests (
      round_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, round_number INTEGER NOT NULL,
      stake INTEGER NOT NULL, payout INTEGER NOT NULL, multiplier REAL NOT NULL,
      net INTEGER NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
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
      console.error("Could not clear settled-round alarm", { errorName: error?.name || "Error" });
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

  recordSettledRound(round, item) {
    const wins = item.payout > item.stake ? 1 : 0;
    const losses = item.payout < item.stake ? 1 : 0;
    const pushes = item.payout === item.stake ? 1 : 0;
    const scoreMultiplier = item.result === "CASHED OUT" ? item.multiplier : 0;
    this.sql.exec(`INSERT INTO session_stats
      (id,rounds_played,wins,losses,pushes,total_staked,total_payout,net_result,best_multiplier,best_payout,updated_at)
      VALUES(1,1,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        rounds_played=session_stats.rounds_played+1,
        wins=session_stats.wins+excluded.wins,
        losses=session_stats.losses+excluded.losses,
        pushes=session_stats.pushes+excluded.pushes,
        total_staked=session_stats.total_staked+excluded.total_staked,
        total_payout=session_stats.total_payout+excluded.total_payout,
        net_result=session_stats.net_result+excluded.net_result,
        best_multiplier=MAX(session_stats.best_multiplier,excluded.best_multiplier),
        best_payout=MAX(session_stats.best_payout,excluded.best_payout),
        updated_at=excluded.updated_at`,
      wins, losses, pushes, item.stake, item.payout, item.net, scoreMultiplier, item.payout, item.at);

    // Keep only actual top-five candidates. Ordinary low payouts do not generate extra DB writes.
    if (item.result === "CASHED OUT" && item.payout > 0) {
      const count = Number(this.sql.exec("SELECT COUNT(*) AS count FROM personal_bests").toArray()[0]?.count || 0);
      const lowest = this.sql.exec(`SELECT payout,multiplier FROM personal_bests
        ORDER BY payout ASC,multiplier ASC,created_at DESC LIMIT 1`).toArray()[0];
      const qualifies = count < 5 || !lowest || item.payout > Number(lowest.payout) ||
        (item.payout === Number(lowest.payout) && item.multiplier > Number(lowest.multiplier));
      if (qualifies) {
        this.sql.exec(`INSERT OR IGNORE INTO personal_bests
          (round_id,epoch,round_number,stake,payout,multiplier,net,result,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`, round.id, round.epoch, item.round, item.stake, item.payout,
          item.multiplier, item.net, item.result, item.at);
        this.sql.exec(`DELETE FROM personal_bests WHERE round_id NOT IN (
          SELECT round_id FROM personal_bests ORDER BY payout DESC, multiplier DESC, created_at ASC LIMIT 5
        )`);
      }
    }
  }

  profileData() {
    const row = this.sql.exec("SELECT * FROM session_stats WHERE id=1").toArray()[0] || {};
    const rounds = Number(row.rounds_played || 0);
    const stats = {
      roundsPlayed: rounds,
      wins: Number(row.wins || 0),
      losses: Number(row.losses || 0),
      pushes: Number(row.pushes || 0),
      totalStaked: Number(row.total_staked || 0),
      totalPayout: Number(row.total_payout || 0),
      netResult: Number(row.net_result || 0),
      bestMultiplier: Number(row.best_multiplier || 0),
      bestPayout: Number(row.best_payout || 0),
      winRate: rounds ? (Number(row.wins || 0) / rounds) * 100 : 0
    };
    const leaderboard = this.sql.exec(`SELECT epoch,round_number,stake,payout,multiplier,net,result,created_at
      FROM personal_bests ORDER BY payout DESC,multiplier DESC,created_at ASC LIMIT 5`).toArray();
    return { stats, leaderboard };
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
      if (url.pathname === "/internal/init" && request.method === "POST") return await this.initialize(await readJsonLimited(request));
      if (url.pathname === "/api/state" && request.method === "GET") return this.stateResponse();
      if (url.pathname === "/api/client-seed" && request.method === "POST") return await this.setClientSeed(await readJsonLimited(request));
      if (url.pathname === "/api/round/start" && request.method === "POST") return await this.startRound(await readJsonLimited(request), request.headers.get("idempotency-key"));
      if (url.pathname === "/api/round/release-intent" && request.method === "POST") return await this.releaseIntent(await readJsonLimited(request), request.headers.get("idempotency-key"));
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
      const requestId = crypto.randomUUID();
      // Keep client responses generic; requestId lets operators correlate provider logs.
      return json({ error: "internal_error", requestId }, 500);
    }
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
    return json({ state: this.publicState(state), commitment, epoch: 1, clientSeedRequired: true, profile: this.profileData() });
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
    return json({ state: this.publicState(state), commitment: this.currentCommitment(), epoch: state.currentEpoch, profile: this.profileData() });
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

  async releaseIntent(body, idempotencyKey) {
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
    const cached = this.cachedIdempotent(idempotencyKey, "round-release-intent");
    if (cached) return json(cached);

    const round = this.sql.exec("SELECT id,status FROM rounds WHERE idempotency_key=?", startKey).toArray()[0];
    if (round) {
      let resultResponse;
      if (round.status === "running") {
        const internalCashoutKey = `early_${idempotencyKey}`;
        const settledResponse = await this.cashOut({ roundId: round.id }, internalCashoutKey);
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
      this.sql.exec("DELETE FROM early_release_intents WHERE created_at < ?", now - 60_000);
      const previousIntent = this.sql.exec("SELECT start_key FROM early_release_intents WHERE start_key=?", startKey).toArray()[0];
      if (!previousIntent) {
        this.sql.exec("INSERT INTO early_release_intents(start_key,release_key,released_at,created_at) VALUES(?,?,?,?)",
          startKey, idempotencyKey, now, now);
      }
      this.storeIdempotent(idempotencyKey, "round-release-intent", queued);
      resultResponse = queued;
    });
    return json(resultResponse);
  }

  async startRound(body, idempotencyKey) {
    const state = this.readState();
    if (!state) throw new ApiError(409, "session_not_initialized", "Create a session first.");
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header (16–100 URL-safe characters).");
    // Bound orphaned intents from starts that failed before creating a round, but preserve
    // an intent associated with this same in-flight idempotency key.
    this.sql.exec("DELETE FROM early_release_intents WHERE created_at < ?", Date.now() - 60_000);
    const cached = this.cachedIdempotent(idempotencyKey, "round-start");
    if (cached) return json(cached);
    const existing = this.sql.exec("SELECT response_json FROM rounds WHERE idempotency_key=?", idempotencyKey).toArray()[0];
    if (existing?.response_json) return json(safeParse(existing.response_json, { error: "idempotency_replay" }));
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
    if (duplicateAfterCrypto) return json(duplicateAfterCrypto);

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
      // Keep the replay payload in the idempotency table only; response_json remains for legacy rows.
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
        this.recordSettledRound(roundRecord, settled.historyItem);
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
          profile: this.profileData()
        };
      } else {
        response = { round: roundPayload, state: { balance: latest.balance, roundNumber: latest.roundNumber } };
      }
      this.storeIdempotent(idempotencyKey, "round-start", response);
    });

    if (!response.result) {
      // One Durable Object alarm settles the round if the browser disconnects. Alarm persistence
      // remains on the start path; it must be durable before the server confirms the round.
      try {
        await this.ctx.storage.setAlarm(this.settlementAt({ started_at: startedAt, crash_point: crashPoint }));
      } catch (error) {
        console.error("Round alarm scheduling failed", { roundId, errorName: error?.name || "Error" });
      }
    }
    return json(response.result ? response : { ...response, crashPoint: undefined });
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
    const round = this.sql.exec("SELECT * FROM rounds WHERE id=?", roundId).toArray()[0];
    if (!round) throw new ApiError(404, "round_not_found", "Round was not found.");
    if (round.status !== "running") throw new ApiError(409, "round_not_running", "This round is already settled.");
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - round.started_at) / 1000);
    const liveMultiplier = Math.min(MAX_MULTIPLIER, 1 + elapsedSeconds * GROWTH_PER_SECOND);
    if (liveMultiplier >= round.crash_point) return await this.settleBust(round, state, now, idempotencyKey);
    if (liveMultiplier >= MAX_MULTIPLIER) return json(await this.settleAtCap(round, state, now, idempotencyKey));
    const multiplier = Math.floor(liveMultiplier * 100) / 100;
    const payout = Math.floor(round.stake * multiplier);
    const settled = this.settleRound(round, state, "CASHED OUT", multiplier, payout, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='cashed_out', payout=?, cashed_out_at=? WHERE id=? AND status='running'", payout, now, roundId);
      this.writeState(settled.state);
      this.recordSettledRound(round, settled.historyItem);
      response = { result: "cashed_out", roundId, multiplier, payout, net: settled.historyItem.net,
        state: this.publicState(settled.state, null), historyItem: settled.historyItem,
        repayments: settled.repayments, defaultedLoan: settled.defaultedLoan, profile: this.profileData() };
      this.storeIdempotent(idempotencyKey, "cashout", response);
    });
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
        payout: latest?.payout ?? 0, historyItem, state: this.publicState(currentState), profile: this.profileData() });
    }
    round = latest;
    const currentState = this.readState() || state;
    const settled = this.settleRound(round, currentState, "BUSTED", round.crash_point, 0, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='busted', payout=0, cashed_out_at=? WHERE id=? AND status='running'", now, round.id);
      this.writeState(settled.state);
      this.recordSettledRound(round, settled.historyItem);
      response = { result: "busted", roundId: round.id, crashPoint: round.crash_point, payout: 0,
        net: settled.historyItem.net, state: this.publicState(settled.state, null),
        historyItem: settled.historyItem, repayments: settled.repayments,
        defaultedLoan: settled.defaultedLoan, profile: this.profileData() };
      if (idempotencyKey) this.storeIdempotent(idempotencyKey, "cashout", response);
    });
    this.deferSettlementAlarmCleanup(round.id);
    return json(response);
  }

  async settleAtCap(round, state, now, idempotencyKey = null) {
    const latest = this.sql.exec("SELECT * FROM rounds WHERE id=?", round.id).toArray()[0];
    if (!latest || latest.status !== "running") {
      const currentState = this.readState();
      const historyItem = currentState?.history?.find((item) => item.roundId === round.id) || null;
      return { result: latest?.status || "not_found", roundId: round.id, payout: latest?.payout ?? 0,
        historyItem, state: this.publicState(currentState), profile: this.profileData() };
    }
    round = latest;
    const currentState = this.readState() || state;
    const payout = Math.floor(round.stake * MAX_MULTIPLIER);
    const settled = this.settleRound(round, currentState, "CASHED OUT", MAX_MULTIPLIER, payout, now);
    let response;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE rounds SET status='cashed_out', payout=?, cashed_out_at=? WHERE id=? AND status='running'", payout, now, round.id);
      this.writeState(settled.state);
      this.recordSettledRound(round, settled.historyItem);
      response = { result: "cashed_out", roundId: round.id, multiplier: MAX_MULTIPLIER, payout,
        net: settled.historyItem.net, state: this.publicState(settled.state, null),
        historyItem: settled.historyItem, repayments: settled.repayments,
        defaultedLoan: settled.defaultedLoan, profile: this.profileData() };
      if (idempotencyKey) this.storeIdempotent(idempotencyKey, "cashout", response);
    });
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
      if (liveMultiplier >= round.crash_point) return await this.settleBust(round, state, Date.now());
      if (liveMultiplier >= MAX_MULTIPLIER) return json({ status: "cashed_out", ...await this.settleAtCap(round, state, Date.now()) });
      return json({ status: "running", round: { id: round.id, startedAt: round.started_at, stake: round.stake }, multiplier: Math.floor(liveMultiplier * 100) / 100, serverTime });
    }
    const historyItem = state?.history?.find((item) => item.roundId === id) || null;
    return json({ status: round.status, result: round.status, roundId: id,
      crashPoint: round.status === "busted" ? round.crash_point : undefined,
      multiplier: historyItem?.multiplier, payout: round.payout, net: historyItem?.net,
      cashedOutAt: round.cashed_out_at, historyItem, state: this.publicState(state), profile: this.profileData() });
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
      const response = { state: this.publicState(newState), revealed: { epoch: oldEpoch, serverSeed: oldSeed, commitment: oldSeedRow.commitment }, commitment, epoch: oldEpoch + 1, profile: this.profileData() };
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
    const response = { state: this.publicState(state), gameOver: true, profile: this.profileData() };
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

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
