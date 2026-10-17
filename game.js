import { ApiError, createApiClient } from "./api-client.js";
import { createGameRenderer } from "./game-renderer.js";
import { initGalaxyCanvas } from "./galaxy-background.js";
import { verifyFairnessHistory } from "./fairness-client.js";
import { calculateVisibleMultiplier, estimateServerTime, nextServerTimeAnchor } from "./round-clock.js";
import { readLastReveal as loadLastReveal, readStoredSession, storeLastReveal, storeSession as persistSession } from "./browser-storage.js";

/*
 * gamba — backend-connected browser client
 * The browser renders the game. The Cloudflare Worker owns balance, loans,
 * round settlement, crash point and fairness seeds.
 */
(() => {
  "use strict";

  const API_BASE = String(window.GAMBA_API_BASE || "").replace(/\/+$/, "");
  const SESSION_STORAGE_KEY = "gamba.backend-session.v1";
  const LAST_REVEAL_KEY = "gamba.last-reveal.v1";
  const STARTING_GOLD = 888;
  const GROWTH_PER_SECOND = 0.8;
  const MAX_MULTIPLIER = 10;
  // Lower request traffic; the server alarm settles rounds even when no browser is connected.
  const STATUS_POLL_MS = 1000;
  // If push events are not connected, poll more frequently so a short crash is not hidden
  // for a full second. Keep the slower watchdog while the WebSocket is healthy.
  const STATUS_FALLBACK_POLL_MS = 250;
  const API_REQUEST_TIMEOUT_MS = 12_000;
  const LOANS = {
    444: { principal: 444, repayment: 533, rounds: 8, tier: "STARTER" },
    888: { principal: 888, repayment: 1110, rounds: 6, tier: "STANDARD" },
    1500: { principal: 1500, repayment: 2025, rounds: 4, tier: "HIGHER RISK" }
  };

  const elements = {
    balance: document.getElementById("balance"),
    betInput: document.getElementById("bet-input"),
    betNote: document.getElementById("bet-note"),
    maxButton: document.getElementById("max-button"),
    multiplier: document.getElementById("multiplier"),
    multiplierCaption: document.getElementById("multiplier-caption"),
    meterTrack: document.getElementById("meter-track"),
    meterFill: document.getElementById("meter-fill"),
    roundStatus: document.getElementById("round-status"),
    roundMessage: document.getElementById("round-message"),
    holdButton: document.getElementById("hold-button"),
    holdButtonTitle: document.getElementById("hold-button-title"),
    loanStatus: document.getElementById("loan-status"),
    loanDescription: document.getElementById("loan-description"),
    loanRounds: document.getElementById("loan-rounds"),
    historyList: document.getElementById("history-list"),
    statRounds: document.getElementById("stat-rounds"),
    statWinRate: document.getElementById("stat-win-rate"),
    statNet: document.getElementById("stat-net-result"),
    statBestMultiplier: document.getElementById("stat-best-multiplier"),
    statStaked: document.getElementById("stat-total-staked"),
    statPayout: document.getElementById("stat-total-payout"),
    leaderboardList: document.getElementById("leaderboard-list"),
    bankruptModal: document.getElementById("bankrupt-modal"),
    bankruptKicker: document.getElementById("bankrupt-kicker"),
    bankruptTitle: document.getElementById("bankrupt-title"),
    bankruptCopy: document.getElementById("bankrupt-copy"),
    bankruptActions: document.getElementById("bankrupt-actions"),
    acceptDefeatButton: document.getElementById("accept-defeat-button"),
    bankLoanButton: document.getElementById("bank-loan-button"),
    loanModal: document.getElementById("loan-modal"),
    loanCloseButton: document.getElementById("loan-close-button"),
    loanWarning: document.getElementById("loan-warning"),
    gameoverModal: document.getElementById("gameover-modal"),
    gameoverEyebrow: document.getElementById("gameover-eyebrow"),
    gameoverTitle: document.getElementById("gameover-title"),
    gameoverCopy: document.getElementById("gameover-copy"),
    finalBalance: document.getElementById("final-balance"),
    newGameButton: document.getElementById("new-game-button"),
    fairnessEpoch: document.getElementById("fairness-epoch"),
    fairnessCommitment: document.getElementById("fairness-commitment"),
    fairnessClientSeed: document.getElementById("fairness-client-seed"),
    fairnessMessage: document.getElementById("fairness-message"),
    copyCommitmentButton: document.getElementById("copy-commitment-button"),
    lastRevealPanel: document.getElementById("last-reveal-panel"),
    lastRevealEpoch: document.getElementById("last-reveal-epoch"),
    lastRevealSeed: document.getElementById("last-reveal-seed"),
    lastRevealCommitment: document.getElementById("last-reveal-commitment"),
    verifyFairnessButton: document.getElementById("verify-fairness-button"),
    verifyFairnessStatus: document.getElementById("verify-fairness-status")
  };
  const loanOptionButtons = [...document.querySelectorAll(".loan-option")];
  const quickBetButtons = [...document.querySelectorAll(".quick-bets button")];
  const loanStatusElements = Object.fromEntries(Object.keys(LOANS).map((key) => [key, {
    status: document.getElementById(`loan-${key}-state`),
    details: document.querySelector(`[data-loan-status="${key}"] .loan-availability-main small`)
  }]));

  const game = {
    ready: false,
    initializing: true,
    sessionId: null,
    token: null,
    state: null,
    balance: STARTING_GOLD,
    activeBet: 0,
    multiplier: 1,
    roundStartedAt: 0,
    serverTimeAnchor: null,
    performanceTimeAnchor: null,
    activeRound: null,
    active: false,
    recoveredRound: false,
    startPending: false,
    cashoutPending: false,
    loanPending: false,
    resetPending: false,
    endPending: false,
    releaseRequestedWhileStarting: false,
    startRequestKey: null,
    releaseIntentPromise: null,
    releaseIntentResult: null,
    releaseCashoutKey: null,
    holdSource: null,
    activePointerId: null,
    keyboardCode: null,
    animationFrameId: null,
    pollTimerId: null,
    pollPending: false,
    pollAbortController: null,
    statusFailureCount: 0,
    eventSocket: null,
    eventReconnectTimer: null,
    eventReconnectAttempts: 0,
    pendingSettlementEvent: null,
    settlingRoundId: null,
    lastSettledRoundId: null,
    gameOver: false,
    waitingForLoan: false,
    activeLoans: [],
    loansTaken: { 444: false, 888: false, 1500: false },
    loansRepaid: { 444: false, 888: false, 1500: false },
    history: [],
    profile: { stats: null, leaderboard: [] },
    roundNumber: 0,
    commitment: null,
    epoch: 1,
    clientSeed: null,
    lastReveal: null
  };

  const api = createApiClient({
    baseUrl: API_BASE,
    getToken: () => game.token,
    timeoutMs: API_REQUEST_TIMEOUT_MS
  });

  const renderer = createGameRenderer({
    elements,
    loanOptionButtons,
    quickBetButtons,
    loanStatusElements,
    loans: LOANS,
    maxMultiplier: MAX_MULTIPLIER,
    getGame: () => game,
    formatGold,
    hasUsedAllLoans: () => hasUsedAllLoans()
  });
  const { setMessage, setRoundStatus, renderHistory, renderProfile, updateLoanOptions, updateMultiplierDisplay, updateUI } = renderer;

  function loadStoredSession() {
    try {
      return readStoredSession(localStorage, sessionStorage, SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function loadSavedLastReveal() {
    try {
      return loadLastReveal(localStorage, sessionStorage, LAST_REVEAL_KEY);
    } catch {
      return null;
    }
  }

  function formatGold(amount) {
    return Math.floor(Number(amount) || 0).toLocaleString("en-US");
  }


  function newIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, "");
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function newClientSeed() {
    if (!window.crypto?.getRandomValues) throw new Error("This browser does not provide secure random generation.");
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function getBet() {
    const value = Number(elements.betInput.value);
    if (!Number.isSafeInteger(value) || value < 1 || value > game.balance) return null;
    return value;
  }


  function applyProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    game.profile = {
      stats: profile.stats || game.profile?.stats || null,
      leaderboard: Array.isArray(profile.leaderboard) ? profile.leaderboard : (game.profile?.leaderboard || [])
    };
    renderProfile();
  }

  function hasUsedAllLoans(flags = game.loansTaken) {
    return Object.keys(LOANS).every((principal) => Boolean(flags?.[principal]));
  }

  function getRepaidFlags(state) {
    const flags = { 444: false, 888: false, 1500: false, ...(state?.loansRepaid || {}) };
    for (const item of state?.history || []) {
      for (const repayment of item.repayments || []) flags[repayment.principal] = true;
    }
    return flags;
  }

  function renderFairness() {
    elements.fairnessEpoch.textContent = game.epoch ? "CURRENT SEED" : "—";
    elements.fairnessCommitment.textContent = game.commitment || "Waiting for server commitment…";
    elements.fairnessClientSeed.textContent = game.clientSeed || "Client seed not set";
    elements.copyCommitmentButton.disabled = !game.commitment;
    elements.verifyFairnessButton.disabled = !game.ready;
    elements.fairnessMessage.textContent = game.commitment && game.clientSeed
      ? "No action needed to play. Verify previous rounds after a new game reveals their seed."
      : "Connecting to server…";

    const savedReveal = game.lastReveal || loadSavedLastReveal();
    game.lastReveal = savedReveal;
    if (savedReveal) {
      elements.lastRevealPanel.hidden = false;
      elements.lastRevealEpoch.textContent = `Seed batch ${savedReveal.epoch} · revealed`;
      elements.lastRevealSeed.textContent = savedReveal.serverSeed;
      elements.lastRevealCommitment.textContent = savedReveal.commitment;
    } else {
      elements.lastRevealPanel.hidden = true;
      elements.lastRevealSeed.textContent = "";
      elements.lastRevealCommitment.textContent = "";
    }
  }

  function saveLastReveal(revealed) {
    game.lastReveal = {
      epoch: revealed.epoch,
      serverSeed: revealed.serverSeed,
      commitment: revealed.commitment
    };
    try {
      storeLastReveal(localStorage, sessionStorage, LAST_REVEAL_KEY, game.lastReveal);
    } catch {
      try { sessionStorage.setItem(LAST_REVEAL_KEY, JSON.stringify(game.lastReveal)); } catch { /* Browser storage may be unavailable. */ }
    }
    renderFairness();
  }


  function estimatedServerTime() {
    return estimateServerTime(
      game.serverTimeAnchor,
      game.performanceTimeAnchor,
      performance.now(),
      Date.now()
    );
  }

  function syncServerClock(serverTime) {
    const receivedAt = performance.now();
    const anchor = nextServerTimeAnchor(
      game.serverTimeAnchor,
      game.performanceTimeAnchor,
      serverTime,
      receivedAt
    );
    if (!anchor) return;
    // Keep the visible clock from rewinding when a server response arrives late.
    game.serverTimeAnchor = anchor.serverTimeAnchor;
    game.performanceTimeAnchor = anchor.performanceTimeAnchor;
  }


  function getVisibleMultiplierCents() {
    // Read the exact value already painted to the player, not a newer unrendered frame.
    const match = /^x(\d+(?:\.\d{2})?)$/.exec(elements.multiplier.textContent.trim());
    const visibleMultiplier = match ? Number(match[1]) : game.multiplier;
    return Math.max(100, Math.min(MAX_MULTIPLIER * 100, Math.round(visibleMultiplier * 100)));
  }


  function applyState(state, profile = null, { updateModals = true } = {}) {
    if (!state) throw new Error("Backend returned no game state.");
    game.state = state;
    game.balance = Number(state.balance);
    game.roundNumber = Number(state.roundNumber) || 0;
    game.gameOver = Boolean(state.gameOver);
    game.waitingForLoan = Boolean(state.waitingForLoan);
    game.activeLoans = Array.isArray(state.activeLoans) ? state.activeLoans : [];
    game.loansTaken = { 444: false, 888: false, 1500: false, ...(state.loansTaken || {}) };
    game.loansRepaid = getRepaidFlags(state);
    game.history = Array.isArray(state.history) ? state.history : [];
    game.clientSeed = state.clientSeed || null;
    if (profile) applyProfile(profile);
    renderHistory(game.history);
    updateUI();

    if (!updateModals) return;
    if (game.gameOver && !game.active) {
      showGameOver("GAME OVER", "This game has ended. Start a new game to begin another seed batch.", "Game over", false);
    } else if (game.waitingForLoan && game.balance <= 0 && !game.active) {
      showBankruptcyPrompt();
    } else if (!game.waitingForLoan) {
      elements.bankruptModal.classList.add("hidden");
      elements.loanModal.classList.add("hidden");
    }
  }

  function clearHoldState() {
    game.holdSource = null;
    game.activePointerId = null;
    game.keyboardCode = null;
    elements.holdButton.classList.remove("is-holding");
    elements.holdButton.setAttribute("aria-pressed", "false");
  }

  function stopAnimation() {
    if (game.animationFrameId !== null) cancelAnimationFrame(game.animationFrameId);
    game.animationFrameId = null;
  }

  function stopStatusPolling() {
    if (game.pollTimerId !== null) clearTimeout(game.pollTimerId);
    game.pollTimerId = null;
  }

  function cancelStatusPollingForCashout() {
    stopStatusPolling();
    // Don't let a background status GET compete with the user's release request.
    // It is read-only; aborting it cannot cancel or change the server-side round.
    if (game.pollAbortController) game.pollAbortController.abort();
  }

  function scheduleAnimation() {
    if (game.active && game.activeRound && !game.cashoutPending && game.animationFrameId === null) {
      game.animationFrameId = requestAnimationFrame(updateRoundFrame);
    }
  }

  function updateRoundFrame() {
    game.animationFrameId = null;
    if (!game.active || !game.activeRound || game.cashoutPending) return;
    game.multiplier = calculateVisibleMultiplier(
      estimatedServerTime(),
      game.activeRound.startedAt,
      GROWTH_PER_SECOND,
      MAX_MULTIPLIER
    );
    // This animation is cosmetic. Only the server decides if a cash-out beats the crash.
    updateMultiplierDisplay();
    scheduleAnimation();
  }

  function scheduleStatusPoll() {
    stopStatusPolling();
    if (!game.active || !game.activeRound || document.hidden || game.cashoutPending) return;
    const pushConnected = typeof WebSocket === "function" && game.eventSocket?.readyState === WebSocket.OPEN;
    const baseDelay = pushConnected ? STATUS_POLL_MS : STATUS_FALLBACK_POLL_MS;
    const retryDelay = game.statusFailureCount > 0
      ? Math.min(30_000, baseDelay * (2 ** Math.min(game.statusFailureCount, 5)))
      : baseDelay;
    game.pollTimerId = setTimeout(async () => {
      game.pollTimerId = null;
      await pollRoundStatus();
      if (game.active) scheduleStatusPoll();
    }, retryDelay);
  }

  async function pollRoundStatus() {
    if (!game.active || !game.activeRound || game.pollPending || game.cashoutPending) return;
    game.pollPending = true;
    const roundId = game.activeRound.id;
    const pollController = typeof AbortController === "function" ? new AbortController() : null;
    game.pollAbortController = pollController;
    try {
      const result = await api(`/api/round/status?id=${encodeURIComponent(roundId)}`, {
        ...(pollController ? { signal: pollController.signal } : {})
      });
      game.statusFailureCount = 0;
      if (result.status === "running") {
        // Estimate server clock offset for a smoother display; only server responses settle a round.
        syncServerClock(result.serverTime);
        if (!game.cashoutPending) scheduleAnimation();
        return;
      }
      await finishFromServerResult(result, roundId);
    } catch (error) {
      // Cash-out deliberately aborts a redundant status request. Don't surface that as a network failure.
      if (game.cashoutPending || pollController?.signal.aborted) return;
      game.statusFailureCount = Math.min(game.statusFailureCount + 1, 5);
      const retrySeconds = Math.min(30, (STATUS_POLL_MS * (2 ** game.statusFailureCount)) / 1000);
      setMessage(`Connection interrupted. Your round remains server-controlled. Retrying status in about ${retrySeconds}s. ${error.message}`, "danger");
    } finally {
      if (game.pollAbortController === pollController) game.pollAbortController = null;
      game.pollPending = false;
    }
  }

  async function ensureClientSeed() {
    if (game.clientSeed) return;
    const seed = newClientSeed();
    // Commitment has already been received from /api/session or /api/state.
    const result = await api("/api/client-seed", { method: "POST", body: { clientSeed: seed }, idempotencyKey: newIdempotencyKey() });
    game.clientSeed = result.clientSeed;
    if (result.commitment) game.commitment = result.commitment;
    renderFairness();
  }

  function updateCommitment(snapshot) {
    if (snapshot?.commitment) game.commitment = snapshot.commitment;
    if (snapshot?.epoch) game.epoch = Number(snapshot.epoch);
    renderFairness();
  }

  function activateExistingRound(activeRound, recovered = false) {
    if (!activeRound?.id) return;
    game.activeRound = {
      id: activeRound.id,
      stake: Number(activeRound.stake),
      startedAt: Number(activeRound.startedAt),
      commitment: activeRound.commitment || game.commitment,
      cashoutKey: null
    };
    game.activeBet = Number(activeRound.stake);
    game.roundStartedAt = Number(activeRound.startedAt);
    game.active = true;
    game.recoveredRound = Boolean(recovered);
    game.multiplier = Math.min(MAX_MULTIPLIER, 1 + Math.max(0, (estimatedServerTime() - game.roundStartedAt) / 1000) * GROWTH_PER_SECOND);
    elements.multiplier.classList.add("live");
    elements.multiplier.classList.remove("busted");
    elements.meterTrack.classList.remove("busted");
    elements.holdButtonTitle.textContent = recovered ? "ROUND RECOVERED" : "RELEASE TO CASH OUT";
    elements.multiplierCaption.textContent = recovered
      ? "This round was interrupted. Its committed result will settle automatically; cash-out is disabled after recovery."
      : "Release to cash out at the current multiplier.";
    setRoundStatus("RUNNING", "live");
    setMessage(recovered
      ? "Recovered an interrupted round. To prevent a delayed cash-out advantage, the server will settle it at its committed crash or x10 cap."
      : `Bet placed: ${formatGold(game.activeBet)} gold.`, recovered ? "danger" : "success");
    elements.holdButton.classList.toggle("is-holding", !recovered);
    elements.holdButton.setAttribute("aria-pressed", recovered ? "false" : "true");
    scheduleAnimation();
    scheduleStatusPoll();
    updateUI();
    // A recovered round had no continuous client-side hold. Do not allow a retrospective cash-out;
    // the Durable Object alarm settles it at the committed crash or x10 cap. The status poll only
    // refreshes the displayed result and does not change the outcome.
  }

  function showRecoveredLastResult(state) {
    const item = Array.isArray(state?.history) ? state.history.at(-1) : null;
    if (!item) {
      setMessage("Connected to the game server. Ready to play.");
      return;
    }
    game.multiplier = Math.min(MAX_MULTIPLIER, Math.max(1, Number(item.multiplier) || 1));
    elements.multiplier.classList.remove("live");
    updateMultiplierDisplay();
    if (item.result === "BUSTED") {
      elements.multiplier.classList.add("busted");
      elements.meterTrack.classList.add("busted");
      elements.multiplierCaption.textContent = `Last round crashed at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "BUST";
      setRoundStatus("BUST", "busted");
      setMessage(`Recovered session: round ${item.round} crashed at x${game.multiplier.toFixed(2)}. Lost ${formatGold(item.stake)} gold.`, "danger");
    } else {
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.multiplierCaption.textContent = `Last cash-out at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "HOLD TO START";
      setRoundStatus("LAST ROUND SETTLED");
      const net = Number(item.net) || 0;
      setMessage(`Recovered session: last round paid ${formatGold(item.payout)} gold · net ${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}.`, "success");
    }
  }

  function scheduleEventReconnect() {
    if (game.eventReconnectTimer !== null || !game.token || document.hidden) return;
    const delay = Math.min(15_000, 500 * (2 ** Math.min(game.eventReconnectAttempts, 5)));
    game.eventReconnectAttempts = Math.min(game.eventReconnectAttempts + 1, 5);
    game.eventReconnectTimer = setTimeout(() => {
      game.eventReconnectTimer = null;
      connectRoundEvents();
    }, delay);
  }

  function connectRoundEvents() {
    if (typeof WebSocket !== "function" || !API_BASE || !game.token || document.hidden) return;
    if (game.eventSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(game.eventSocket.readyState)) return;
    const wsBase = API_BASE.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    let socket;
    try {
      // WebSocket cannot set Authorization headers; the Worker verifies this signed token
      // from a subprotocol, never from a query string, then selects only gamba-events-v1.
      socket = new WebSocket(`${wsBase}/api/round/events`, ["gamba-events-v1", `gamba-auth.${game.token}`]);
    } catch {
      scheduleEventReconnect();
      return;
    }
    game.eventSocket = socket;
    socket.addEventListener("open", () => {
      if (game.eventSocket !== socket) return;
      game.eventReconnectAttempts = 0;
      // Switch back to the low-traffic watchdog as soon as push delivery is healthy.
      if (game.active) scheduleStatusPoll();
    });
    socket.addEventListener("message", (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      syncServerClock(payload.serverTime);
      if (payload.type !== "round-settled" || !payload.roundId) return;
      if (game.activeRound?.id === payload.roundId) {
        void finishFromServerResult(payload, payload.roundId);
      } else if (game.startPending && payload.startKey && payload.startKey === game.startRequestKey) {
        // A very fast crash may settle before the start HTTP response reaches this browser.
        game.pendingSettlementEvent = payload;
      }
    });
    socket.addEventListener("close", () => {
      if (game.eventSocket !== socket) return;
      game.eventSocket = null;
      if (game.active) scheduleStatusPoll();
      scheduleEventReconnect();
    });
    socket.addEventListener("error", () => {
      try { socket.close(); } catch { /* close event performs reconnect */ }
    });
  }

  async function initializeBackend() {
    if (!API_BASE) throw new Error("Backend URL is not configured. Open backend-config.js and set GAMBA_API_BASE.");
    const stored = loadStoredSession();
    if (stored) {
      game.sessionId = stored.sessionId;
      game.token = stored.token;
      try {
        const snapshot = await api("/api/state");
        syncServerClock(snapshot.serverTime);
        updateCommitment(snapshot);
        applyState(snapshot.state, snapshot.profile);
        game.ready = true;
        if (!game.clientSeed) {
          await ensureClientSeed();
          if (game.state) game.state.clientSeed = game.clientSeed;
        }
        if (snapshot.state.activeRound) activateExistingRound(snapshot.state.activeRound, true);
        else showRecoveredLastResult(snapshot.state);
        updateUI();
        renderFairness();
        connectRoundEvents();
        return;
      } catch (error) {
        if (error.status !== 401) throw error;
        try { localStorage.removeItem(SESSION_STORAGE_KEY); sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
        game.sessionId = null;
        game.token = null;
      }
    }

    const created = await api("/api/session", { method: "POST", body: {}, auth: false });
    if (!created.token || !created.sessionId || !created.state) throw new Error("The backend returned an incomplete session response.");
    game.sessionId = created.sessionId;
    game.token = created.token;
    try {
      persistSession(localStorage, sessionStorage, SESSION_STORAGE_KEY, {
        sessionId: game.sessionId,
        token: game.token
      });
    } catch {
      setMessage("Persistent storage is unavailable. This game can still run, but reopening the browser may create a new session.", "danger");
    }
    syncServerClock(created.serverTime);
    updateCommitment(created);
    applyState(created.state, created.profile);
    // The session response already contains state/profile. Set the client seed directly to avoid
    // an unnecessary extra Worker + Durable Object request on every new session.
    await ensureClientSeed();
    if (game.state) game.state.clientSeed = game.clientSeed;
    game.ready = true;
    setMessage("Connected securely. Ready to play.", "success");
    updateUI();
    renderFairness();
    connectRoundEvents();
  }

  async function refreshState() {
    const snapshot = await api("/api/state");
    syncServerClock(snapshot.serverTime);
    updateCommitment(snapshot);
    applyState(snapshot.state, snapshot.profile);
    if (snapshot.state.activeRound && (!game.activeRound || game.activeRound.id !== snapshot.state.activeRound.id)) {
      activateExistingRound(snapshot.state.activeRound, true);
    }
    return snapshot.state;
  }

  function sendEarlyReleaseIntent() {
    if (!game.releaseRequestedWhileStarting || !game.startRequestKey || !game.clientSeed || game.releaseIntentPromise) return;
    const releaseKey = newIdempotencyKey();
    const startKey = game.startRequestKey;
    // The server uses this same cash-out key if the parallel release intent finds a running round.
    // Reusing it lets a fallback cash-out replay the original result without a conflict/status round trip.
    game.releaseCashoutKey = `early_${releaseKey}`;
    // Run in parallel with round startup. The Durable Object either queues the release
    // atomically with start, or cashes out an already-committed round directly.
    game.releaseIntentPromise = api("/api/round/release-intent", {
      method: "POST",
      // While startup is pending, the interface remains at x1.00. Keep that visible
      // boundary as the release cap if the round was created before this intent arrives.
      body: { startKey, requestedMultiplierCents: 100 },
      idempotencyKey: releaseKey
    }).then((result) => {
      if (game.startRequestKey === startKey) game.releaseIntentResult = result;
      return result;
    }).catch((error) => {
      const result = { releaseMode: "failed", error };
      if (game.startRequestKey === startKey) game.releaseIntentResult = result;
      return result;
    });
  }

  function clearPendingStartTracking() {
    game.startRequestKey = null;
    game.releaseIntentPromise = null;
    game.releaseIntentResult = null;
    game.releaseCashoutKey = null;
  }

  async function startRound(source, identifier = null) {
    if (!game.ready || game.active || game.startPending || game.gameOver || game.waitingForLoan || game.balance <= 0) return;
    const stake = getBet();
    if (stake === null) {
      elements.betNote.textContent = `Enter a whole number between 1 and ${formatGold(game.balance)}.`;
      elements.betNote.classList.add("error");
      return;
    }

    elements.betNote.textContent = "The server validates and deducts your stake.";
    elements.betNote.classList.remove("error");
    game.startPending = true;
    game.releaseRequestedWhileStarting = false;
    game.multiplier = 1;
    elements.multiplier.classList.remove("busted");
    elements.meterTrack.classList.remove("busted");
    updateMultiplierDisplay();
    game.holdSource = source;
    game.activePointerId = source === "pointer" ? identifier : null;
    game.keyboardCode = source === "keyboard" ? identifier : null;
    elements.holdButtonTitle.textContent = "STARTING ROUND…";
    elements.holdButton.classList.add("is-holding");
    elements.holdButton.setAttribute("aria-pressed", "true");
    setMessage("Starting your round…");
    updateUI();

    const idempotencyKey = newIdempotencyKey();
    game.pendingSettlementEvent = null;
    const roundNumberBeforeStart = game.roundNumber;
    let startRequestWasSent = false;
    game.startRequestKey = idempotencyKey;
    game.releaseIntentPromise = null;
    game.releaseIntentResult = null;
    game.releaseCashoutKey = null;
    try {
      // A previous reset may have succeeded even if registering its client seed timed out.
      // Repair that state before attempting to create a round.
      await ensureClientSeed();
      // If released during seed repair, queue the intent before start is submitted.
      sendEarlyReleaseIntent();
      const startRequest = api("/api/round/start", {
        method: "POST", body: { stake }, idempotencyKey
      });
      startRequestWasSent = true;
      const response = await startRequest;
      syncServerClock(response.serverTime);
      const released = game.releaseRequestedWhileStarting;
      game.startPending = false;

      // The start response itself is authoritative if the queued release was consumed in the
      // start transaction. Do not wait for a slower parallel release-intent response unnecessarily.
      if (response.result && response.roundId && response.state) {
        game.releaseRequestedWhileStarting = false;
        clearPendingStartTracking();
        await finishFromServerResult(response, response.roundId);
        return;
      }
      const pendingSettlement = game.pendingSettlementEvent;
      if (pendingSettlement?.startKey === idempotencyKey && pendingSettlement.roundId === response.round?.id) {
        game.pendingSettlementEvent = null;
        game.releaseRequestedWhileStarting = false;
        clearPendingStartTracking();
        await finishFromServerResult(pendingSettlement, pendingSettlement.roundId);
        return;
      }

      // Use an already-arrived result, but never block the start response on the parallel
      // intent request. If it is still in flight, the regular cash-out request below races it
      // safely through the Durable Object's serialized settlement checks.
      const releaseResult = released ? game.releaseIntentResult : null;
      if (releaseResult?.releaseMode === "settled" && releaseResult.roundId && releaseResult.state) {
        game.releaseRequestedWhileStarting = false;
        clearPendingStartTracking();
        await finishFromServerResult(releaseResult, releaseResult.roundId);
        return;
      }
      game.activeBet = response.round.stake;
      game.balance = response.state.balance;
      game.activeRound = { ...response.round, cashoutKey: released ? game.releaseCashoutKey : null };
      game.roundStartedAt = Number(response.round.startedAt);
        game.active = true;
      game.recoveredRound = false;
      game.multiplier = 1;
      game.lastSettledRoundId = null;
      elements.multiplier.classList.add("live");
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.holdButton.classList.add("is-holding");
      elements.holdButton.setAttribute("aria-pressed", "true");
      elements.holdButtonTitle.textContent = "RELEASE TO CASH OUT";
      elements.multiplierCaption.textContent = "Release to cash out at the current multiplier.";
      setRoundStatus("RUNNING", "live");
      setMessage(`Bet placed: ${formatGold(stake)} gold.`, "success");
      updateUI();
      scheduleAnimation();
      scheduleStatusPoll();
      game.releaseRequestedWhileStarting = false;
      clearPendingStartTracking();
      if (released) await cashOut();
    } catch (error) {
      const wasReleased = game.releaseRequestedWhileStarting;
      const releaseResult = game.releaseIntentResult;
      const releaseCashoutKey = game.releaseCashoutKey;
      game.startPending = false;
      game.releaseRequestedWhileStarting = false;
      clearPendingStartTracking();
      clearHoldState();
      if (wasReleased && releaseResult?.releaseMode === "settled" && releaseResult.roundId && releaseResult.state) {
        await finishFromServerResult(releaseResult, releaseResult.roundId);
        return;
      }

      // A transport/5xx failure can happen after the start transaction committed. Replay the
      // same idempotency key only for uncertain failures; never create a second independent round.
      let replayedStart = null;
      if (startRequestWasSent && (!(error instanceof ApiError) || error.status >= 500)) {
        try {
          replayedStart = await api("/api/round/start", { method: "POST", body: { stake }, idempotencyKey });
        } catch { /* reconcile against state below */ }
      }
      if (replayedStart?.result && replayedStart.roundId && replayedStart.state) {
        await finishFromServerResult(replayedStart, replayedStart.roundId);
        return;
      }
      if (replayedStart?.round?.id) {
        activateExistingRound(replayedStart.round, false);
        if (wasReleased) {
          if (game.activeRound) game.activeRound.cashoutKey = releaseCashoutKey || null;
          await cashOut();
        } else {
          game.holdSource = source;
          game.activePointerId = source === "pointer" ? identifier : null;
          game.keyboardCode = source === "keyboard" ? identifier : null;
          updateUI();
        }
        return;
      }

      try {
        const restored = await refreshState();
        if (restored.activeRound) {
          // State alone cannot identify which tab created the round. Without a matching start-key
          // replay, treat it as recovered and disable retrospective cash-out rather than touching
          // another tab's active round.
          activateExistingRound(restored.activeRound, true);
          setMessage("An active round exists for this session, but this tab could not verify that it started the round. The server will settle it automatically.", "danger");
          return;
        }
        if (wasReleased && Number(restored.roundNumber) > Number(roundNumberBeforeStart)) {
          // The round may have settled even though both start and release responses were lost.
          // refreshState contains the authoritative history and wallet; show that result.
          showRecoveredLastResult(restored);
          return;
        }
      } catch { /* preserve the original request error below */ }
      elements.holdButtonTitle.textContent = "HOLD TO START";
      setRoundStatus("READY");
      setMessage(error.message || "The server could not start the round.", "danger");
      updateUI();
    }
  }

  async function finishFromServerResult(response, roundId) {
    if (!roundId || game.lastSettledRoundId === roundId || game.settlingRoundId === roundId) return;
    let result = response.result || response.status;
    if (result === "running") return;
    game.settlingRoundId = roundId;
    try {
      if (!response.state) {
        const snapshot = await api("/api/state");
        response.state = snapshot.state;
        updateCommitment(snapshot);
      }
    } catch (error) {
      if (game.settlingRoundId === roundId) game.settlingRoundId = null;
      setMessage(`Round settled, but refreshing the wallet failed. Reconnecting… ${error.message}`, "danger");
      void refreshState().catch(() => {});
      return;
    }
    const historyItem = response.historyItem || (response.state.history || []).find((item) => item.roundId === roundId) || null;
    // Settling endpoints include a bust crash point. Avoid a second API request for presentation.
    const crashPoint = response.crashPoint;

    game.lastSettledRoundId = roundId;
    game.active = false;
    game.recoveredRound = false;
    game.cashoutPending = false;
    game.startPending = false;
    stopAnimation();
    stopStatusPolling();
    clearHoldState();
    game.activeRound = null;
    game.activeBet = 0;
    elements.multiplier.classList.remove("live");

    applyState(response.state, response.profile, { updateModals: false });
    const isBust = result === "busted" || result === "BUSTED";
    const multiplier = isBust
      ? (Number.isFinite(Number(crashPoint)) ? Number(crashPoint) : Math.max(1, Number(historyItem?.multiplier) || 1))
      : Number(response.multiplier ?? historyItem?.multiplier ?? MAX_MULTIPLIER);
    game.multiplier = Math.min(MAX_MULTIPLIER, Math.max(1, multiplier));
    updateMultiplierDisplay();

    if (isBust) {
      elements.multiplier.classList.add("busted");
      elements.meterTrack.classList.add("busted");
      elements.multiplierCaption.textContent = `Crashed at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "BUST";
      setRoundStatus("BUST", "busted");
      setMessage(`Crashed at x${game.multiplier.toFixed(2)}. You lost ${formatGold(historyItem?.stake ?? response.state?.history?.at(-1)?.stake ?? 0)} gold.`, "danger");
    } else {
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.multiplierCaption.textContent = `Cashed out at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "HOLD TO START";
      setRoundStatus("CASHED OUT");
      const payout = Number(response.payout ?? historyItem?.payout ?? 0);
      const net = Number(response.net ?? historyItem?.net ?? 0);
      setMessage(`Payout ${formatGold(payout)} gold · net ${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}.`, "success");
    }

    if (response.defaultedLoan || response.state.gameOver) {
      showGameOver("LOAN DEFAULT", "An overdue loan could not be repaid. This game has ended.", "Loan not repaid");
    } else if (response.state.waitingForLoan && response.state.balance <= 0) {
      showBankruptcyPrompt();
    } else {
      elements.bankruptModal.classList.add("hidden");
      elements.loanModal.classList.add("hidden");
    }
    updateUI();
    if (game.settlingRoundId === roundId) game.settlingRoundId = null;
  }

  function showCashoutPending() {
    // Give immediate feedback on release, while keeping the payout itself server-confirmed.
    stopAnimation();
    cancelStatusPollingForCashout();
    elements.holdButtonTitle.textContent = "CASHING OUT…";
    elements.holdButton.classList.remove("is-holding");
    elements.holdButton.setAttribute("aria-pressed", "false");
    setRoundStatus("CASHING OUT");
    setMessage("Release received. Confirming your payout…");
  }

  async function cashOut() {
    if (game.startPending) {
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      sendEarlyReleaseIntent();
      return;
    }
    if (!game.active || !game.activeRound || game.cashoutPending || game.recoveredRound) return;
    const requestedMultiplierCents = getVisibleMultiplierCents();
    game.cashoutPending = true;
    showCashoutPending();
    if (!game.activeRound.cashoutKey) game.activeRound.cashoutKey = newIdempotencyKey();
    const roundId = game.activeRound.id;
    try {
      const response = await api("/api/round/cashout", {
        method: "POST",
        body: { roundId, requestedMultiplierCents },
        idempotencyKey: game.activeRound.cashoutKey
      });
      await finishFromServerResult(response, roundId);
    } catch (error) {
      // The WebSocket can confirm settlement before a slower HTTP cash-out times out.
      // Do not overwrite that result or reopen recovery UI after the round is already done.
      if (game.lastSettledRoundId === roundId || !game.active || game.activeRound?.id !== roundId) return;
      game.cashoutPending = false;
      if (error.status === 409) {
        try {
          const status = await api(`/api/round/status?id=${encodeURIComponent(roundId)}`);
          if (status.status !== "running") {
            await finishFromServerResult(status, roundId);
            return;
          }
        } catch { /* show the original message below */ }
      }
      elements.holdButtonTitle.textContent = "CHECKING RESULT";
      setRoundStatus("CHECKING");
      setMessage(`Cash-out wasn't confirmed yet. Checking the round state. ${error.message}`, "danger");
      await pollRoundStatus();
      if (game.active && !game.cashoutPending) scheduleStatusPoll();
    }
  }

  function releaseHold(source, identifier = null) {
    if (game.startPending && game.holdSource === source) {
      if (source === "pointer" && game.activePointerId !== identifier) return;
      if (source === "keyboard" && game.keyboardCode !== identifier) return;
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      sendEarlyReleaseIntent();
      return;
    }
    if (!game.active || game.holdSource !== source) return;
    if (source === "pointer" && game.activePointerId !== identifier) return;
    if (source === "keyboard" && game.keyboardCode !== identifier) return;
    void cashOut();
  }

  function releaseAnyHold() {
    if (game.startPending && game.holdSource) {
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      sendEarlyReleaseIntent();
      return;
    }
    if (game.active && game.holdSource) {
      void cashOut();
    }
  }

  function focusFirst(container) {
    const focusable = container.querySelector("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])");
    if (focusable) focusable.focus();
  }

  function resetBankruptcyModal() {
    elements.bankruptKicker.textContent = "BALANCE: 0 GOLD";
    elements.bankruptTitle.textContent = "No gold left";
    elements.acceptDefeatButton.textContent = "Accept defeat";
    elements.bankLoanButton.hidden = false;
    elements.bankLoanButton.disabled = false;
    elements.bankruptActions.classList.remove("single-action");
  }

  function showBankruptcyPrompt() {
    if (game.balance > 0 || !game.waitingForLoan || game.gameOver) return;
    resetBankruptcyModal();
    const allTaken = hasUsedAllLoans();
    const overdue = game.activeLoans.filter((loan) => loan.roundsLeft <= 0);
    if (allTaken) {
      elements.bankruptCopy.textContent = "You've used all three loans. Accept defeat to finish this game.";
      elements.bankLoanButton.hidden = true;
      elements.bankruptActions.classList.add("single-action");
    } else if (overdue.length) {
      const due = overdue.reduce((sum, loan) => sum + loan.repayment, 0);
      elements.bankruptCopy.textContent = `Your balance is 0 gold. You can take another available loan, but ${formatGold(due)} gold in overdue repayments must be settled immediately.`;
    } else if (game.activeLoans.length) {
      elements.bankruptCopy.textContent = "Your balance is 0 gold. You can borrow again, but existing repayment deadlines still apply.";
    } else {
      elements.bankruptCopy.textContent = "Your balance is 0 gold. Take an available loan to continue, or end this game.";
    }
    elements.bankruptModal.classList.remove("hidden");
    updateUI();
    focusFirst(elements.bankruptModal);
  }

  function showExhaustedLoansEndState() {
    // Reuse the current dialog: ending a game with no loans left should not open a second modal.
    elements.bankruptKicker.textContent = "GAME OVER";
    elements.bankruptTitle.textContent = "All loans used";
    elements.bankruptCopy.textContent = "You used all three loans and lost the remaining balance.";
    elements.acceptDefeatButton.textContent = "Start new game";
    elements.bankLoanButton.hidden = true;
    elements.bankruptActions.classList.add("single-action");
    elements.bankruptModal.classList.remove("hidden");
    elements.gameoverModal.classList.add("hidden");
    elements.loanModal.classList.add("hidden");
    updateUI();
    elements.acceptDefeatButton.focus();
  }

  function showGameOver(eyebrow, copy, title = "Game over", focus = true) {
    elements.gameoverEyebrow.textContent = eyebrow;
    elements.gameoverTitle.textContent = title;
    elements.gameoverCopy.textContent = copy;
    elements.finalBalance.textContent = `${formatGold(game.balance)} GOLD`;
    elements.gameoverModal.classList.remove("hidden");
    elements.bankruptModal.classList.add("hidden");
    elements.loanModal.classList.add("hidden");
    updateUI();
    if (focus) elements.newGameButton.focus();
  }

  async function acceptDefeat() {
    if (!game.ready || game.endPending || game.active) return;
    game.endPending = true;
    elements.acceptDefeatButton.disabled = true;
    try {
      const response = await api("/api/game/end", { method: "POST", body: {}, idempotencyKey: newIdempotencyKey() });
      // Merge known flags with the response so a partial payload cannot make an empty object
      // accidentally satisfy Array.every() and skip the remaining loan decision.
      const responseLoanFlags = { ...game.loansTaken, ...(response.state?.loansTaken || {}) };
      const allLoansUsed = hasUsedAllLoans(responseLoanFlags);
      if (allLoansUsed) {
        applyState(response.state, response.profile, { updateModals: false });
        elements.bankruptModal.classList.add("hidden");
        elements.loanModal.classList.add("hidden");
        elements.gameoverModal.classList.add("hidden");
        setMessage("All three loans were used. Starting a new game…", "success");
        await startNewGame();
        // If the reset request fails, reuse the same dialog as a retry path instead of opening a second one.
        if (game.gameOver) showExhaustedLoansEndState();
      } else {
        elements.bankruptModal.classList.add("hidden");
        applyState(response.state, response.profile);
        showGameOver("BALANCE DEPLETED", "Your balance reached 0 gold and you chose not to borrow again.", "No gold left");
      }
    } catch (error) {
      setMessage(error.message || "Couldn't end this game on the server.", "danger");
    } finally {
      game.endPending = false;
      elements.acceptDefeatButton.disabled = false;
    }
  }

  function openLoanModal() {
    if (game.balance > 0 || !game.waitingForLoan || game.gameOver || game.active) return;
    if (hasUsedAllLoans()) return;
    updateLoanOptions();
    elements.bankruptModal.classList.add("hidden");
    elements.loanModal.classList.remove("hidden");
    focusFirst(elements.loanModal);
  }

  function closeLoanModal() {
    elements.loanModal.classList.add("hidden");
    if (game.waitingForLoan) {
      elements.bankruptModal.classList.remove("hidden");
      elements.bankLoanButton.focus();
    } else {
      elements.loanCloseButton.focus();
    }
  }

  async function takeLoan(principal) {
    if (!LOANS[principal] || game.loanPending || game.active) return;
    game.loanPending = true;
    updateUI();
    try {
      const response = await api("/api/loan", { method: "POST", body: { principal }, idempotencyKey: newIdempotencyKey() });
      elements.loanModal.classList.add("hidden");
      elements.bankruptModal.classList.add("hidden");
      applyState(response.state, response.profile);
      if (response.defaulted || response.state.gameOver) {
        showGameOver("LOAN DEFAULT", "The overdue repayments could not be settled. This game has ended.", "Loan not repaid");
        return;
      }
      const extension = Number(response.extension) || 0;
      const extText = extension ? ` Existing deadlines and this loan's deadline were extended by ${extension} ${extension === 1 ? "round" : "rounds"}.` : "";
      const immediate = (response.immediateRepayments || []).map((item) => `${formatGold(item.repayment)} gold`).join(" and ");
      const immediateText = immediate ? ` Immediate overdue repayment: ${immediate}.` : "";
      setMessage(`Borrowed ${formatGold(principal)} gold. Repay ${formatGold(response.loan.repayment)} within ${response.loan.roundsLeft} rounds.${extText}${immediateText}`, "success");
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.multiplierCaption.textContent = "Place a bet to start the next round.";
      elements.holdButtonTitle.textContent = "HOLD TO START";
      setRoundStatus("LOAN TAKEN");
      elements.holdButton.focus();
    } catch (error) {
      setMessage(error.message || "The loan request failed.", "danger");
      try { await refreshState(); } catch { /* Keep last known state visible. */ }
      if (game.waitingForLoan) elements.bankruptModal.classList.remove("hidden");
    } finally {
      game.loanPending = false;
      updateUI();
    }
  }

  async function startNewGame() {
    if (!game.ready || game.resetPending || game.active || game.startPending) return;
    game.resetPending = true;
    elements.newGameButton.disabled = true;
    try {
      const reset = await api("/api/game/reset", { method: "POST", body: {}, idempotencyKey: newIdempotencyKey() });
      saveLastReveal(reset.revealed);
      updateCommitment(reset);
      applyState(reset.state, reset.profile);
      await ensureClientSeed();
      if (game.state) game.state.clientSeed = game.clientSeed;
      // Reset already returned complete state/profile; registering the new client seed above is
      // sufficient, so avoid a redundant extra /api/state request.
      elements.gameoverModal.classList.add("hidden");
      elements.bankruptModal.classList.add("hidden");
      elements.loanModal.classList.add("hidden");
      resetBankruptcyModal();
      elements.betInput.value = "88";
      elements.multiplier.classList.remove("busted", "live");
      elements.meterTrack.classList.remove("busted");
      game.multiplier = 1;
      updateMultiplierDisplay();
      elements.multiplierCaption.textContent = "Hold to start. Release to cash out.";
      elements.holdButtonTitle.textContent = "HOLD TO START";
      setRoundStatus("READY");
      setMessage(`New seed batch started. Batch ${reset.revealed.epoch} is now available to verify.`, "success");
      updateUI();
      renderFairness();
      elements.holdButton.focus();
    } catch (error) {
      setMessage(error.message || "Couldn't start a new game on the server.", "danger");
    } finally {
      game.resetPending = false;
      elements.newGameButton.disabled = false;
      updateUI();
    }
  }

  async function verifyRevealedFairness() {
    if (!game.ready) return;
    elements.verifyFairnessButton.disabled = true;
    elements.verifyFairnessStatus.className = "fairness-verification";
    elements.verifyFairnessStatus.textContent = "Checking past rounds…";
    try {
      const report = await verifyFairnessHistory(api, (message) => {
        elements.verifyFairnessStatus.textContent = message;
      });
      const { verifiedSeeds, verifiedRounds, pendingRounds, failures } = report;
      if (failures.length) {
        elements.verifyFairnessStatus.textContent = `VERIFICATION FAILED (${failures.length} issue(s)): ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? "; more issues omitted" : ""}`;
        elements.verifyFairnessStatus.classList.add("is-error");
      } else if (!verifiedSeeds) {
        elements.verifyFairnessStatus.textContent = `No seed has been revealed yet. ${pendingRounds} round(s) can be checked after you start a new game.`;
      } else {
        elements.verifyFairnessStatus.textContent = `PASS · ${verifiedSeeds} seed batch(es), ${verifiedRounds} round(s) checked. ${pendingRounds} current round(s) await seed reveal.`;
        elements.verifyFairnessStatus.classList.add("is-success");
      }
    } catch (error) {
      elements.verifyFairnessStatus.textContent = `Couldn't verify the complete history: ${error.message}`;
      elements.verifyFairnessStatus.classList.add("is-error");
    } finally {
      elements.verifyFairnessButton.disabled = false;
    }
  }

  // Input controls are only for selecting a stake; the server validates it again.
  elements.betInput.addEventListener("input", () => {
    const bet = getBet();
    if (bet !== null) {
      elements.betNote.textContent = "The server validates and deducts your stake.";
      elements.betNote.classList.remove("error");
    } else if (elements.betInput.value !== "") {
      elements.betNote.textContent = `Enter a whole number between 1 and ${formatGold(game.balance)}.`;
      elements.betNote.classList.add("error");
    }
  });

  elements.maxButton.addEventListener("click", () => {
    elements.betInput.value = String(game.balance);
    elements.betInput.dispatchEvent(new Event("input"));
  });

  quickBetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const fraction = Number(button.dataset.fraction);
      const amount = Math.max(1, Math.floor(game.balance * fraction));
      elements.betInput.value = String(amount);
      elements.betInput.dispatchEvent(new Event("input"));
    });
  });

  // Suppress mobile text selection/context menus on the hold surface. CSS also disables
  // selection on descendants for Safari's touch-selection behavior.
  for (const eventName of ["selectstart", "contextmenu", "dragstart"]) {
    elements.holdButton.addEventListener(eventName, (event) => event.preventDefault());
  }

  // Capture starts on pointerdown; network settlement is asynchronous and server-authoritative.
  elements.holdButton.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    if (game.active) return;
    void startRound("pointer", event.pointerId);
    if (game.startPending && game.holdSource === "pointer" && elements.holdButton.setPointerCapture) {
      try { elements.holdButton.setPointerCapture(event.pointerId); } catch { /* window release handlers are the fallback */ }
    }
  });

  window.addEventListener("pointerup", (event) => releaseHold("pointer", event.pointerId));
  window.addEventListener("pointercancel", (event) => releaseHold("pointer", event.pointerId));
  elements.holdButton.addEventListener("lostpointercapture", (event) => releaseHold("pointer", event.pointerId));
  elements.holdButton.addEventListener("keydown", (event) => {
    if (event.code !== "Space" && event.code !== "Enter") return;
    event.preventDefault();
    if (!event.repeat && !game.active && !game.startPending) void startRound("keyboard", event.code);
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.code === "Enter") releaseHold("keyboard", event.code);
  });
  window.addEventListener("blur", releaseAnyHold);
  window.addEventListener("pagehide", releaseAnyHold);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAnyHold();
      stopStatusPolling();
    } else {
      connectRoundEvents();
      if (game.active && game.activeRound) {
        // Reconcile immediately after backgrounding; WebSocket terminal events provide the
        // low-latency path, while status polling remains the resilience fallback.
        void pollRoundStatus().finally(() => { if (game.active) scheduleStatusPoll(); });
      }
    }
  });

  elements.acceptDefeatButton.addEventListener("click", () => {
    if (game.gameOver) void startNewGame();
    else void acceptDefeat();
  });
  elements.bankLoanButton.addEventListener("click", openLoanModal);
  elements.loanCloseButton.addEventListener("click", closeLoanModal);
  loanOptionButtons.forEach((button) => {
    button.addEventListener("click", () => void takeLoan(Number(button.dataset.loan)));
  });
  elements.newGameButton.addEventListener("click", () => void startNewGame());
  elements.copyCommitmentButton.addEventListener("click", async () => {
    if (!game.commitment) return;
    try {
      await navigator.clipboard.writeText(game.commitment);
      elements.fairnessMessage.textContent = "Commitment copied.";
    } catch {
      elements.fairnessMessage.textContent = "Clipboard access was blocked. Select and copy the commitment text manually.";
    }
  });
  elements.verifyFairnessButton.addEventListener("click", () => void verifyRevealedFairness());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.loanModal.classList.contains("hidden")) closeLoanModal();
  });

  async function boot() {
    game.lastReveal = loadSavedLastReveal();
    renderFairness();
    updateUI();
    try {
      await initializeBackend();
      game.initializing = false;
      game.ready = true;
      updateUI();
      renderFairness();
    } catch (error) {
      game.initializing = false;
      game.ready = false;
      elements.holdButton.disabled = true;
      elements.betInput.disabled = true;
      setRoundStatus("OFFLINE");
      setMessage(`Couldn't connect to the game server: ${error.message}`, "danger");
      elements.fairnessMessage.textContent = "Backend connection failed. The game is paused rather than falling back to local randomness.";
      updateUI();
    }
  }

  initGalaxyCanvas();
  void boot();
})();
