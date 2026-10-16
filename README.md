# gamba

A browser-based crash game built with vanilla JavaScript and a Cloudflare Worker backend. The interface handles presentation; a SQLite-backed Durable Object owns each anonymous player's balance, rounds, loans and settlement.

## Technical highlights

- **Server-authoritative gameplay:** serialized wallet updates, server-timed cash-outs, alarm-based settlement and idempotent retries.
- **Cryptographic fairness:** SHA-256 seed commitments, HMAC-SHA-256 outcomes, AES-256-GCM encryption for unrevealed seeds at rest, and independent verification after seed reveal.
- **API hardening:** signed HMAC bearer tokens, exact-origin CORS, bounded JSON parsing, non-cacheable responses and security headers.
- **Recovery and persistence:** Durable Object alarms settle unattended rounds; session state, round history, statistics and personal top-five payouts survive tab closure in the same browser profile.
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

- **Consistency:** Durable Object execution and SQLite transactions serialize state-changing actions and protect against concurrent starts.
- **Retry safety:** idempotency keys make repeated start, cash-out, loan and reset requests replay their original response instead of applying the action twice.
- **Unattended lifecycle:** Durable Object alarms settle rounds without depending on a connected browser.
- **Numerical determinism:** fixed 52-bit input and integer division keep cent rounding reproducible across clients.

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
