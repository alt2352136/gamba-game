# Security notes

- Never commit Cloudflare secrets, `.dev.vars`, session tokens, revealed test keys, local backups or dependency folders.
- The anonymous session token is kept in browser local storage to recover a game after refresh or browser restart. Anyone who obtains it can access that session; clear site data on shared devices.
- The API uses an exact-origin CORS allowlist, signed bearer tokens, bounded JSON bodies, idempotency keys, server-side validation and non-cacheable responses. CORS is not authentication and does not stop direct scripts.
- No app-level gameplay throttles are enabled. The public session-creation endpoint can still be automated, and sufficiently high traffic can exhaust the shared Cloudflare Free quotas. Protecting session creation with an optional one-time challenge could reduce bot abuse, but would add friction; it is intentionally not enabled in this unrestricted-play build.
- A failed API request must never trigger local balance changes or locally generated outcomes. If the backend is unavailable, gameplay pauses until authoritative state can be reconciled.
- The application has no payment processing or real-money account features. Do not add personal or payment data without a separate security and privacy review.
- For a security concern, contact the repository owner privately; never post tokens or secrets in a public issue.
