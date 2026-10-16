import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [html, js, css] = await Promise.all([
  readFile(resolve(root, "index.html"), "utf8"),
  readFile(resolve(root, "game.js"), "utf8"),
  readFile(resolve(root, "styles.css"), "utf8")
]);

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
  const match = js.match(/function initGalaxyCanvas\(\)\s*\{([\s\S]*?)\n  \}\n  async function boot/);
  assert.ok(match, "Galaxy renderer should remain a self-contained function");
  assert.match(match[1], /function drawStaticField\(\)/);
  assert.match(match[1], /drawStaticField\(\)/);
  assert.doesNotMatch(match[1], /requestAnimationFrame|setInterval/);
  assert.match(css, /animation:\s*galaxy-drift/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("rendered particle data excludes metadata no longer needed after construction", () => {
  assert.match(js, /particles\.push\(\{[\s\S]*?x:\s*x\s*\+\s*Math\.sin\(phase\)[\s\S]*?color\s*\n\s*\}\)/);
  assert.doesNotMatch(js, /particle\.phase|particle\.kind/);
  assert.match(js, /context\.fillRect\(x, y, particle\.size, particle\.size\);\s*\}[^\n]*\n\s*\/\/[^\n]*\n\s*particles = \[\];/);
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
  assert.match(js, /new AbortController\(\)/);
  assert.match(js, /text = await response\.text\(\);/);
  assert.match(js, /controller\.abort\(\)/);
  assert.match(js, /if \(timeoutId !== null\) clearTimeout\(timeoutId\)/);
  assert.match(js, /const maxAttempts = options\.idempotencyKey \? 2 : 1/);
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
