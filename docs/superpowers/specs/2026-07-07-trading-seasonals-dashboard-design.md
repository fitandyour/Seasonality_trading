# Trading Seasonals Dashboard — Design

**Date:** 2026-07-07
**Status:** Approved by Henk (2026-07-07)

## Purpose

A private, login-gated web app on Railway that turns Henk's saved
scarrtrading.com seasonality/spread strategies into a daily list of
flagged trade setups, backed by AI technical analysis of pasted chart
screenshots and a daily fundamentals research brief per commodity.

Build priority: (1) Scarr seasonality ingestion + scoring →
(2) Vision TA page → (3) daily fundamentals + AI verdicts.

## Constraints

- Completely separate from the CRM: own repo, own Railway service, own
  Postgres database. No shared code or data.
- Scarr credentials and the Anthropic API key live only in Railway
  environment variables — never in code, never in chat.
- No HTML crawling/scraping of Scarr. Ingestion replays only the JSON
  data requests the user's own browser makes for his own saved charts,
  once daily, under his paid subscription. Scarr's Terms of Sale ban
  robots/spiders/crawlers/scrapers "to gather data" but say nothing
  about automated logins; the user has reviewed this and accepts the
  approach. The ingestion module is isolated behind an interface so it
  can be swapped for the Export Charts file + manual URL paste if Scarr
  ever objects.
- Single user. Dashboard only — no email/WhatsApp push.
- All AI output is framed as probabilistic analysis, never a buy/sell
  instruction.

## Architecture

Node.js + Express monolith on Railway, mirroring the CRM's operational
shape the user already runs:

- Server-rendered pages (EJS views), session-cookie auth
  (email/password, bcrypt, single account seeded from env vars).
- Railway Postgres; schema self-migrates at boot.
- In-process cron: daily sync ~07:00 Europe/Amsterdam (after US futures
  settle and Scarr updates), plus a "Sync now" button.
- Deploys on git push to GitHub (Railway auto-deploy).
- Anthropic API: vision for chart screenshots, web search tool for
  fundamentals, text for setup verdicts.

Modules (each a separate file with a narrow interface):

| Module | Responsibility |
|---|---|
| `scarr.js` | Login, enumerate saved charts, fetch per-strategy year series |
| `scoring.js` | Pure functions: analog-year matching features + ranking |
| `analysis.js` | Claude expert read per strategy from analog features + chart |
| `ta.js` | Vision TA: screenshot + notes → structured analysis |
| `fundamentals.js` | Daily web-search brief per commodity |
| `server.js` | Express app, routes, auth, cron wiring |
| `schema.js` | Boot-time migrations |

## 1. Scarr ingestion (seasonality engine)

- Daily job logs into Scarr with env-var credentials, pulls the saved
  charts list (the left "Saved Charts" panel), and for each strategy
  fetches the numeric series behind the amCharts chart: one line per
  contract-year (e.g. FC2027H/J/K … FC2020H/J/K).
- Each strategy's config is parsed and stored: legs, commodities,
  contract months, multipliers, long/short per leg, unit move, the
  saved years-back setting (the user's "5"), open/close window.
- **Discovery step (first implementation task):** the user logs into
  Scarr in Chrome; Claude watches network traffic via the Chrome
  extension to map the exact login flow and data endpoints. Captured
  JSON samples become test fixtures. No credentials typed into chat.
- **Fallback if endpoints are unworkable:** import via Scarr's Export
  Charts file (saved chart definitions) plus manual paste of chart
  URLs; same storage schema, so nothing downstream changes.

## 2. Analysis engine — analog-year matching + Claude expert reads

**Revised 2026-07-08 (hybrid approach).** The engine does NOT average
prior years into a seasonal band. Henk's requirement: compare **year by
year** and highlight setups where this year's developing pattern looks
like specific prior years that then made a high-probability move — with
the opposite-side risk always stated. Always use the **5 most recent
years** (current + 5 priors), regardless of what the saved chart stored.

**Deterministic features (code, grounded in real numbers).** Per
strategy, after aligning current + each prior year on the season
calendar, compute per prior year:

- **Analog similarity** — correlation of this year's path *so far* to
  that prior year's path over the same elapsed calendar span.
- **What it did next** — from today's calendar index to the window
  close: that year's net move, plus max favorable / max adverse
  excursion along the way.
- **Level distance** — how far today's spread sits from where that year
  was at the same calendar point.

Aggregate across the 5 years: directional **agreement** (how many moved
the same way next), the mean next-move, and the **opposite-side risk**
(how many / how far the disagreeing years went against). These are
stored per strategy per day and are the objective, hallucination-proof
inputs.

**Expert read (Claude).** Claude receives the per-year feature table,
the strategy metadata (legs, months, window, old-crop/new-crop
boundaries), and the rendered year-by-year chart, and produces the
ranked recommendation: direction, the specific analog years that match
("looks like 2022 and 2024, both fell ~X from here"), target levels, a
probability read, and the risk case if it breaks the other way. Claude
never invents a number — every price/level it cites comes from the
supplied features. If `ANTHROPIC_API_KEY` is absent, the dashboard still
shows the analog feature table and a deterministic ranking (by agreement
× similarity); the written reads switch on when the key is set.

Ranking/flagging: a tunable score derived from agreement × mean-similarity
× move-size, minus opposite-side risk; strategies above a tunable
threshold and inside their entry window are flagged.

Research basis: filtering beats forecasting (MRCI, SeasonAlgo, Barchart's
seasonal-spread filtering framework). The pivot from averaged bands to
explicit analog-year matching reflects that a seasonal average hides the
year-by-year agreement that actually signals a repeatable move.

## 3. Vision TA module

Page: upload/paste a chart screenshot + notes (commodity, timeframe,
question). Claude vision applies a full TA toolkit — trend structure
(HH/HL vs LH/LL), support/resistance, moving averages, momentum and
divergence, chart and candlestick patterns, volume if visible — and
returns:

- **Directional probability:** estimated X% up / Y% down for the next
  move on the chart's timeframe, with the reasoning.
- **Next targets both ways:** the specific nearest levels — MA, prior
  high/low, gap, measured-move objective — it would likely hit next in
  each direction.
- 2–3 "if X then Y" scenarios.

Framed as probabilistic analysis, not a trade instruction. Every read
is stored with its image and notes in a browsable history.

## 4. Fundamentals module

The daily job derives the commodity list from the saved strategies
(feeder cattle, live cattle, corn, KC/Chicago wheat, …deduplicated),
runs Anthropic web search per commodity, and stores a short daily
brief: supply/demand headlines, upcoming USDA/report dates, weather,
and spread-relevant notes. Shown on the dashboard and fed into setup
verdicts.

## 5. Dashboard

- **Home (post-login):** today's flagged setups ranked by Setup Score;
  each expands to a mini chart of the year lines, the four metrics, and
  Claude's verdict. Below: today's fundamentals briefs and recent TA
  reads. Sync-status indicator (last successful pull, failures).
- **Strategies page:** all saved strategies with current score/status.
- **TA page:** upload + history.
- **Admin/sync page:** per-strategy sync log, "Sync now", score
  threshold and weight tuning.

## 6. Error handling & ops

- Scarr login failure or endpoint change → banner "sync failed since
  [date]"; app keeps serving last good data; per-strategy sync results
  logged and visible on the admin page.
- Anthropic API failure degrades gracefully: scores still compute and
  display without verdicts; TA page reports the error and lets the user
  retry.
- Daily job is idempotent (re-running a day upserts, never duplicates).

## 7. Testing

- `scoring.js` is pure and unit-tested with fixture data (known year
  series → known metrics and score).
- Ingestion has a replay test against the JSON samples captured during
  discovery, so a Scarr format change breaks a test rather than
  silently corrupting data.
- Verdict/TA prompts are exercised with a smoke test behind an env
  flag (skipped in CI without an API key).

## 8. Build order

1. Repo scaffold, auth, Postgres schema, Scarr discovery + ingestion,
   scoring engine, dashboard with flagged setups.
2. Vision TA page with probability + targets output and history.
3. Daily fundamentals briefs + Claude verdicts wired into flags.
