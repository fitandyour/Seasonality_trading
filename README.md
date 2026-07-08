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
| ANTHROPIC_API_KEY | Claude API key for the analog expert reads. Optional — without it the dashboard shows the computed analog verdict; with it Claude writes the recommendation. |
| ANALYSIS_MODEL | Optional. Override the analysis model (default `claude-opus-4-8`). |
| PGSSL | set to `require` only if the DB needs SSL |

## Analysis engine

Per strategy, per day: pull the current year + the 5 most recent years from
Scarr, compute year-by-year analog features (similarity, what each year did
next, opposite-side risk) in code, then Claude reads that table and writes the
ranked recommendation. See docs/superpowers/specs for the design.

Schema self-migrates at boot. Deploys on git push (Railway GitHub integration).
Run tests: `npm test` (pure unit tests, no DB needed).
