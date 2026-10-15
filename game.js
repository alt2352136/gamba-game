const STARTING_GOLD = 888;
const GROWTH_PER_SECOND = 0.8;
const MAX_MULTIPLIER = 10;
const HOUSE_EDGE = 0.03;

const loans = {
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
  newGameButton: document.getElementById("new-game-button")
};

const game = {
  balance: STARTING_GOLD,
  activeBet: 0,
  multiplier: 1,
  elapsed: 0,
  roundStartedAt: 0,
  visualWobblePixels: 0,
  wobbleSeed: 0,
  crashPoint: 1,
  active: false,
  gameOver: false,
  waitingForLoan: false,
  activeLoans: [],
  loansRepaid: { 444: false, 888: false, 1500: false },
  history: [],
  roundNumber: 0,
  holdSource: null,
  animationFrameId: null,
  activePointerId: null,
  keyboardCode: null,
  loansTaken: { 444: false, 888: false, 1500: false }
};

function formatGold(amount) {
  return Math.floor(amount).toLocaleString("en-US");
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

function getBet() {
  const value = Number(elements.betInput.value);
  if (!Number.isInteger(value) || value < 1 || value > game.balance) return null;
  return value;
}

// One crash point is selected before each round. The formula is a cent-rounded
// crash distribution with a 3% house edge: P(reaching target m) is about 0.97 / m.
function randomValue() {
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0] / 0x100000000;
  }
  return Math.random();
}

function generateCrashPoint() {
  const roll = randomValue();
  const crashPoint = Math.floor(((1 - HOUSE_EDGE) * 100) / (1 - roll)) / 100;
  return Math.max(1, crashPoint);
}

function updateLoanOptions() {
  const canBorrow = game.waitingForLoan && game.balance <= 0 && !game.gameOver;

  document.querySelectorAll(".loan-option").forEach((button) => {
    const principal = Number(button.dataset.loan);
    const loan = loans[principal];
    const taken = game.loansTaken[principal];
    const activeLoan = game.activeLoans.some((item) => item.principal === principal);
    const repaid = game.loansRepaid[principal];
    const tier = button.querySelector(".loan-tier");

    button.disabled = taken || !canBorrow;
    tier.textContent = activeLoan ? "ACTIVE LOAN" : repaid ? "REPAID" : taken ? "USED THIS GAME" : loan.tier;
    button.classList.toggle("loan-taken", taken);
  });

  Object.keys(loans).forEach((key) => {
    const principal = Number(key);
    const loan = loans[principal];
    const status = document.getElementById(`loan-${principal}-state`);
    const activeLoan = game.activeLoans.find((item) => item.principal === principal);
    const taken = game.loansTaken[principal];
    const repaid = game.loansRepaid[principal];
    const details = document.querySelector(`[data-loan-status="${principal}"] .loan-availability-main small`);

    status.textContent = activeLoan ? "ACTIVE" : repaid ? "REPAID" : taken ? "USED" : "AVAILABLE";
    status.classList.toggle("is-active", Boolean(activeLoan));
    status.classList.toggle("is-used", taken && !activeLoan);
    status.classList.toggle("is-repaid", repaid);

    if (activeLoan) {
      details.textContent = `Repay ${formatGold(activeLoan.repayment)} · ${activeLoan.roundsLeft} ${activeLoan.roundsLeft === 1 ? "round" : "rounds"} left`;
    } else if (repaid) {
      details.textContent = `Repaid ${formatGold(loan.repayment)} gold`;
    } else {
      details.textContent = `Repay ${formatGold(loan.repayment)} · ${loan.rounds}-round deadline`;
    }
  });

  const allTaken = Object.values(game.loansTaken).every(Boolean);
  if (allTaken) {
    elements.loanWarning.textContent = "All three loans have been used in this game.";
  } else if (game.activeLoans.length > 0) {
    elements.loanWarning.textContent = "Taking another loan does not reset existing deadlines.";
  } else {
    elements.loanWarning.textContent = "Larger loans have higher fees and shorter deadlines.";
  }
  elements.bankLoanButton.disabled = allTaken || !canBorrow;
}

function updateMultiplierDisplay() {
  elements.multiplier.textContent = `x${game.multiplier.toFixed(2)}`;
  elements.meterTrack.setAttribute("aria-valuenow", game.multiplier.toFixed(2));

  const progress = ((game.multiplier - 1) / (MAX_MULTIPLIER - 1)) * 100;
  const clampedProgress = Math.max(0, Math.min(100, progress));
  elements.meterFill.style.width = `${clampedProgress}%`;
  elements.meterWobble.style.left = `calc(${clampedProgress}% + ${game.active ? game.visualWobblePixels.toFixed(2) : 0}px)`;
  elements.meterTrack.classList.toggle("is-running", game.active);
  elements.meterTrack.classList.toggle("busted", elements.multiplier.classList.contains("busted"));
}

function updateUI() {
  elements.balance.textContent = formatGold(game.balance);
  elements.betInput.max = String(game.balance);
  updateMultiplierDisplay();

  if (game.activeLoans.length > 0) {
    const totalDue = game.activeLoans.reduce((total, loan) => total + loan.repayment, 0);
    const nearestDeadline = Math.min(...game.activeLoans.map((loan) => loan.roundsLeft));
    elements.loanStatus.textContent = `${game.activeLoans.length} ACTIVE`;
    elements.loanDescription.textContent = `Outstanding: ${formatGold(totalDue)} gold`;
    elements.loanRounds.textContent = `${nearestDeadline} ${nearestDeadline === 1 ? "round" : "rounds"} to deadline`;
  } else {
    elements.loanStatus.textContent = Object.values(game.loansRepaid).some(Boolean) ? "REPAID" : "NONE";
    elements.loanDescription.textContent = "No active loans";
    elements.loanRounds.textContent = "—";
  }

  const canPlay = !game.active && !game.gameOver && !game.waitingForLoan && game.balance > 0;
  elements.holdButton.disabled = !game.active && (game.gameOver || game.waitingForLoan || game.balance <= 0);
  elements.betInput.disabled = !canPlay;
  elements.maxButton.disabled = !canPlay;
  document.querySelectorAll(".quick-bets button").forEach((button) => {
    button.disabled = !canPlay;
  });
  updateLoanOptions();
}

function addHistory(result, multiplier, stake, payout, netChange, loanRepayments = []) {
  game.history.unshift({
    round: game.roundNumber,
    result,
    multiplier,
    stake,
    payout,
    netChange,
    loanRepayments
  });
  game.history = game.history.slice(0, 5);
  elements.historyList.replaceChildren();

  game.history.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";

    const left = document.createElement("div");
    left.className = "history-left";

    const title = document.createElement("strong");
    title.textContent = `ROUND ${String(item.round).padStart(2, "0")} · ${item.result}`;

    const details = document.createElement("small");
    details.textContent = `Stake ${formatGold(item.stake)} · Payout ${formatGold(item.payout)}`;
    left.append(title, details);

    if (item.loanRepayments.length > 0) {
      const repayment = document.createElement("small");
      repayment.className = "history-loan-note";
      repayment.textContent = item.loanRepayments.map((loan) => `${formatGold(loan.principal)} loan repaid ${formatGold(loan.repayment)}`).join(" · ");
      left.append(repayment);
    }

    const right = document.createElement("div");
    right.className = "history-right";
    const multiplier = document.createElement("span");
    multiplier.className = "history-multiplier";
    multiplier.textContent = `x${item.multiplier.toFixed(2)}`;

    const change = document.createElement("span");
    change.className = `history-change ${item.netChange >= 0 ? "positive" : "negative"}`;
    change.textContent = `${item.netChange >= 0 ? "+" : "−"}${formatGold(Math.abs(item.netChange))}`;

    right.append(multiplier, change);
    row.append(left, right);
    elements.historyList.append(row);
  });
}

function clearHoldState() {
  game.holdSource = null;
  game.activePointerId = null;
  game.keyboardCode = null;
  elements.holdButton.classList.remove("is-holding");
  elements.holdButton.setAttribute("aria-pressed", "false");
}

function stopRoundAnimation() {
  if (game.animationFrameId !== null) {
    cancelAnimationFrame(game.animationFrameId);
    game.animationFrameId = null;
  }
}

function scheduleRoundFrame() {
  if (game.active && game.animationFrameId === null) {
    game.animationFrameId = requestAnimationFrame(updateRound);
  }
}

function startRound(source, identifier = null) {
  if (game.active || game.gameOver || game.waitingForLoan || game.balance <= 0) return false;
  stopRoundAnimation();

  const bet = getBet();
  if (bet === null) {
    elements.betNote.textContent = game.balance === 0
      ? "No gold left. Use the bank loan option to continue."
      : `Enter a whole number between 1 and ${formatGold(game.balance)}.`;
    elements.betNote.classList.add("error");
    return false;
  }

  elements.betNote.textContent = "Your stake is deducted when the round starts.";
  elements.betNote.classList.remove("error");
  game.activeBet = bet;
  game.balance -= bet;
  game.multiplier = 1;
  game.elapsed = 0;
  game.roundStartedAt = performance.now();
  game.visualWobblePixels = 0;
  game.crashPoint = generateCrashPoint();
  game.wobbleSeed = Math.random() * Math.PI * 2;
  game.roundNumber += 1;
  game.active = true;
  game.holdSource = source;
  game.activePointerId = source === "pointer" ? identifier : null;
  game.keyboardCode = source === "keyboard" ? identifier : null;

  elements.multiplier.classList.add("live");
  elements.multiplier.classList.remove("busted");
  elements.meterTrack.classList.remove("busted");
  elements.holdButton.classList.add("is-holding");
  elements.holdButton.setAttribute("aria-pressed", "true");
  elements.holdButtonTitle.textContent = "ROUND IN PROGRESS";
  elements.holdButtonSubtitle.textContent = "Release to cash out";
  elements.multiplierCaption.textContent = "Release to cash out at the current multiplier.";
  setRoundStatus("RUNNING", "live");
  setMessage(`Bet placed: ${formatGold(bet)} gold.`, "success");
  updateUI();
  scheduleRoundFrame();
  return true;
}

function refreshMultiplier(now) {
  game.elapsed = Math.max(0, (now - game.roundStartedAt) / 1000);
  game.multiplier = Math.min(MAX_MULTIPLIER, 1 + game.elapsed * GROWTH_PER_SECOND);

  // Wobble moves only the small meter marker. It does not change the multiplier or odds.
  game.visualWobblePixels = Math.sin(game.elapsed * 6.1) * 3.2
    + Math.sin(game.elapsed * 13.7 + game.wobbleSeed) * 1.6;
}

function updateRound(timestamp) {
  game.animationFrameId = null;
  if (!game.active) return;

  refreshMultiplier(timestamp);

  if (game.crashPoint === 1 || game.multiplier > game.crashPoint) {
    bustRound(Math.min(game.crashPoint, MAX_MULTIPLIER));
    return;
  }

  if (game.multiplier >= MAX_MULTIPLIER) {
    completeCashOut(true);
    return;
  }

  updateMultiplierDisplay();
  scheduleRoundFrame();
}

function processLoansAfterRound() {
  const repayments = [];
  const loansByDeadline = [...game.activeLoans].sort((a, b) => a.roundsLeft - b.roundsLeft);

  // Pay the loans with the closest deadlines first whenever the balance allows it.
  loansByDeadline.forEach((loan) => {
    if (game.balance >= loan.repayment) {
      game.balance -= loan.repayment;
      game.activeLoans = game.activeLoans.filter((item) => item !== loan);
      game.loansRepaid[loan.principal] = true;
      repayments.push({ principal: loan.principal, repayment: loan.repayment });
    }
  });

  for (const loan of game.activeLoans) {
    loan.roundsLeft -= 1;
  }

  const defaultedLoan = game.activeLoans
    .filter((loan) => loan.roundsLeft <= 0)
    .sort((a, b) => a.roundsLeft - b.roundsLeft || a.principal - b.principal)[0] || null;

  if (defaultedLoan) {
    return { canContinue: false, repayments, defaultedLoan };
  }

  return { canContinue: true, repayments, defaultedLoan: null };
}

function finishRound(result, multiplier, payout) {
  const loanResult = processLoansAfterRound();
  const repaidTotal = loanResult.repayments.reduce((total, loan) => total + loan.repayment, 0);
  const netChange = payout - game.activeBet - repaidTotal;
  addHistory(result, multiplier, game.activeBet, payout, netChange, loanResult.repayments);
  updateUI();

  if (repaidTotal > 0) {
    const repaymentText = loanResult.repayments.map((loan) => `${formatGold(loan.repayment)} gold`).join(" and ");
    setMessage(`${result === "BUST" ? "Bust." : `Cashed out at x${multiplier.toFixed(2)}.`} Loan repayment: ${repaymentText}.`, result === "BUST" ? "danger" : "success");
  }

  if (!loanResult.canContinue) {
    // A zero balance gets the loan-choice prompt first, so the cause is clear.
    // Any already-expired debt is settled immediately if the player borrows again.
    if (game.balance <= 0) {
      checkForBankruptcy();
      return;
    }

    const loan = loanResult.defaultedLoan;
    endGameForLoanDefault(`The ${formatGold(loan.principal)} gold loan was not repaid within ${loans[loan.principal].rounds} rounds. ${formatGold(loan.repayment)} gold was due.`);
    return;
  }

  checkForBankruptcy();
}

function cashOut() {
  if (!game.active) return;

  // Use the release time too, so a frame delay cannot make a late cash-out win.
  refreshMultiplier(performance.now());
  if (game.crashPoint === 1 || game.multiplier > game.crashPoint) {
    bustRound(Math.min(game.crashPoint, MAX_MULTIPLIER));
    return;
  }
  if (game.multiplier >= MAX_MULTIPLIER) {
    completeCashOut(true);
    return;
  }
  completeCashOut(false);
}

function completeCashOut(atLimit = false) {
  if (!game.active) return;

  game.active = false;
  stopRoundAnimation();
  clearHoldState();
  elements.multiplier.classList.remove("live", "busted");
  if (atLimit) game.multiplier = MAX_MULTIPLIER;

  const multiplier = game.multiplier;
  const payout = Math.floor(game.activeBet * multiplier);
  const netChange = payout - game.activeBet;
  game.balance += payout;

  elements.multiplierCaption.textContent = atLimit
    ? "Maximum multiplier reached."
    : `Cashed out at x${multiplier.toFixed(2)}.`;
  elements.holdButtonTitle.textContent = "HOLD TO START";
  elements.holdButtonSubtitle.textContent = "Release to cash out";
  setRoundStatus("CASHED OUT");
  setMessage(`Payout ${formatGold(payout)} gold · net ${netChange >= 0 ? "+" : "−"}${formatGold(Math.abs(netChange))}.`, "success");
  finishRound("CASH OUT", multiplier, payout);
}

function bustRound(crashPoint) {
  if (!game.active) return;

  game.active = false;
  stopRoundAnimation();
  game.multiplier = Math.max(1, Math.min(MAX_MULTIPLIER, crashPoint));
  game.visualWobblePixels = 0;
  clearHoldState();
  elements.multiplier.classList.remove("live");
  elements.multiplier.classList.add("busted");
  elements.meterTrack.classList.add("busted");
  elements.multiplierCaption.textContent = `Crashed at x${game.multiplier.toFixed(2)}.`;
  elements.holdButtonTitle.textContent = "BUST";
  elements.holdButtonSubtitle.textContent = "The stake was lost";
  setRoundStatus("BUST", "busted");
  setMessage(`Crashed at x${game.multiplier.toFixed(2)}. You lost ${formatGold(game.activeBet)} gold.`, "danger");
  finishRound("BUST", game.multiplier, 0);
}

function checkForBankruptcy() {
  if (game.balance > 0 || game.gameOver) return;

  game.waitingForLoan = true;
  const availableLoan = Object.keys(loans).some((key) => !game.loansTaken[key]);
  const overdueLoans = game.activeLoans.filter((loan) => loan.roundsLeft <= 0);
  if (!availableLoan) {
    elements.bankruptCopy.textContent = "Your balance is 0 gold and all three loans have been used. There is no gold left to continue.";
  } else if (overdueLoans.length > 0) {
    const overdueTotal = overdueLoans.reduce((total, loan) => total + loan.repayment, 0);
    elements.bankruptCopy.textContent = `Your balance is 0 gold. You may take another available loan, but ${formatGold(overdueTotal)} gold in overdue repayments must be settled immediately. Other deadlines still apply.`;
  } else if (game.activeLoans.length > 0) {
    elements.bankruptCopy.textContent = "Your balance is 0 gold. You can take another available loan, but every existing repayment deadline still applies.";
  } else {
    elements.bankruptCopy.textContent = "Your balance is 0 gold. Take an available loan to continue, or end this game.";
  }

  elements.bankruptModal.classList.remove("hidden");
  updateUI();
  focusFirst(elements.bankruptModal);
}

function acceptDefeat() {
  elements.bankruptModal.classList.add("hidden");
  game.waitingForLoan = false;
  const copy = game.activeLoans.length > 0
    ? "Your balance reached 0 gold. You chose not to borrow again, and the active loans remain unpaid."
    : "Your balance reached 0 gold, and you chose not to borrow again.";
  showGameOver("BALANCE DEPLETED", copy, "No gold left");
}

function openLoanModal() {
  if (game.balance > 0 || !game.waitingForLoan || game.gameOver) return;
  updateLoanOptions();
  if (Object.values(game.loansTaken).every(Boolean)) return;
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

function settleOverdueLoans() {
  const overdueLoans = [...game.activeLoans]
    .filter((loan) => loan.roundsLeft <= 0)
    .sort((a, b) => a.roundsLeft - b.roundsLeft);
  const repayments = [];

  for (const loan of overdueLoans) {
    if (game.balance < loan.repayment) {
      return { canContinue: false, defaultedLoan: loan, repayments };
    }

    game.balance -= loan.repayment;
    game.activeLoans = game.activeLoans.filter((item) => item !== loan);
    game.loansRepaid[loan.principal] = true;
    repayments.push({ principal: loan.principal, repayment: loan.repayment });
  }

  return { canContinue: true, defaultedLoan: null, repayments };
}

function takeLoan(principal) {
  const loan = loans[principal];
  if (!loan || game.gameOver || !game.waitingForLoan || game.balance > 0 || game.loansTaken[principal]) return;

  // When refinancing with another loan, add half of the nearest existing
  // deadline to the new deadline and extend every active loan by that same
  // amount. This keeps the example symmetric: 4 rounds left + a 4-round loan
  // becomes 6 rounds for both obligations.
  const extension = game.activeLoans.length > 0
    ? Math.max(0, Math.ceil(Math.min(...game.activeLoans.map((item) => item.roundsLeft)) / 2))
    : 0;

  game.activeLoans.forEach((item) => {
    item.roundsLeft += extension;
  });

  game.loansTaken[principal] = true;
  game.activeLoans.push({
    principal: loan.principal,
    repayment: loan.repayment,
    roundsLeft: loan.rounds + extension
  });
  game.balance += loan.principal;
  game.waitingForLoan = false;
  elements.loanModal.classList.add("hidden");
  elements.bankruptModal.classList.add("hidden");

  const overdueResult = settleOverdueLoans();
  if (!overdueResult.canContinue) {
    updateUI();
    const overdueLoan = overdueResult.defaultedLoan;
    endGameForLoanDefault(`The overdue ${formatGold(overdueLoan.principal)} gold loan required ${formatGold(overdueLoan.repayment)} gold immediately. The available balance was not enough to repay it.`);
    return;
  }

  elements.multiplier.classList.remove("busted");
  elements.meterTrack.classList.remove("busted");
  elements.multiplierCaption.textContent = "Place a bet to start the next round.";
  elements.holdButtonTitle.textContent = "HOLD TO START";
  elements.holdButtonSubtitle.textContent = "Release to cash out";
  setRoundStatus("LOAN TAKEN");
  const extraLoanNote = extension > 0
    ? ` Existing loan deadlines and this loan's deadline were extended by ${extension} ${extension === 1 ? "round" : "rounds"}.`
    : "";
  const overdueNote = overdueResult.repayments.length > 0
    ? ` Repaid overdue loan: ${overdueResult.repayments.map((item) => `${formatGold(item.repayment)} gold`).join(" and ")}.`
    : "";
  const newLoan = game.activeLoans.find((item) => item.principal === principal);
  setMessage(`Borrowed ${formatGold(loan.principal)} gold. Repay ${formatGold(loan.repayment)} within ${newLoan ? newLoan.roundsLeft : loan.rounds} rounds.${extraLoanNote}${overdueNote}`, "success");
  updateUI();
  elements.holdButton.focus();
}

function endGameForLoanDefault(reason) {
  game.active = false;
  stopRoundAnimation();
  game.gameOver = true;
  game.waitingForLoan = false;
  clearHoldState();
  elements.bankruptModal.classList.add("hidden");
  elements.loanModal.classList.add("hidden");
  showGameOver("LOAN DEFAULT", reason, "Loan not repaid");
}

function showGameOver(eyebrow, copy, title = "Game over") {
  game.active = false;
  game.gameOver = true;
  game.waitingForLoan = false;
  elements.gameoverEyebrow.textContent = eyebrow;
  elements.gameoverTitle.textContent = title;
  elements.gameoverCopy.textContent = copy;
  elements.finalBalance.textContent = `${formatGold(game.balance)} GOLD`;
  elements.gameoverModal.classList.remove("hidden");
  updateUI();
  elements.newGameButton.focus();
}

function startNewGame() {
  stopRoundAnimation();
  game.balance = STARTING_GOLD;
  game.activeBet = 0;
  game.multiplier = 1;
  game.elapsed = 0;
  game.roundStartedAt = 0;
  game.visualWobblePixels = 0;
  game.wobbleSeed = 0;
  game.crashPoint = 1;
  game.active = false;
  game.gameOver = false;
  game.waitingForLoan = false;
  game.activeLoans = [];
  game.loansRepaid = { 444: false, 888: false, 1500: false };
  game.history = [];
  game.roundNumber = 0;
  game.loansTaken = { 444: false, 888: false, 1500: false };
  clearHoldState();

  elements.betInput.value = "88";
  elements.betNote.textContent = "Your stake is deducted when the round starts.";
  elements.betNote.classList.remove("error");
  elements.multiplier.classList.remove("live", "busted");
  elements.meterTrack.classList.remove("busted", "is-running");
  elements.multiplierCaption.textContent = "Hold to start. Release to cash out.";
  elements.holdButtonTitle.textContent = "HOLD TO START";
  elements.holdButtonSubtitle.textContent = "Release to cash out";
  elements.historyList.replaceChildren();
  const emptyHistory = document.createElement("p");
  emptyHistory.className = "history-empty";
  emptyHistory.textContent = "Completed rounds will appear here.";
  elements.historyList.append(emptyHistory);
  elements.bankruptModal.classList.add("hidden");
  elements.loanModal.classList.add("hidden");
  elements.gameoverModal.classList.add("hidden");
  setRoundStatus("READY");
  setMessage("Place a bet, then hold the button to start.");
  updateUI();
  elements.holdButton.focus();
}

function focusFirst(container) {
  const focusable = container.querySelector("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])");
  if (focusable) focusable.focus();
}

function releaseHold(source, identifier = null) {
  if (!game.active || game.holdSource !== source) return;
  if (source === "pointer" && game.activePointerId !== identifier) return;
  if (source === "keyboard" && game.keyboardCode !== identifier) return;
  cashOut();
}

function releaseAnyHold() {
  if (game.active) cashOut();
}

// Pointer capture and window-level release handlers keep a hold from getting stuck.
elements.holdButton.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  const started = startRound("pointer", event.pointerId);
  if (started && elements.holdButton.setPointerCapture) {
    try {
      elements.holdButton.setPointerCapture(event.pointerId);
    } catch (error) {
      // Window-level pointerup remains as a fallback if capture is unavailable.
    }
  }
});

window.addEventListener("pointerup", (event) => releaseHold("pointer", event.pointerId));
window.addEventListener("pointercancel", (event) => releaseHold("pointer", event.pointerId));
elements.holdButton.addEventListener("lostpointercapture", (event) => releaseHold("pointer", event.pointerId));

// The hold button also works with Space and Enter, including key release outside the button.
elements.holdButton.addEventListener("keydown", (event) => {
  if (event.code !== "Space" && event.code !== "Enter") return;
  event.preventDefault();
  if (!event.repeat && !game.active) startRound("keyboard", event.code);
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space" || event.code === "Enter") releaseHold("keyboard", event.code);
});

// If focus is lost or the tab is hidden, settle the active round instead of leaving it held.
window.addEventListener("blur", releaseAnyHold);
window.addEventListener("pagehide", releaseAnyHold);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAnyHold();
});

// Keep bet controls within the player's current balance.
elements.betInput.addEventListener("input", () => {
  const bet = getBet();
  if (bet !== null) {
    elements.betNote.textContent = "Your stake is deducted when the round starts.";
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

elements.acceptDefeatButton.addEventListener("click", acceptDefeat);
elements.bankLoanButton.addEventListener("click", openLoanModal);
elements.loanCloseButton.addEventListener("click", closeLoanModal);
document.querySelectorAll(".loan-option").forEach((button) => {
  button.addEventListener("click", () => takeLoan(Number(button.dataset.loan)));
});
elements.newGameButton.addEventListener("click", startNewGame);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.loanModal.classList.contains("hidden")) {
    closeLoanModal();
  }
});


updateUI();
