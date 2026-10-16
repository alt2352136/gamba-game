# gamba

A browser-based crash game built with vanilla JavaScript and Cloudflare Workers. Each player session is backed by a SQLite-backed Durable Object that owns the balance, loans, round state, and settlement. The browser handles input and presentation; the server decides outcomes and payouts.

## Technical highlights

- **Transactional gameplay:** Per-session Durable Objects serialize mutations. A durable start reservation plus edge-received timestamps prevent overlapping start requests from opening a second round—even if the first crashes instantly at `1.00×`. SQLite transactions and idempotency keys protect wallet mutations; Durable Object alarms settle rounds if the browser disconnects.
- **Verifiable outcomes:** Each server seed is committed by SHA-256 before use. HMAC-SHA-256 and the first 52 digest bits determine the crash point; unrevealed seeds are encrypted with AES-256-GCM and revealed at rotation. Verification can reproduce recorded outcomes, but cannot prove that no round was omitted or that deployed code never changed.
- **Low-latency round handling:** An authenticated WebSocket pushes settlement events. An idempotent release-intent endpoint handles a release that arrives while round startup is still in flight, avoiding an unnecessary sequential request. Adaptive status polling provides recovery when push is unavailable; settlement remains server-controlled.
- **Security controls:** Signed session tokens, exact-origin CORS, bounded request bodies, and Cloudflare-managed secrets protect the API boundary. Non-extractable `CryptoKey` objects are cached for warm requests without caching a plaintext server seed as a long-lived field.
- **Regression tests and CI:** Node tests cover deterministic outcomes, malformed requests, authentication, duplicate operations, concurrent starts, loan rules, alarms, and event-delivery recovery. GitHub Actions runs checks on pushes and pull requests.
- **Efficient client rendering:** The cosmic dust field is rasterized once and moved with CSS rather than recalculating every particle per frame. The client pauses work when the page is hidden, requests only the ten history entries it displays, and uses pointer capture with touch-selection suppression plus keyboard controls for the hold interaction.

## How the crash multiplier is calculated

For each round, the server computes an HMAC-SHA-256 digest from the server seed, client seed, and round nonce. The first 52 digest bits become an integer `r`, where `D = 2^52`:

```text
digest = HMAC-SHA-256(serverSeed, clientSeed:nonce)
r = integer represented by the first 52 digest bits
D = 2^52
crashCents = max(100, floor((100 - e) * D / (D - r)))
crashMultiplier = crashCents / 100
```

`e` is the house edge in percentage points (`1` means a 1% edge). The result is rounded down to cents and never falls below `1.00×`. The implementation also bounds the extreme tail well above the game's `10×` cash-out cap. The same seed, nonce, and edge reproduce the same result.

### Timing and verification limits

The browser estimates the multiplier from a server timestamp using `performance.now()`, so changes to the local system clock do not drive the display. On release, the client sends the cent-rounded multiplier it actually displayed as a **maximum requested payout multiplier**. The server still checks the committed crash point against its own clock first, and caps a successful cash-out at the lower of that request and the server's live multiplier; a request that arrives after the crash still loses. If a release reaches the server at the x10 boundary before the automatic alarm settles the round, the same visible-value cap applies. If the automatic x10 settlement commits first, its result stands. This avoids upward jumps in successful cash-out results without trusting the client to declare that a round survived. Network delivery and platform scheduling can still delay crash notifications, and the display remains an estimate. The crash point is not sent while a round is running.

The server publishes a SHA-256 commitment before using a seed and reveals the seed at rotation. This lets anyone recompute recorded results against the commitment and formula, but it does not prove the completeness of the public history or the immutability of deployed code.

## Run locally

Requirements: Node.js 22+ and Python 3.

```powershell
cd backend
npm.cmd install
npm.cmd test
```

Commit the generated `backend/package-lock.json` for reproducible installs. If npm blocks the `esbuild` or `workerd` install scripts, review and approve them, then rerun installation. For the frontend, start a server from the repository root in a separate terminal:

```powershell
py -m http.server 5500
```

Open `http://localhost:5500`; do not use a `file://` URL. `backend-config.js` contains the public Worker URL, not a secret.

## Deploy

1. Set `ALLOWED_ORIGINS` in `backend/wrangler.toml` to comma-separated exact origins such as `"http://localhost:5500,https://USERNAME.github.io"`. Do not include the repository path.
2. Configure `SESSION_SECRET` and `SEED_ENCRYPTION_KEY` as Cloudflare Worker secrets. Never put their values in Git.
3. Run `npm.cmd test` from `backend/`; deploy only after the full suite passes, using `npm.cmd run deploy`.
4. Enable GitHub Pages from the repository root, keeping `index.html`, `styles.css`, `game.js`, `backend-config.js`, and `honk-icon.png` at the root.

Back up both secrets securely. Losing or replacing the encryption key without migrating stored data makes unrevealed seeds unreadable. Anonymous session data persists in the same browser profile and does not sync across devices.
