// DOM rendering helpers. The game controller supplies current state; this module never
// makes API requests or changes server-authoritative state.
export function createGameRenderer({
  elements,
  loanOptionButtons,
  quickBetButtons,
  loanStatusElements,
  loans,
  maxMultiplier,
  getGame,
  formatGold,
  hasUsedAllLoans
}) {
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

  function renderProfile(profile = getGame().profile) {
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

  function updateLoanOptions() {
    const game = getGame();
    const canBorrow = game.ready && game.waitingForLoan && game.balance <= 0 && !game.gameOver && !game.active;
    loanOptionButtons.forEach((button) => {
      const principal = Number(button.dataset.loan);
      const loan = loans[principal];
      const taken = Boolean(game.loansTaken[principal]);
      const activeLoan = game.activeLoans.some((item) => item.principal === principal);
      const repaid = Boolean(game.loansRepaid[principal]);
      const tier = button.querySelector(".loan-tier");
      button.disabled = !canBorrow || taken || game.loanPending;
      tier.textContent = activeLoan ? "ACTIVE LOAN" : repaid ? "REPAID" : taken ? "USED THIS GAME" : loan.tier;
      button.classList.toggle("loan-taken", taken);
    });

    Object.keys(loans).forEach((key) => {
      const principal = Number(key);
      const loan = loans[principal];
      const { status, details } = loanStatusElements[key];
      const activeLoan = game.activeLoans.find((item) => item.principal === principal);
      const taken = Boolean(game.loansTaken[principal]);
      const repaid = Boolean(game.loansRepaid[principal]);
      status.textContent = activeLoan ? "ACTIVE" : repaid ? "REPAID" : taken ? "USED" : "AVAILABLE";
      status.classList.toggle("is-active", Boolean(activeLoan));
      status.classList.toggle("is-used", taken && !activeLoan && !repaid);
      status.classList.toggle("is-repaid", repaid);
      if (activeLoan) details.textContent = `Repay ${formatGold(activeLoan.repayment)} · ${activeLoan.roundsLeft} ${activeLoan.roundsLeft === 1 ? "round" : "rounds"} left`;
      else if (repaid) details.textContent = `Repaid ${formatGold(loan.repayment)} gold`;
      else details.textContent = `Repay ${formatGold(loan.repayment)} · ${loan.rounds}-round deadline`;
    });

    const allTaken = hasUsedAllLoans();
    if (allTaken) elements.loanWarning.textContent = "All three loans have been used in this game.";
    else if (game.activeLoans.length) elements.loanWarning.textContent = "Taking another loan extends existing deadlines according to the displayed rules.";
    else elements.loanWarning.textContent = "Larger loans have higher fees and shorter deadlines.";
    elements.bankLoanButton.disabled = !canBorrow || allTaken || game.loanPending;
  }

  function updateMultiplierDisplay() {
    const game = getGame();
    // Keep the visible multiplier aligned with the cent-rounded cash-out ceiling.
    const shownCents = Math.max(100, Math.min(maxMultiplier * 100, Math.floor(game.multiplier * 100)));
    const shownMultiplier = shownCents / 100;
    elements.multiplier.textContent = `x${shownMultiplier.toFixed(2)}`;
    elements.meterTrack.setAttribute("aria-valuenow", shownMultiplier.toFixed(2));
    const progress = ((shownMultiplier - 1) / (maxMultiplier - 1)) * 100;
    const clamped = Math.max(0, Math.min(100, progress));
    elements.meterFill.style.width = `${clamped}%`;
    elements.meterTrack.classList.toggle("busted", elements.multiplier.classList.contains("busted"));
  }

  function updateUI() {
    const game = getGame();
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
    quickBetButtons.forEach((button) => { button.disabled = !canPlay || game.active; });
    updateLoanOptions();
  }

  return { setMessage, setRoundStatus, renderHistory, renderProfile, updateLoanOptions, updateMultiplierDisplay, updateUI };
}
