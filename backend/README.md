# Backend

Cloudflare Worker API with one SQLite-backed Durable Object per anonymous game session. The Durable Object serializes wallet changes, stores round/seed records and uses alarms to settle rounds without a connected browser.

## Local development

Requirements: Node.js 22+. From this directory, run:

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dev
```

Keep the generated `package-lock.json` in Git for reproducible installs. If npm 11 reports blocked scripts for `esbuild` or `workerd`, review and approve those Wrangler dependencies with `npm.cmd install-scripts approve esbuild workerd`, then rerun `npm.cmd install`.

The Worker listens on `http://localhost:8788`; serve the frontend separately from the repository root at `http://localhost:5500`.

Before using `npm.cmd run dev`, create a local `.dev.vars` file with fresh development-only secrets. The file is ignored by Git:

```powershell
$sessionSecret = (node -p "require('crypto').randomBytes(32).toString('hex')").Trim()
$seedKey = (node -p "require('crypto').randomBytes(32).toString('base64')").Trim()
@"
SESSION_SECRET="$sessionSecret"
SEED_ENCRYPTION_KEY="$seedKey"
"@ | Set-Content -Encoding ascii .dev.vars
Remove-Variable sessionSecret, seedKey
```

The integration suite starts a temporary local Worker with test-only secrets and isolated storage. It never calls production. The formula, loan, alarm and guardrail tests run as regular Node tests.

## Secrets

Set secrets with Wrangler. Never add them to `wrangler.toml`, frontend files or Git:

- `SESSION_SECRET`: a private random value used to sign session tokens.
- `SEED_ENCRYPTION_KEY`: Base64 encoding of 32 cryptographically random bytes, used to encrypt server seeds at rest.

Example PowerShell command to generate and upload an encryption key without using the clipboard:

```powershell
$key = (node -p "require('crypto').randomBytes(32).toString('base64')").Trim()
if ($key.Length -ne 44 -or $key -notmatch '^[A-Za-z0-9+/]{43}=$') { throw "Invalid key format" }
$key | .\node_modules\.bin\wrangler.cmd secret put SEED_ENCRYPTION_KEY
Remove-Variable key
```

Generate `SESSION_SECRET` independently. Back up both securely. Replacing or losing `SEED_ENCRYPTION_KEY` without migrating stored data makes unrevealed seeds unreadable.

## Deploy

1. Set `ALLOWED_ORIGINS` in `wrangler.toml` to comma-separated exact origins, for example `"http://localhost:5500,https://USERNAME.github.io"`. Origins include scheme and hostname only, not the repository path.
2. Authenticate and configure secrets if needed:

   ```powershell
   npx.cmd wrangler login
   npx.cmd wrangler secret put SESSION_SECRET
   npx.cmd wrangler secret put SEED_ENCRYPTION_KEY
   ```

3. From this folder, run `npm.cmd test`. Deploy only after the suite passes:

   ```powershell
   npm.cmd run deploy
   ```

## Design notes

- The API uses signed bearer tokens, exact-origin CORS, bounded JSON bodies, idempotency keys and non-cacheable responses with basic security headers. CORS isn't API authentication.
- Round status is checked by the browser once per second while visible; hidden tabs pause polling. Durable Object alarms settle unattended rounds.
- Unnecessary per-action audit-table writes and duplicated start-response payload storage are avoided. Authoritative state, seed commitments, round history, required idempotency records and session statistics remain persisted.
- Gameplay has no application-level cooldowns or round caps; game state and settlement remain server-authoritative.
- Seed commitment/reveal checks consistency between the published commitment and recorded deterministic outcomes. It is not an independent audit that proves no round was withheld.
