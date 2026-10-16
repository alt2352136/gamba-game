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
    meterWobble: document.getElementById("meter-wobble"),
    roundStatus: document.getElementById("round-status"),
    roundMessage: document.getElementById("round-message"),
    holdButton: document.getElementById("hold-button"),
    holdButtonTitle: document.getElementById("hold-button-title"),
    holdButtonSubtitle: document.getElementById("hold-button-subtitle"),
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
    bankruptCopy: document.getElementById("bankrupt-copy"),
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
    serverClockOffset: 0,
    activeRound: null,
    active: false,
    recoveredRound: false,
    startPending: false,
    cashoutPending: false,
    loanPending: false,
    resetPending: false,
    endPending: false,
    releaseRequestedWhileStarting: false,
    holdSource: null,
    activePointerId: null,
    keyboardCode: null,
    animationFrameId: null,
    pollTimerId: null,
    pollPending: false,
    statusFailureCount: 0,
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

  class ApiError extends Error {
    constructor(status, data, rawText = "") {
      super(data?.message || data?.error || `Backend request failed (HTTP ${status}).`);
      this.name = "ApiError";
      this.status = status;
      this.code = data?.error || "http_error";
      this.data = data;
      this.rawText = rawText;
    }
  }

  function formatGold(amount) {
    return Math.floor(Number(amount) || 0).toLocaleString("en-US");
  }

  function setMessage(message, type = "") {
    elements.roundMessage.className = "round-message";
    if (type) elements.roundMessage.classList.add(type);
    elements.roundMessage.textContent = message;
  }

  function setRoundStatus(text, state = "") {
    elements.roundStatus.textContent = text;
    elements.roundStatus.classList.toggle("is-live", state === "live");
    elements.roundStatus.classList.toggle("is-busted", state === "busted");
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

  function parseStoredSession(storage) {
    try {
      const value = storage.getItem(SESSION_STORAGE_KEY);
      const parsed = value ? JSON.parse(value) : null;
      return parsed && typeof parsed.token === "string" && typeof parsed.sessionId === "string" ? parsed : null;
    } catch { return null; }
  }

  function readStoredSession() {
    try {
      const persistent = parseStoredSession(localStorage);
      if (persistent) return persistent;
      // Migrate a session from the earlier tab-only build so an update doesn't strand it.
      const legacy = parseStoredSession(sessionStorage);
      if (legacy) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(legacy));
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return legacy;
      }
    } catch { /* Storage may be disabled; a fresh in-memory session can still be created. */ }
    return null;
  }

  function storeSession() {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ sessionId: game.sessionId, token: game.token }));
      try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* migrated when available */ }
    } catch {
      setMessage("Persistent storage is unavailable. This game can still run, but reopening the browser may create a new session.", "danger");
    }
  }

  async function api(path, options = {}) {
    if (!API_BASE) throw new Error("Backend URL is not configured. Check backend-config.js.");
    const method = options.method || "GET";
    const headers = new Headers();
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.auth !== false && game.token) headers.set("authorization", `Bearer ${game.token}`);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

    const requestOptions = {
      method,
      headers,
      cache: "no-store"
    };
    if (options.body !== undefined) requestOptions.body = JSON.stringify(options.body);

    const maxAttempts = options.idempotencyKey ? 2 : 1;
    let lastNetworkError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(`${API_BASE}${path}`, requestOptions);
      } catch (error) {
        lastNetworkError = error;
        if (attempt + 1 < maxAttempts) continue; // Retry only idempotent actions with the same key.
        throw new Error("Couldn't reach the game server. Check your connection and try again.");
      }

      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep text for the error */ }
      if (!response.ok) throw new ApiError(response.status, data, text);
      return data || {};
    }
    throw lastNetworkError || new Error("Game server request failed.");
  }

  function getBet() {
    const value = Number(elements.betInput.value);
    if (!Number.isSafeInteger(value) || value < 1 || value > game.balance) return null;
    return value;
  }

  function renderHistory(history) {
    const recent = [...(history || [])].reverse().slice(0, 10);
    elements.historyList.replaceChildren();
    if (!recent.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Completed rounds will appear here.";
      elements.historyList.append(empty);
      return;
    }

    for (const item of recent) {
      const row = document.createElement("div");
      row.className = "history-item";
      const left = document.createElement("div");
      left.className = "history-left";
      const title = document.createElement("strong");
      const resultLabel = item.result === "BUSTED" ? "BUST" : item.result === "CASHED OUT" ? "CASH OUT" : String(item.result || "ROUND");
      title.textContent = `ROUND ${String(item.round).padStart(2, "0")} · ${resultLabel}`;
      const details = document.createElement("small");
      details.textContent = `${item.result === "BUSTED" ? "Crash" : "Cash-out"} x${Math.max(1, Number(item.multiplier) || 1).toFixed(2)} · Stake ${formatGold(item.stake)} · Payout ${formatGold(item.payout)}`;
      left.append(title, details);

      const repayments = Array.isArray(item.repayments) ? item.repayments : [];
      if (repayments.length) {
        const repayment = document.createElement("small");
        repayment.className = "history-loan-note";
        repayment.textContent = repayments.map((loan) => `${formatGold(loan.principal)} loan repaid ${formatGold(loan.repayment)}`).join(" · ");
        left.append(repayment);
      }

      const right = document.createElement("div");
      right.className = "history-right";
      const multiplier = document.createElement("span");
      multiplier.className = "history-multiplier";
      multiplier.textContent = `x${Math.max(0, Number(item.multiplier) || 0).toFixed(2)}`;
      const change = document.createElement("span");
      change.className = `history-change ${(Number(item.net) || 0) >= 0 ? "positive" : "negative"}`;
      const net = Number(item.net) || 0;
      change.textContent = `${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}`;
      right.append(multiplier, change);
      row.append(left, right);
      elements.historyList.append(row);
    }
  }

  function renderProfile(profile = game.profile) {
    if (!profile || !elements.statRounds) return;
    const stats = profile.stats || {};
    const leaderboard = Array.isArray(profile.leaderboard) ? profile.leaderboard.slice(0, 5) : [];
    elements.statRounds.textContent = formatGold(stats.roundsPlayed || 0);
    elements.statWinRate.textContent = `${(Number(stats.winRate) || 0).toFixed(1)}%`;
    const net = Number(stats.netResult) || 0;
    elements.statNet.textContent = `${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}`;
    elements.statNet.classList.toggle("positive", net >= 0);
    elements.statNet.classList.toggle("negative", net < 0);
    elements.statBestMultiplier.textContent = Number(stats.bestMultiplier) > 0 ? `x${Number(stats.bestMultiplier).toFixed(2)}` : "—";
    elements.statStaked.textContent = formatGold(stats.totalStaked || 0);
    elements.statPayout.textContent = formatGold(stats.totalPayout || 0);
    elements.leaderboardList.replaceChildren();
    if (!leaderboard.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Your best cash-outs will appear here.";
      elements.leaderboardList.append(empty);
      return;
    }
    leaderboard.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "leaderboard-item";
      const rank = document.createElement("span");
      rank.className = "leaderboard-rank";
      rank.textContent = `0${index + 1}`;
      const detail = document.createElement("div");
      detail.className = "leaderboard-detail";
      const title = document.createElement("strong");
      title.textContent = `x${Number(item.multiplier).toFixed(2)} · Batch ${item.epoch}, round ${item.round_number}`;
      const sub = document.createElement("small");
      sub.textContent = `Stake ${formatGold(item.stake)} · net ${Number(item.net) >= 0 ? "+" : "−"}${formatGold(Math.abs(Number(item.net) || 0))}`;
      detail.append(title, sub);
      const payout = document.createElement("strong");
      payout.className = "leaderboard-payout";
      payout.textContent = `${formatGold(item.payout)} G`;
      row.append(rank, detail, payout);
      elements.leaderboardList.append(row);
    });
  }

  function applyProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    game.profile = {
      stats: profile.stats || game.profile?.stats || null,
      leaderboard: Array.isArray(profile.leaderboard) ? profile.leaderboard : (game.profile?.leaderboard || [])
    };
    renderProfile();
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

    const savedReveal = game.lastReveal || readLastReveal();
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

  function readLastReveal() {
    try {
      const text = localStorage.getItem(LAST_REVEAL_KEY) || sessionStorage.getItem(LAST_REVEAL_KEY);
      const reveal = text ? JSON.parse(text) : null;
      return reveal && reveal.serverSeed && reveal.commitment ? reveal : null;
    } catch { return null; }
  }

  function saveLastReveal(revealed) {
    game.lastReveal = {
      epoch: revealed.epoch,
      serverSeed: revealed.serverSeed,
      commitment: revealed.commitment
    };
    try { localStorage.setItem(LAST_REVEAL_KEY, JSON.stringify(game.lastReveal)); } catch { try { sessionStorage.setItem(LAST_REVEAL_KEY, JSON.stringify(game.lastReveal)); } catch { /* The API remains authoritative if storage is unavailable. */ } }
    renderFairness();
  }

  function updateLoanOptions() {
    const canBorrow = game.ready && game.waitingForLoan && game.balance <= 0 && !game.gameOver && !game.active;
    document.querySelectorAll(".loan-option").forEach((button) => {
      const principal = Number(button.dataset.loan);
      const loan = LOANS[principal];
      const taken = Boolean(game.loansTaken[principal]);
      const activeLoan = game.activeLoans.some((item) => item.principal === principal);
      const repaid = Boolean(game.loansRepaid[principal]);
      const tier = button.querySelector(".loan-tier");
      button.disabled = !canBorrow || taken || game.loanPending;
      tier.textContent = activeLoan ? "ACTIVE LOAN" : repaid ? "REPAID" : taken ? "USED THIS GAME" : loan.tier;
      button.classList.toggle("loan-taken", taken);
    });

    Object.keys(LOANS).forEach((key) => {
      const principal = Number(key);
      const loan = LOANS[principal];
      const status = document.getElementById(`loan-${principal}-state`);
      const activeLoan = game.activeLoans.find((item) => item.principal === principal);
      const taken = Boolean(game.loansTaken[principal]);
      const repaid = Boolean(game.loansRepaid[principal]);
      const details = document.querySelector(`[data-loan-status="${principal}"] .loan-availability-main small`);
      status.textContent = activeLoan ? "ACTIVE" : repaid ? "REPAID" : taken ? "USED" : "AVAILABLE";
      status.classList.toggle("is-active", Boolean(activeLoan));
      status.classList.toggle("is-used", taken && !activeLoan && !repaid);
      status.classList.toggle("is-repaid", repaid);
      if (activeLoan) details.textContent = `Repay ${formatGold(activeLoan.repayment)} · ${activeLoan.roundsLeft} ${activeLoan.roundsLeft === 1 ? "round" : "rounds"} left`;
      else if (repaid) details.textContent = `Repaid ${formatGold(loan.repayment)} gold`;
      else details.textContent = `Repay ${formatGold(loan.repayment)} · ${loan.rounds}-round deadline`;
    });

    const allTaken = Object.values(game.loansTaken).every(Boolean);
    if (allTaken) elements.loanWarning.textContent = "All three loans have been used in this game.";
    else if (game.activeLoans.length) elements.loanWarning.textContent = "Taking another loan extends existing deadlines according to the displayed rules.";
    else elements.loanWarning.textContent = "Larger loans have higher fees and shorter deadlines.";
    elements.bankLoanButton.disabled = !canBorrow || allTaken || game.loanPending;
  }

  function updateMultiplierDisplay() {
    elements.multiplier.textContent = `x${game.multiplier.toFixed(2)}`;
    elements.meterTrack.setAttribute("aria-valuenow", game.multiplier.toFixed(2));
    const progress = ((game.multiplier - 1) / (MAX_MULTIPLIER - 1)) * 100;
    const clamped = Math.max(0, Math.min(100, progress));
    elements.meterFill.style.width = `${clamped}%`;
    // Keep the endpoint marker locked to the actual fill edge. A cosmetic wobble
    // makes the progress line appear to detach from its marker.
    const trackWidth = elements.meterTrack.clientWidth;
    const markerRadius = 3.5;
    const endpoint = trackWidth * clamped / 100;
    const markerX = trackWidth > markerRadius * 2
      ? Math.max(markerRadius, Math.min(trackWidth - markerRadius, endpoint))
      : endpoint;
    elements.meterWobble.style.left = `${markerX}px`;
    elements.meterTrack.classList.toggle("is-running", game.active);
    elements.meterTrack.classList.toggle("busted", elements.multiplier.classList.contains("busted"));
  }

  function updateUI() {
    elements.balance.textContent = formatGold(game.balance);
    elements.betInput.max = String(game.balance);
    updateMultiplierDisplay();
    if (game.activeLoans.length) {
      const due = game.activeLoans.reduce((sum, loan) => sum + loan.repayment, 0);
      const nearest = Math.min(...game.activeLoans.map((loan) => loan.roundsLeft));
      elements.loanStatus.textContent = `${game.activeLoans.length} ACTIVE`;
      elements.loanDescription.textContent = `Outstanding: ${formatGold(due)} gold`;
      elements.loanRounds.textContent = `${nearest} ${nearest === 1 ? "round" : "rounds"} to deadline`;
    } else {
      elements.loanStatus.textContent = Object.values(game.loansRepaid).some(Boolean) ? "REPAID" : "NONE";
      elements.loanDescription.textContent = "No active loans";
      elements.loanRounds.textContent = "—";
    }
    const canPlay = game.ready && !game.gameOver && !game.waitingForLoan && game.balance > 0 && !game.startPending && !game.initializing;
    elements.holdButton.disabled = !game.ready || game.initializing || game.recoveredRound || (!game.active && (game.gameOver || game.waitingForLoan || game.balance <= 0));
    elements.betInput.disabled = !canPlay || game.active;
    elements.maxButton.disabled = !canPlay || game.active;
    document.querySelectorAll(".quick-bets button").forEach((button) => { button.disabled = !canPlay || game.active; });
    updateLoanOptions();
  }

  function applyState(state, profile = null) {
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

  function scheduleAnimation() {
    if (game.active && game.activeRound && !game.cashoutPending && game.animationFrameId === null) {
      game.animationFrameId = requestAnimationFrame(updateRoundFrame);
    }
  }

  function updateRoundFrame() {
    game.animationFrameId = null;
    if (!game.active || !game.activeRound || game.cashoutPending) return;
    const elapsed = Math.max(0, (Date.now() + game.serverClockOffset - Number(game.activeRound.startedAt)) / 1000);
    game.multiplier = Math.min(MAX_MULTIPLIER, 1 + elapsed * GROWTH_PER_SECOND);
    // This animation is cosmetic. Only the server decides if a cash-out beats the crash.
    updateMultiplierDisplay();
    scheduleAnimation();
  }

  function scheduleStatusPoll() {
    stopStatusPolling();
    if (!game.active || !game.activeRound || document.hidden || game.cashoutPending) return;
    const retryDelay = game.statusFailureCount > 0
      ? Math.min(30_000, STATUS_POLL_MS * (2 ** Math.min(game.statusFailureCount, 5)))
      : STATUS_POLL_MS;
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
    try {
      const result = await api(`/api/round/status?id=${encodeURIComponent(roundId)}`);
      game.statusFailureCount = 0;
      if (result.status === "running") {
        // Estimate server clock offset for a smoother display; only server responses settle a round.
        if (Number.isFinite(Number(result.serverTime))) game.serverClockOffset = Number(result.serverTime) - Date.now();
        if (!game.cashoutPending) scheduleAnimation();
        return;
      }
      await finishFromServerResult(result, roundId);
    } catch (error) {
      game.statusFailureCount = Math.min(game.statusFailureCount + 1, 5);
      const retrySeconds = Math.min(30, (STATUS_POLL_MS * (2 ** game.statusFailureCount)) / 1000);
      setMessage(`Connection interrupted. Your round remains server-controlled. Retrying status in about ${retrySeconds}s. ${error.message}`, "danger");
    } finally {
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
    game.multiplier = Math.min(MAX_MULTIPLIER, 1 + Math.max(0, (Date.now() - game.roundStartedAt) / 1000) * GROWTH_PER_SECOND);
    elements.multiplier.classList.add("live");
    elements.multiplier.classList.remove("busted");
    elements.meterTrack.classList.remove("busted");
    elements.holdButtonTitle.textContent = recovered ? "ROUND RECOVERED" : "ROUND IN PROGRESS";
    elements.holdButtonSubtitle.textContent = recovered ? "Server will settle automatically" : "Release to cash out";
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
      setMessage("Connected to the game server. Place a bet, then hold to start.");
      return;
    }
    game.multiplier = Math.min(MAX_MULTIPLIER, Math.max(1, Number(item.multiplier) || 1));
    elements.multiplier.classList.remove("live");
    elements.meterTrack.classList.remove("is-running");
    updateMultiplierDisplay();
    if (item.result === "BUSTED") {
      elements.multiplier.classList.add("busted");
      elements.meterTrack.classList.add("busted");
      elements.multiplierCaption.textContent = `Last round crashed at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "BUST";
      elements.holdButtonSubtitle.textContent = "Last round settled by server";
      setRoundStatus("BUST", "busted");
      setMessage(`Recovered session: round ${item.round} crashed at x${game.multiplier.toFixed(2)}. Lost ${formatGold(item.stake)} gold.`, "danger");
    } else {
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.multiplierCaption.textContent = `Last cash-out at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "HOLD TO START";
      elements.holdButtonSubtitle.textContent = "Release to cash out";
      setRoundStatus("LAST ROUND SETTLED");
      const net = Number(item.net) || 0;
      setMessage(`Recovered session: last round paid ${formatGold(item.payout)} gold · net ${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}.`, "success");
    }
  }

  async function initializeBackend() {
    if (!API_BASE) throw new Error("Backend URL is not configured. Open backend-config.js and set GAMBA_API_BASE.");
    const stored = readStoredSession();
    if (stored) {
      game.sessionId = stored.sessionId;
      game.token = stored.token;
      try {
        const snapshot = await api("/api/state");
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
    storeSession();
    updateCommitment(created);
    applyState(created.state, created.profile);
    // The session response already contains state/profile. Set the client seed directly to avoid
    // an unnecessary extra Worker + Durable Object request on every new session.
    await ensureClientSeed();
    if (game.state) game.state.clientSeed = game.clientSeed;
    game.ready = true;
    setMessage("Connected securely. Place a bet, then hold to start.", "success");
    updateUI();
    renderFairness();
  }

  async function refreshState() {
    const snapshot = await api("/api/state");
    updateCommitment(snapshot);
    applyState(snapshot.state, snapshot.profile);
    if (snapshot.state.activeRound && (!game.activeRound || game.activeRound.id !== snapshot.state.activeRound.id)) {
      activateExistingRound(snapshot.state.activeRound, true);
    }
    return snapshot.state;
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
    game.holdSource = source;
    game.activePointerId = source === "pointer" ? identifier : null;
    game.keyboardCode = source === "keyboard" ? identifier : null;
    elements.holdButtonTitle.textContent = "STARTING ROUND…";
    elements.holdButtonSubtitle.textContent = "Placing your bet";
    elements.holdButton.classList.add("is-holding");
    elements.holdButton.setAttribute("aria-pressed", "true");
    setMessage("Starting your round…");
    updateUI();

    const idempotencyKey = newIdempotencyKey();
    try {
      const response = await api("/api/round/start", { method: "POST", body: { stake }, idempotencyKey });
      game.startPending = false;
      game.activeBet = response.round.stake;
      game.balance = response.state.balance;
      game.activeRound = { ...response.round, cashoutKey: null };
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
      elements.holdButtonTitle.textContent = "ROUND IN PROGRESS";
      elements.holdButtonSubtitle.textContent = "Release to cash out";
      elements.multiplierCaption.textContent = "Release to cash out at the current multiplier.";
      setRoundStatus("RUNNING", "live");
      setMessage(`Bet placed: ${formatGold(stake)} gold.`, "success");
      updateUI();
      scheduleAnimation();
      scheduleStatusPoll();
      const released = game.releaseRequestedWhileStarting;
      game.releaseRequestedWhileStarting = false;
      if (released) await cashOut();
    } catch (error) {
      game.startPending = false;
      const wasReleased = game.releaseRequestedWhileStarting;
      game.releaseRequestedWhileStarting = false;
      clearHoldState();
      try {
        const restored = await refreshState();
        if (restored.activeRound) {
          // The start POST may have committed even if its response was lost. Reattach the original
          // hold only when it was never released; otherwise this is the user's original cash-out.
          if (wasReleased) {
            game.recoveredRound = false;
            await cashOut();
          } else {
            game.recoveredRound = false;
            game.holdSource = source;
            game.activePointerId = source === "pointer" ? identifier : null;
            game.keyboardCode = source === "keyboard" ? identifier : null;
            elements.holdButton.disabled = false;
            elements.holdButton.classList.add("is-holding");
            elements.holdButton.setAttribute("aria-pressed", "true");
            elements.holdButtonTitle.textContent = "ROUND IN PROGRESS";
            elements.holdButtonSubtitle.textContent = "Release to cash out";
            updateUI();
          }
          return;
        }
      } catch { /* preserve the original request error below */ }
      elements.holdButtonTitle.textContent = "HOLD TO START";
      elements.holdButtonSubtitle.textContent = "Release to cash out";
      setRoundStatus("READY");
      setMessage(error.message || "The server could not start the round.", "danger");
      updateUI();
    }
  }

  async function finishFromServerResult(response, roundId) {
    if (!roundId || game.lastSettledRoundId === roundId) return;
    let result = response.result || response.status;
    if (result === "running") return;
    if (!response.state) {
      const snapshot = await api("/api/state");
      response.state = snapshot.state;
      updateCommitment(snapshot);
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
    elements.meterTrack.classList.remove("is-running");

    applyState(response.state, response.profile);
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
      elements.holdButtonSubtitle.textContent = "The stake was lost";
      setRoundStatus("BUST", "busted");
      setMessage(`Crashed at x${game.multiplier.toFixed(2)}. You lost ${formatGold(historyItem?.stake ?? response.state?.history?.at(-1)?.stake ?? 0)} gold.`, "danger");
    } else {
      elements.multiplier.classList.remove("busted");
      elements.meterTrack.classList.remove("busted");
      elements.multiplierCaption.textContent = `Cashed out at x${game.multiplier.toFixed(2)}.`;
      elements.holdButtonTitle.textContent = "HOLD TO START";
      elements.holdButtonSubtitle.textContent = "Release to cash out";
      setRoundStatus("CASHED OUT");
      const payout = Number(response.payout ?? historyItem?.payout ?? 0);
      const net = Number(response.net ?? historyItem?.net ?? 0);
      setMessage(`Payout ${formatGold(payout)} gold · net ${net >= 0 ? "+" : "−"}${formatGold(Math.abs(net))}.`, "success");
    }

    if (response.defaultedLoan || response.state.gameOver) {
      showGameOver("LOAN DEFAULT", "An overdue loan could not be repaid. This game has ended.", "Loan not repaid");
    } else if (response.state.waitingForLoan && response.state.balance <= 0) {
      showBankruptcyPrompt();
    }
    updateUI();
  }

  function showCashoutPending() {
    // Give immediate feedback on release, while keeping the payout itself server-confirmed.
    stopAnimation();
    stopStatusPolling();
    elements.holdButtonTitle.textContent = "CASHING OUT…";
    elements.holdButtonSubtitle.textContent = "Confirming payout";
    elements.holdButton.classList.remove("is-holding");
    elements.holdButton.setAttribute("aria-pressed", "false");
    setRoundStatus("CASHING OUT");
    setMessage("Release received. Confirming your payout…");
  }

  async function cashOut() {
    if (game.startPending) {
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      return;
    }
    if (!game.active || !game.activeRound || game.cashoutPending || game.recoveredRound) return;
    game.cashoutPending = true;
    showCashoutPending();
    if (!game.activeRound.cashoutKey) game.activeRound.cashoutKey = newIdempotencyKey();
    const roundId = game.activeRound.id;
    try {
      const response = await api("/api/round/cashout", {
        method: "POST",
        body: { roundId },
        idempotencyKey: game.activeRound.cashoutKey
      });
      await finishFromServerResult(response, roundId);
    } catch (error) {
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
      elements.holdButtonSubtitle.textContent = "Waiting for server confirmation";
      setRoundStatus("CHECKING");
      setMessage(`Cash-out wasn't confirmed yet. Checking the round state. ${error.message}`, "danger");
      await pollRoundStatus();
    }
  }

  function releaseHold(source, identifier = null) {
    if (game.startPending && game.holdSource === source) {
      if (source === "pointer" && game.activePointerId !== identifier) return;
      if (source === "keyboard" && game.keyboardCode !== identifier) return;
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      return;
    }
    if (!game.active || game.holdSource !== source) return;
    if (source === "pointer" && game.activePointerId !== identifier) return;
    if (source === "keyboard" && game.keyboardCode !== identifier) return;
    void cashOut();
  }

  function releaseAnyHold() {
    if (game.startPending) {
      game.releaseRequestedWhileStarting = true;
      showCashoutPending();
      return;
    }
    if (game.active) void cashOut();
  }

  function focusFirst(container) {
    const focusable = container.querySelector("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])");
    if (focusable) focusable.focus();
  }

  function showBankruptcyPrompt() {
    if (game.balance > 0 || !game.waitingForLoan || game.gameOver) return;
    const allTaken = Object.values(game.loansTaken).every(Boolean);
    const overdue = game.activeLoans.filter((loan) => loan.roundsLeft <= 0);
    if (allTaken) {
      elements.bankruptCopy.textContent = "Your balance is 0 gold and all three loans have been used. There is no gold left to continue.";
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
      elements.bankruptModal.classList.add("hidden");
      applyState(response.state, response.profile);
      showGameOver("BALANCE DEPLETED", "Your balance reached 0 gold and you chose not to borrow again.", "No gold left");
    } catch (error) {
      setMessage(error.message || "Couldn't end this game on the server.", "danger");
    } finally {
      game.endPending = false;
      elements.acceptDefeatButton.disabled = false;
    }
  }

  function openLoanModal() {
    if (game.balance > 0 || !game.waitingForLoan || game.gameOver || game.active) return;
    if (Object.values(game.loansTaken).every(Boolean)) return;
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
      elements.holdButtonSubtitle.textContent = "Release to cash out";
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
      elements.betInput.value = "88";
      elements.multiplier.classList.remove("busted", "live");
      elements.meterTrack.classList.remove("busted", "is-running");
      game.multiplier = 1;
      updateMultiplierDisplay();
      elements.multiplierCaption.textContent = "Hold to start. Release to cash out.";
      elements.holdButtonTitle.textContent = "HOLD TO START";
      elements.holdButtonSubtitle.textContent = "Release to cash out";
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

  function hexToBytes(hex) {
    if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid hexadecimal server seed.");
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  async function sha256HexUtf8(text) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function verifyRevealedFairness() {
    if (!game.ready) return;
    elements.verifyFairnessButton.disabled = true;
    elements.verifyFairnessStatus.className = "fairness-verification";
    elements.verifyFairnessStatus.textContent = "Checking past rounds…";
    try {
      const pageSize = 100;
      const first = await api(`/api/fairness?limit=${pageSize}&roundOffset=0&seedOffset=0`);
      const totalRounds = Number(first.totalRounds ?? first.rounds?.length ?? 0);
      const totalSeeds = Number(first.totalSeeds ?? first.seeds?.length ?? 0);
      const rounds = [...(first.rounds || [])];
      const seeds = [...(first.seeds || [])];
      const totalPages = Math.max(totalRounds, totalSeeds);
      for (let offset = pageSize; offset < totalPages; offset += pageSize) {
        elements.verifyFairnessStatus.textContent = `Loading records… ${Math.min(offset, totalPages).toLocaleString("en-US")} of ${totalPages.toLocaleString("en-US")}`;
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
      for (const seedRow of seeds) {
        if (typeof seedRow.revealed_seed !== "string") continue;
        const expectedCommitment = await sha256HexUtf8(seedRow.revealed_seed);
        if (expectedCommitment !== seedRow.commitment) {
          failures.push(`Seed batch ${seedRow.epoch}: commitment mismatch`);
          continue;
        }
        verifiedSeeds += 1;
      }

      for (const round of rounds) {
        const seedRow = seedsByEpoch.get(Number(round.epoch));
        if (!seedRow) {
          failures.push(`Round ${round.id}: no seed commitment record for batch ${round.epoch}`);
          continue;
        }
        if (typeof seedRow.revealed_seed !== "string") {
          pendingRounds += 1;
          continue;
        }
        if (round.crash_point === null || round.crash_point === undefined || round.status === "running") {
          failures.push(`Round ${round.id}: revealed batch has an unsettled round`);
          continue;
        }
        if (await sha256HexUtf8(seedRow.revealed_seed) !== seedRow.commitment) continue;
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

  document.querySelectorAll(".quick-bets button").forEach((button) => {
    button.addEventListener("click", () => {
      const fraction = Number(button.dataset.fraction);
      const amount = Math.max(1, Math.floor(game.balance * fraction));
      elements.betInput.value = String(amount);
      elements.betInput.dispatchEvent(new Event("input"));
    });
  });

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
    } else if (game.active && game.activeRound) {
      // One immediate reconciliation on return; normal one-second polling resumes afterward.
      void pollRoundStatus().finally(() => { if (game.active) scheduleStatusPoll(); });
    }
  });

  elements.acceptDefeatButton.addEventListener("click", () => void acceptDefeat());
  elements.bankLoanButton.addEventListener("click", openLoanModal);
  elements.loanCloseButton.addEventListener("click", closeLoanModal);
  document.querySelectorAll(".loan-option").forEach((button) => {
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

  function initGalaxyCanvas() {
    const canvas = document.querySelector(".galaxy-particles");
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const random = (() => {
      // A stable seed keeps the particle composition art-directed between visits.
      let seed = 0x67a11a;
      return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
    })();
    const normal = () => {
      const u = Math.max(0.00001, random());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    };

    // Fine, low-contrast dust carries the color directly; no blur, bloom, or hard nuclei.
    // Muted colors are deliberately restrained so the starfield and multiplier stay readable.
    const palette = [
      [112, 91, 174],  // shadow violet
      [139, 91, 166],  // muted plum
      [160, 83, 133],  // dusty rose
      [174, 61, 91],   // subdued crimson
      [160, 146, 199], // dim lilac
      [86, 76, 135]    // deep violet
    ];
    let particles = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let frame = 0;
    let previousTime = 0;
    let elapsed = 0;
    let stopped = false;

    function chooseColor(x, y) {
      // A low-frequency color drift mixes warm and cool tones across the full formation.
      // No single coordinate becomes a bright red island or a planet-like center.
      const wave = 0.5 + 0.5 * Math.sin((x / width) * Math.PI * 2.1 + Math.sin((y / height) * Math.PI * 1.6) * 0.8);
      const roll = random();
      if (roll < 0.10 + wave * 0.07) return palette[3];
      if (roll < 0.28 + wave * 0.07) return palette[2];
      if (roll < 0.52) return palette[1];
      if (roll < 0.80) return palette[0];
      if (roll < 0.94) return palette[5];
      return palette[4];
    }

    function sampleCloudX() {
      // Two wide, overlapping density regions make elongated clusters; their overlap keeps them connected.
      // There are no focal centers, rings, or bright spherical bodies.
      if (random() < 0.58) {
        const side = random() < 0.5 ? -1 : 1;
        let candidate;
        do {
          candidate = width * (0.5 + side * (0.235 + normal() * 0.13));
        } while (candidate < 0 || candidate > width);
        return candidate;
      }
      return random() * width;
    }

    function buildParticles() {
      particles = [];
      // A restrained field of fine dust; density makes cloud shapes, not bright particles or blur.
      const count = Math.max(4200, Math.min(10500, Math.round(width * height / 24)));
      const centerY = height * 0.49;

      for (let i = 0; i < count; i += 1) {
        const source = random();
        let x;
        let y;
        let kind;

        if (source < 0.38) {
          x = sampleCloudX();
          const nx = (x / width - 0.5) * 2;
          const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
          // Main dust lane: broad and broken up, with no nucleus or closed orbit.
          const spine = centerY + height * (0.035 * Math.sin(nx * 2.7 + 0.5) + 0.025 * Math.sin(nx * 5.3 - 0.7));
          y = spine + normal() * height * (0.095 + irregularity);
          kind = "main-dust";
        } else if (source < 0.64) {
          x = sampleCloudX();
          const nx = (x / width - 0.5) * 2;
          const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
          // Loose upper filament overlaps the main lane instead of reading as a separate body.
          const spine = height * (0.30 + 0.075 * nx + 0.032 * Math.sin(nx * 3.7 + 0.9));
          y = spine + normal() * height * (0.063 + irregularity * 0.6);
          kind = "upper-dust";
        } else if (source < 0.86) {
          x = sampleCloudX();
          const nx = (x / width - 0.5) * 2;
          const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
          // A faint lower wisp gives the field depth but leaves open space between streams.
          const spine = height * (0.68 - 0.055 * nx + 0.035 * Math.sin(nx * 3.1 - 0.8));
          y = spine + normal() * height * (0.067 + irregularity * 0.6);
          kind = "lower-dust";
        } else {
          // Sparse background grains keep the dark space from feeling like a solid flat panel.
          x = random() * width;
          y = random() * height;
          kind = "background-dust";
        }

        if (y < -height * 0.12 || y > height * 1.12) continue;
        const color = chooseColor(x, y);
        const sparkle = random() < 0.004;
        const size = sparkle ? 0.9 + random() * 0.35 : 0.42 + Math.pow(random(), 1.65) * (kind === "background-dust" ? 0.85 : 1.5);
        let alpha;
        if (sparkle) alpha = 0.24 + random() * 0.08;
        else if (kind === "main-dust") alpha = 0.11 + Math.pow(random(), 1.8) * 0.25;
        else if (kind === "upper-dust" || kind === "lower-dust") alpha = 0.07 + Math.pow(random(), 1.9) * 0.16;
        else alpha = 0.025 + random() * 0.07;

        particles.push({
          x, y,
          phase: random() * Math.PI * 2,
          size,
          length: 0.7 + Math.pow(random(), 1.8) * 1.8,
          alpha,
          color,
          sparkle,
          kind
        });
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildParticles();
      draw(0);
    }

    function draw(time) {
      if (stopped) return;
      if (!reduceMotion.matches && time - previousTime < 30) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
      previousTime = time;
      if (!reduceMotion.matches) elapsed += delta;
      context.clearRect(0, 0, width, height);

      for (const particle of particles) {
        // Slow, nearly imperceptible lateral drift avoids orbiting centers and planet-like rings.
        // The field gently changes direction by height, like dust carried through a broad current.
        const band = particle.kind === "upper-dust" ? -0.20 : particle.kind === "lower-dust" ? 0.16 : 0.045;
        const phase = particle.phase + (particle.x / width) * Math.PI * 1.5;
        const vx = band + Math.sin((particle.y / height) * Math.PI * 2 + particle.phase) * 0.15;
        const vy = Math.sin(phase) * 0.095 + Math.cos((particle.y / height) * Math.PI * 2.5) * 0.045;
        if (!reduceMotion.matches && delta > 0) {
          particle.x += vx * delta;
          particle.y += vy * delta;
          if (particle.x < -5) particle.x = width + 4;
          else if (particle.x > width + 5) particle.x = -4;
          if (particle.y < -5) particle.y = height + 4;
          else if (particle.y > height + 5) particle.y = -4;
        }

        const x = particle.x + Math.sin(elapsed * 0.13 + particle.phase) * 0.42;
        const y = particle.y + Math.cos(elapsed * 0.11 + particle.phase) * 0.48;
        if (x < -5 || x > width + 5 || y < -5 || y > height + 5) continue;

        // Fade particles more strongly behind the central readout; motion stars sit on a higher layer.
        const nx = (x - width * 0.5) / (width * 0.26);
        const ny = (y - height * 0.44) / (height * 0.30);
        const centerQuiet = 1 - 0.64 * Math.exp(-((nx * nx) + (ny * ny)) * 1.05);
        const shimmer = 0.94 + Math.sin(elapsed * 0.19 + particle.phase) * 0.06;
        const alpha = Math.min(0.31, particle.alpha * centerQuiet * shimmer);
        const [r, g, b] = particle.color;

        if (particle.sparkle) {
          // Only an occasional tiny hard glint; avoid bright dots that read as planets.
          context.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
          context.fillRect(x, y, particle.size, particle.size);
        } else {
          context.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
          context.fillRect(x, y, particle.size, particle.size);
        }
      }

      if (!reduceMotion.matches) frame = window.requestAnimationFrame(draw);
    }

    function restartMotion() {
      if (frame) window.cancelAnimationFrame(frame);
      previousTime = 0;
      frame = window.requestAnimationFrame(draw);
    }

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (resizeObserver) resizeObserver.observe(canvas.parentElement);
    window.addEventListener("resize", resize, { passive: true });
    reduceMotion.addEventListener?.("change", restartMotion);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopped = true;
        if (frame) window.cancelAnimationFrame(frame);
      } else {
        stopped = false;
        restartMotion();
      }
    });
    resize();
  }
  async function boot() {
    game.lastReveal = readLastReveal();
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
