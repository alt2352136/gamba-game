import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [html, js, css, galaxy, fairnessClient, apiClient, renderer, roundClock, browserStorage] = await Promise.all([
  readFile(resolve(root, "index.html"), "utf8"),
  readFile(resolve(root, "game.js"), "utf8"),
  readFile(resolve(root, "styles.css"), "utf8"),
  readFile(resolve(root, "galaxy-background.js"), "utf8"),
  readFile(resolve(root, "fairness-client.js"), "utf8"),
  readFile(resolve(root, "api-client.js"), "utf8"),
  readFile(resolve(root, "game-renderer.js"), "utf8"),
  readFile(resolve(root, "round-clock.js"), "utf8"),
  readFile(resolve(root, "browser-storage.js"), "utf8")
]);

test("public backend configuration loads before the ES module client", () => {
  const configPosition = html.indexOf('src="backend-config.js"');
  const appPosition = html.indexOf('type="module" src="game.js"');
  assert.ok(configPosition >= 0 && appPosition > configPosition);
  assert.doesNotMatch(html.slice(configPosition - 20, configPosition), /defer/);
});

test("HTML IDs are unique and every static JavaScript ID lookup exists", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "HTML must not contain duplicate IDs");
  for (const match of js.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.includes(match[1]), `Missing HTML element #${match[1]}`);
  }
});

test("only the multiplier caption carries the persistent hold/release reminder", () => {
  assert.match(html, /class="multiplier-caption"[^>]*>[\s\S]*?Hold to start\. Release to cash out\./);
  assert.doesNotMatch(html, /hold-button-subtitle|hold-hint/);
  assert.doesNotMatch(js, /holdButtonSubtitle/);
  assert.match(js, /elements\.holdButtonTitle\.textContent = "HOLD TO START"/);
  assert.match(js, /elements\.holdButtonTitle\.textContent = "RELEASE TO CASH OUT"/);
  assert.match(html, /Ready when you are\./);
});

test("the progress bar has no white endpoint marker or orphaned references", () => {
  assert.doesNotMatch(html + js + css, /meter-wobble/);
  assert.match(css, /\.meter-fill\s*\{[^}]*background:\s*linear-gradient\(/s);
});

test("single-action bankruptcy modal centers Accept Defeat when all loans are used", () => {
  assert.match(html, /class="modal-actions" id="bankrupt-actions"/);
  assert.match(js, /function resetBankruptcyModal\(\)[\s\S]*?bankruptActions\.classList\.remove\("single-action"\)/);
  assert.match(js, /if \(allTaken\)[\s\S]*?bankLoanButton\.hidden = true;\s*elements\.bankruptActions\.classList\.add\("single-action"\)/);
  assert.match(js, /function showExhaustedLoansEndState\(\)[\s\S]*?bankLoanButton\.hidden = true;\s*elements\.bankruptActions\.classList\.add\("single-action"\)/);
  assert.match(css, /\.modal-actions\.single-action\s*\{[^}]*justify-items:\s*center/);
  assert.match(css, /\.modal-actions\.single-action #accept-defeat-button\s*\{[^}]*width:\s*min\(100%,\s*220px\)/);
});

test("the cosmic particle field is painted on initialization or resize, not each animation frame", () => {
  const match = galaxy.match(/export function initGalaxyCanvas\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "Galaxy renderer should remain a self-contained module function");
  assert.match(match[1], /function drawStaticField\(\)/);
  assert.match(match[1], /drawStaticField\(\)/);
  assert.doesNotMatch(match[1], /requestAnimationFrame|setInterval/);
  assert.match(js, /import \{ initGalaxyCanvas \} from "\.\/galaxy-background\.js"/);
  assert.match(css, /animation:\s*galaxy-drift/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("rendered particle data excludes metadata no longer needed after construction", () => {
  assert.match(galaxy, /particles\.push\(\{[\s\S]*?x:\s*x\s*\+\s*Math\.sin\(phase\)[\s\S]*?color\s*\n\s*\}\)/);
  assert.doesNotMatch(galaxy, /particle\.phase|particle\.kind/);
  assert.match(galaxy, /context\.fillRect\(x, y, particle\.size, particle\.size\);\s*\}[^\n]*\n\s*\/\/[^\n]*\n\s*particles = \[\];/);
});

test("loan exhaustion checks all defined tiers and tolerates partial server flags safely", () => {
  assert.match(js, /function hasUsedAllLoans\(flags = game\.loansTaken\)\s*\{\s*return Object\.keys\(LOANS\)\.every\(\(principal\) => Boolean\(flags\?\.\[principal\]\)\);/);
  assert.match(js, /const responseLoanFlags = \{ \.\.\.game\.loansTaken, \.\.\.\(response\.state\?\.loansTaken \|\| \{\}\) \};\s*const allLoansUsed = hasUsedAllLoans\(responseLoanFlags\);/);
});

test("round settlement chooses one modal path per server response", () => {
  const match = js.match(/async function finishFromServerResult\(response, roundId\)\s*\{([\s\S]*?)\n  \}\n\n  function showCashoutPending/);
  assert.ok(match, "Settlement handler should remain easy to audit");
  assert.match(match[1], /applyState\(response\.state, response\.profile, \{ updateModals: false \}\)/);
  assert.match(match[1], /if \(response\.defaultedLoan \|\| response\.state\.gameOver\)[\s\S]*?else if \(response\.state\.waitingForLoan && response\.state\.balance <= 0\)[\s\S]*?else \{/);
});


test("API requests have a bounded timeout that also covers reading the response body", () => {
  assert.match(js, /const API_REQUEST_TIMEOUT_MS = 12_000/);
  assert.match(js, /import \{ ApiError, createApiClient \} from "\.\/api-client\.js"/);
  assert.match(apiClient, /new AbortController\(\)/);
  assert.match(apiClient, /text = await response\.text\(\);/);
  assert.match(apiClient, /controller\.abort\(\)/);
  assert.match(apiClient, /if \(timeoutId !== null\) clearTimeout\(timeoutId\)/);
  assert.match(apiClient, /const maxAttempts = options\.idempotencyKey \? 2 : 1/);
});


test("a round start repairs a missing client seed before contacting the start endpoint", () => {
  const start = js.indexOf("async function startRound(source, identifier = null)");
  const end = js.indexOf("async function finishFromServerResult", start);
  assert.ok(start >= 0 && end > start, "Round start should remain a self-contained flow");
  const body = js.slice(start, end);
  assert.ok(body.indexOf("await ensureClientSeed();") >= 0);
  assert.ok(body.indexOf("await ensureClientSeed();") < body.indexOf('api("/api/round/start"'));
});

test("an uncertain cash-out result resumes status polling if the round is still active", () => {
  const start = js.indexOf("async function cashOut()");
  const end = js.indexOf("function releaseHold", start);
  assert.ok(start >= 0 && end > start, "Cash-out should remain a self-contained flow");
  const body = js.slice(start, end);
  assert.match(body, /await pollRoundStatus\(\);\s*if \(game\.active && !game\.cashoutPending\) scheduleStatusPoll\(\);/);
});


test("release during round startup uses a parallel, idempotent release intent", () => {
  assert.match(js, /function sendEarlyReleaseIntent\(\)[\s\S]*?api\("\/api\/round\/release-intent"/);
  assert.match(js, /const startKey = game\.startRequestKey;[\s\S]*?body: \{ startKey, requestedMultiplierCents: 100 \}/);
  assert.match(js, /if \(response\.result && response\.roundId && response\.state\)/);
  assert.match(js, /releaseResult\?\.releaseMode === "settled"/);
});


test("cash-out cancels an in-flight read-only status poll", () => {
  assert.match(js, /pollAbortController: null/);
  assert.match(js, /function cancelStatusPollingForCashout\(\)[\s\S]*?game\.pollAbortController\.abort\(\)/);
  assert.match(js, /pollRoundStatus\(\)[\s\S]*?signal: pollController\.signal/);
  assert.match(js, /if \(game\.cashoutPending \|\| pollController\?\.signal\.aborted\) return/);
  assert.match(js, /showCashoutPending\(\)[\s\S]*?cancelStatusPollingForCashout\(\)/);
});

test("window blur during startup sends the same early-release intent path", () => {
  const start = js.indexOf("function releaseAnyHold() {");
  const end = js.indexOf("function focusFirst", start);
  assert.ok(start >= 0 && end > start);
  assert.match(js.slice(start, end), /if \(game\.startPending && game\.holdSource\)[\s\S]*?sendEarlyReleaseIntent\(\)/);
});


test("round startup never waits on a parallel release-intent request", () => {
  const start = js.indexOf("async function startRound(source, identifier = null)");
  const end = js.indexOf("async function finishFromServerResult", start);
  assert.ok(start >= 0 && end > start);
  const body = js.slice(start, end);
  assert.doesNotMatch(body, /await game\.releaseIntentPromise/);
  assert.match(body, /const releaseResult = released \? game\.releaseIntentResult : null/);
  assert.match(body, /if \(released\) await cashOut\(\)/);
});


test("fallback cash-out reuses the release-intent idempotency key", () => {
  assert.match(js, /game\.releaseCashoutKey = `early_\$\{releaseKey\}`/);
  assert.match(js, /game\.activeRound = \{ \.\.\.response\.round, cashoutKey: released \? game\.releaseCashoutKey : null \}/);
  assert.match(js, /if \(game\.activeRound\) game\.activeRound\.cashoutKey = releaseCashoutKey \|\| null/);
});


test("client opens an authenticated WebSocket for prompt server settlement events", () => {
  assert.match(js, /new WebSocket\(`\$\{wsBase\}\/api\/round\/events`, \["gamba-events-v1", `gamba-auth\.\$\{game\.token\}`\]\)/);
  assert.match(js, /payload\.type !== "round-settled"/);
  assert.match(js, /pendingSettlementEvent/);
  assert.match(js, /scheduleEventReconnect/);
});

test("server-push settlement is guarded against races with HTTP responses and polling", () => {
  assert.match(js, /game\.settlingRoundId === roundId/);
  assert.match(js, /finishFromServerResult\(payload, payload\.roundId\)/);
  assert.match(js, /if \(game\.activeRound\?\.id === payload\.roundId\)/);
});


test("round multiplier uses a server-anchored monotonic clock and syncs on start", () => {
  assert.match(js, /import \{ calculateVisibleMultiplier, estimateServerTime, nextServerTimeAnchor \} from "\.\/round-clock\.js"/);
  assert.match(js, /function estimatedServerTime\(\)[\s\S]*?estimateServerTime\(/);
  assert.match(roundClock, /export function estimateServerTime/);
  assert.match(roundClock, /export function nextServerTimeAnchor/);
  assert.match(js, /syncServerClock\(response\.serverTime\)/);
  const match = js.match(/function updateRoundFrame\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(match, "The frame updater should remain easy to audit");
  assert.match(match[1], /calculateVisibleMultiplier\(/);
  assert.match(match[1], /estimatedServerTime\(\)/);
  assert.doesNotMatch(match[1], /Date\.now\(\)/, "Local wall-clock skew must not drive the multiplier");
});


test("status fallback polls faster without a healthy settlement WebSocket", () => {
  assert.match(js, /const STATUS_FALLBACK_POLL_MS = 250/);
  const match = js.match(/function scheduleStatusPoll\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(match, "Status polling should remain a small, auditable function");
  assert.match(match[1], /game\.eventSocket\?\.readyState === WebSocket\.OPEN/);
  assert.match(match[1], /const baseDelay = pushConnected \? STATUS_POLL_MS : STATUS_FALLBACK_POLL_MS/);
  assert.match(js, /Switch back to the low-traffic watchdog as soon as push delivery is healthy/);
});


test("cash-out sends the exact visible multiplier as a cent-rounded cap", () => {
  assert.match(js, /function getVisibleMultiplierCents\(\)[\s\S]*?elements\.multiplier\.textContent/);
  assert.match(js, /body: \{ roundId, requestedMultiplierCents \}/);
  assert.match(js, /body: \{ startKey, requestedMultiplierCents: 100 \}/);
  assert.match(renderer, /const shownCents = Math\.max\(100, Math\.min\(maxMultiplier \* 100, Math\.floor\(game\.multiplier \* 100\)\)\)/);
});


test("hold control suppresses iOS text selection and touch callouts without removing keyboard support", () => {
  assert.match(css, /-webkit-user-select:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
  assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(js, /for \(const eventName of \["selectstart", "contextmenu", "dragstart"\]\)/);
  assert.match(js, /event\.code !== "Space" && event\.code !== "Enter"/);
});

test("temporary timing diagnostics are absent from the production client", () => {
  for (const marker of [
    "gamba.debugTiming",
    "timingDebugEnabled",
    "beginCashoutTiming",
    "recordCashoutRequestTiming",
    "logCashoutTiming",
    "logRoundOutcomeTiming",
    "[gamba timing]",
    "serverProcessingMs"
  ]) {
    assert.doesNotMatch(js, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `Production client should not contain temporary diagnostic marker: ${marker}`);
  }
});


test("browser helpers are split by responsibility without changing the game DOM contract", () => {
  assert.match(html, /<script type="module" src="game\.js">/);
  assert.match(js, /from "\.\/browser-storage\.js"/);
  assert.match(browserStorage, /export function readStoredSession/);
  assert.match(browserStorage, /export function storeLastReveal/);
  assert.match(js, /import \{ verifyFairnessHistory \} from "\.\/fairness-client\.js"/);
  assert.match(js, /import \{ ApiError, createApiClient \} from "\.\/api-client\.js"/);
  assert.match(fairnessClient, /export async function verifyFairnessHistory\(api, onProgress/);
  assert.doesNotMatch(fairnessClient, /document\.querySelector|document\.getElementById/);
  assert.match(js, /import \{ createGameRenderer \} from "\.\/game-renderer\.js"/);
  assert.match(renderer, /export function createGameRenderer/);
  assert.doesNotMatch(renderer, /fetch\(|createApiClient|startRound\(/);
});
