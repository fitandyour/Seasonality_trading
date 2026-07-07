# Trading Seasonals Dashboard

Private dashboard: daily Scarr seasonality pull → setup scoring → flagged spread trades.
Phase 1 spec: docs/superpowers/specs/2026-07-07-trading-seasonals-dashboard-design.md

## Environment variables (Railway)

| Var | Purpose |
|---|---|
| DATABASE_URL | Railway Postgres (auto-injected) |
| SESSION_SECRET | random 32+ char string for session cookies |
| ADMIN_EMAIL / ADMIN_PASSWORD | the single login account (seeded at boot) |
| SCARR_USERNAME | Scarr account username (the servlets are parameterized by user; no login/password needed — see docs/scarr-endpoints.md) |
| PGSSL | set to `require` only if the DB needs SSL |

Schema self-migrates at boot. Deploys on git push (Railway GitHub integration).
Run tests: `npm test` (pure unit tests, no DB needed).
