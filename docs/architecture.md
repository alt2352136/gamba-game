# Architecture and important invariants

## Overview

`gamba` is a browser client backed by a Cloudflare Worker and one SQLite-backed Durable Object per session. The browser is responsible for input, display and reconnect behavior. The server is the source of truth for the balance, round status, crash outcome, loans and settlement.

## Source layout

- `game.js` owns the active game state and coordinates round lifecycle, input and recovery.
- `round-clock.js` contains the small, pure calculations used to estimate server time and render the visible multiplier. It does not decide whether a cash-out succeeds; only the server does.
- `browser-storage.js` handles saving and restoring the guest session and the last revealed fairness seed, including the migration from the older tab-only session storage. Storage failures do not replace the server as the source of truth.
- `api-client.js` handles authenticated HTTP requests, timeouts, idempotent retries and API errors; it reads the current session token through a small callback instead of owning game state.
- `game-renderer.js` updates the DOM from supplied current state. It does not make network requests or decide game outcomes.
- `galaxy-background.js` paints the existing static particle field. It is isolated from wallet and round state; its rendering algorithm and styles are intentionally unchanged.
- `fairness-client.js` retrieves paginated public history and verifies revealed commitments and completed rounds. It reports results to `game.js`; it does not access the DOM.
- `backend/src/index.js` is the HTTP Worker entry point. It validates browser origins, authenticates session requests, forwards requests to the Durable Object and applies the CORS response headers.
- `backend/src/api-utils.js` owns the common JSON response, bounded JSON parsing and expected API error helpers.
- `backend/src/database-schema.js` contains table creation, indexes and the existing compatibility migration.
- `backend/src/session-stats.js` records settled-round statistics and reads the profile/leaderboard. The Durable Object calls these functions so statistics remain part of the caller’s existing transaction while their SQL is easier to review separately.
- `backend/src/game-rules.js` holds the named game constants and cash-out multiplier validation/calculation.
- `backend/src/seed-crypto.js` encrypts server seed records at rest and decrypts them only when required by round processing.
- `backend/src/game-session.js` contains the `GameSession` Durable Object, including SQLite transactions, round lifecycle, alarms and WebSocket settlement events. Transactions stay in the session layer so balance and round changes remain atomic.
- `backend/src/auth.js` signs and verifies session tokens and keeps the warm verifier-key cache.
- `backend/src/crypto-utils.js` contains small shared encoding and Web Crypto helpers.
- `backend/src/fairness.js` contains the crash-point formula used by the Worker.
- `backend/src/request-logging.js` emits structured operational error logs without logging request bodies or credentials.
- `tools/verify-fairness.js` independently checks an exported record set using Node's `node:crypto`, rather than importing the Worker crash formula.

## Invariants to preserve

1. **Only the server settles a round.** The client-supplied cash-out multiplier is a ceiling. The server's own time and committed crash point determine whether it succeeds and its maximum payout.
2. **Wallet changes and the corresponding round/response records stay in SQLite transactions.** Do not split a transaction merely to make files smaller.
3. **Mutating requests use idempotency keys.** A retry after a lost response must not deduct a second stake or issue a second loan.
4. **Start reservations and early-release intents are part of the round lifecycle.** They cover requests arriving close together and must be preserved when changing the state flow.
5. **Alarms and status requests may race with cash-out.** The round's status is checked again before settlement so only one terminal transition is committed.
6. **Fairness records do not reveal an active round's crash point.** Seed records and round history are retained because deleting them would weaken historical verification.
7. **The client clock is only a display estimate.** The server remains authoritative even if the browser clock, animation or network is delayed.

## Error diagnostics

Unexpected failures return a generic `internal_error` response with a request ID. The Worker and Durable Object log structured error metadata using that same ID where available, plus the method and path. Request bodies, session tokens, and seed material should never be included in logs. Expected API errors are returned as normal client errors and are not logged as server faults.

## Data retention

Historical rounds and seed commitments/reveals are not automatically pruned: they are part of the fairness audit trail. Old early-release intents are removed after their short hand-off window. The `round-start` response cache can be pruned after 30 days because the same response is also stored on the persistent round record and the unique round idempotency key remains available for replay lookup. Other mutation idempotency responses are retained to preserve exact retry responses for operations such as cash-out, loans and reset; pruning those without a separate durable replay strategy could change retry behavior.

A session is not automatically deleted by this change. Session expiry and whole-session deletion would affect saved user history and should be designed explicitly rather than hidden inside routine cleanup.

## Verification limits

A valid fairness verification proves that the supplied, revealed seed matches its commitment and that supplied round outcomes follow the published formula. It cannot prove that the export contains every round or that the deployed source code has never changed. See [fairness verification](fairness-verification.md).

## Test layout

- `backend/test/` contains backend utility, Durable Object/session, and local Worker integration tests. Tests of `GameSession` import it from `game-session.js`; public HTTP behavior is covered through the integration test and the Worker entry point.
- `tests/frontend/` contains browser storage, API-client, fairness-client, round-clock, and DOM/API contract tests.
- Run `npm.cmd test` from `backend/` to execute both sets. The integration test launches a temporary local Wrangler instance and requires `npm.cmd ci` to complete first.
