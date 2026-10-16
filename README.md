# gamba

A browser-based crash game built with vanilla JavaScript and a Cloudflare Worker backend. The interface handles presentation; a SQLite-backed Durable Object owns each anonymous player's balance, rounds, loans and settlement.

## Technical highlights

- **Server-authoritative gameplay:** serialized wallet updates, server-timed cash-outs, alarm-based settlement and idempotent retries.
- **Low-latency early release:** if a player releases while round startup is in flight, the client sends an idempotent release intent in parallel. The Durable Object either settles an already-committed round or atomically consumes the intent when creating it. The server uses its own receipt/start times; no client timestamp or optimistic payout is trusted. A pre-commit release settles at x1.00, with the normal bust-at-x1 rule still enforced.
- **Cryptographic fairness:** SHA-256 seed commitments, HMAC-SHA-256 outcomes, AES-256-GCM encryption for unrevealed seeds at rest, and independent verification after seed reveal.
- **API hardening:** signed HMAC bearer tokens, exact-origin CORS, bounded JSON parsing, non-cacheable responses and security headers.
- **Recovery and persistence:** Durable Object alarms settle unattended rounds; session state, up to 100 recent server-side history records, lifetime statistics and personal top-five payouts survive tab closure in the same browser profile. State responses include only the latest 10 history rows shown by the UI, limiting routine response and idempotency-cache payload sizes without trimming stored round rows or fairness records.
- **Automated testing:** integration and regression coverage for concurrency, retries, round settlement, loans, seed verification, alarms and session isolation; GitHub Actions runs checks on pushes and pull requests.
- **Responsive UI:** dependency-free HTML, CSS and JavaScript, pointer/keyboard controls, reduced-motion support and a compact mobile layout.

## Crash-point generation

Each round is derived from a deterministic HMAC-SHA-256 digest:

```text
digest = HMAC-SHA-256(serverSeed, clientSeed:nonce)
U = first_52_bits(digest) / 2^52
crash_cents = max(100, floor((100 - e) / (1 - U)))
crash_multiplier = crash_cents / 100
```

`U` is in the range `[0, 1)`. The value `e` is the house edge in percentage points, so `1` means a 1% edge. The result is rounded down to whole cents, with a minimum crash multiplier of `1.00×`.

### Seed verification

Before using a server seed, the backend publishes its SHA-256 commitment. When that seed is rotated out, it is revealed so anyone can check the commitment and recompute recorded outcomes from the client seed and nonce. This verifies that the published records match the committed seed and formula; it does **not** prove that no round was omitted or that the deployed code was never changed.

## Engineering decisions

- **Consistency:** Durable Object execution and SQLite transactions serialize state-changing actions and protect against concurrent starts. Early-release intents are consumed in the same transaction that creates/settles the round, so the quick-release path cannot double-credit a wallet.
- **Retry safety:** idempotency keys make repeated start, early-release, cash-out, loan and reset requests replay their original response instead of applying the action twice.
- **Warm-start crypto optimization:** the Worker caches a non-extractable session-token verification `CryptoKey` by a one-way fingerprint of the secret, avoiding key import on each authenticated request while honoring secret rotation. Each Durable Object also caches a non-extractable HMAC `CryptoKey` keyed to the current seed epoch and commitment. The encrypted server seed is decrypted/imported on a cold instance or after rotation, but plaintext is not retained as a field and ordinary warm round starts avoid repeated AES decryption and HMAC key import. Concurrent cold starts in the same epoch share one in-flight key derivation, and an older epoch cannot overwrite the cache after a reset races key import. A rotated commitment automatically replaces the cached key.
- **Non-blocking alarm housekeeping:** after a durable settlement transaction commits, cleanup of the old alarm runs through `waitUntil` instead of holding up the payout response. Cleanup checks the active round ID so an old round cannot delete a newer round's alarm; alarm settlement itself remains durable and server controlled. The browser cancels an in-flight read-only status poll when cash-out begins, avoiding unnecessary client/network work alongside the critical request; server-side work already received may still finish safely.
- **Unattended lifecycle:** Durable Object alarms settle rounds without depending on a connected browser.
- **Numerical determinism:** fixed 52-bit input and integer division keep cent rounding reproducible across clients.
- **Low-overhead cosmic background:** the Canvas dust field is rasterized at startup or resize, then moved with a slow CSS transform instead of a JavaScript particle loop. Temporary particle records are discarded after painting; reduced-motion preferences disable the drift, and star trails remain on their own layer.
- **Bounded frontend requests:** API calls time out even while a response body is being read. Retried mutations reuse the same idempotency key, and a later round start repairs a missing client seed after a partially completed reset. If a cash-out response is uncertain, status polling resumes until the server settles the round. A release that arrives during startup is sent in parallel with the start request. The client uses a release-intent result if it has already arrived; otherwise it submits the regular cash-out immediately after the start response instead of blocking on the secondary request. Both requests share the same cash-out idempotency key and the Durable Object's serialized settlement safeguards, so a fallback request can recover the first result without double-crediting or an extra status lookup. Release on window blur/page hide follows the same intent path as pointer or keyboard release.

## Run locally

Requirements: Node.js 22+ and Python 3.

```powershell
cd backend
npm.cmd install
npm.cmd test
```

Commit the generated `backend/package-lock.json` for reproducible installs. If npm 11 blocks `esbuild` or `workerd` install scripts, review and approve them with `npm.cmd install-scripts approve esbuild workerd`, then rerun installation.

For local development, create `backend/.dev.vars` with development-only `SESSION_SECRET` and `SEED_ENCRYPTION_KEY` values; it is ignored by Git. From the repository root, serve the frontend in a separate terminal:

```powershell
py -m http.server 5500
```

Open `http://localhost:5500`; do not use a `file://` URL. `backend-config.js` contains the public Worker URL, not a secret.

## Deploy

1. Set `ALLOWED_ORIGINS` in `backend/wrangler.toml` to comma-separated exact origins, such as `"http://localhost:5500,https://USERNAME.github.io"`. Use origins only; omit the repository path.
2. Authenticate Wrangler and configure `SESSION_SECRET` and `SEED_ENCRYPTION_KEY` if needed.
3. Run `npm.cmd test` from `backend/`; deploy only after the suite passes with `npm.cmd run deploy`.
4. Enable GitHub Pages for the repository root, keeping `index.html`, `styles.css`, `game.js`, `backend-config.js` and `honk-icon.png` at the root.

Never commit secrets, `.dev.vars`, tokens, local backups or `node_modules`. Back up both secrets securely; losing or replacing the encryption key without migrating data makes unrevealed seeds unreadable. Anonymous session data is tied to the same browser profile and does not sync across devices.
