# Scarr endpoint discovery notes (2026-07-08)

Captured with Henk logged into scarrtrading.com in Chrome, watching the
requests the SeasonalsGenerator page makes. All four endpoints responded
identically **without any session cookie** — no automated login is needed
or performed. Requests are parameterized by the Scarr username
(`SCARR_USERNAME` env var). Verified with curl from this machine.

## Flow per sync

1. **List saved charts**
   `GET /GetSavedChartsFromDynamoDBServlet?json=<username>`
   → JSON array of save names (the left "Saved Charts" panel).

2. **Fetch a saved chart's stored config**
   `POST /GetChartJsonFromDynamoDBServlet`
   form fields: `key=<saveName>`, `user=<username>`, `database=saved-charts`
   → `{"json": "<newGeneralForm JSON as string>"}`; empty `json` if the
   name doesn't exist. The inner JSON has the same keys as the
   `newGeneralForm` URL parameter on saved-chart links.

3. **List available contracts for the legs**
   `POST /GetContractsServlet`, form field `json=<sampleContract array>`
   (e.g. `["FC2021H","FC2021J","FC2021K"]`)
   → `[[ [leg1 contracts newest-first], [leg2 ...], ... ], ...]`.

4. **Roll the config forward (client-side, replicating the site's
   Contract Alignment feature).** Stored configs are stale — `selected`,
   `sampleContract`, `startDate` reflect whenever the chart was saved.
   Posting them unchanged returns only completed historical years and NO
   current-year line. The page rebuilds the selection anchored at the
   newest contracts before requesting data; our client does the same:
   keep each leg's month letters and per-leg year offsets from the first
   stored `selected` row, anchor the base year at the newest available
   contracts, and emit `yearsBack + 1` rows (row 0 = current year).

5. **Fetch chart data**
   `POST /ControllerServlet`, form field `json=<full form JSON>`
   → `{"unit":"d","values":[[yyyymmdd, v0, v1, ...], ...],
       "datasetName", "valueAxisLabels", "numberOfPanel1Series",
       "units", "color", "title", "digits", ...}`

## Data shape facts (verified)

- `values` rows: `[yyyymmdd int, one number-or-null per selected row]`.
  Column i+1 corresponds to `selected[i]` **positionally**.
- The date axis is the **current season** (e.g. 20260430 → 20270330);
  prior-year lines are already re-mapped onto this axis server-side, so
  all lines share one calendar. The current-year line (column 0 after
  rolling) has data only up to the latest session.
- Values are plain numbers (spread price, e.g. cents/lb).
- The season's start month = month of `values[0][0]` — use that, not the
  stale config `startDate`.

## Fixtures (test/fixtures/scarr/)

- `saved-charts.json` — real listing response (all save names).
- `chart-config.json` — stored config for "Feeder cattle_A_ HJK"
  (note the stale FC2021-anchored `selected`).
- `contracts.json` — contracts listing for FC H/J/K legs.
- `chart-data.json` — ControllerServlet response for the fresh
  FC2027-anchored HJK config (8 lines, 335 rows).
- `chart-data-rebuilt.json` — response for the HJK config rolled forward
  by our own algorithm (6 lines: current + 5 priors).

## Fallback

If Scarr changes these servlets, the replay tests against the fixtures
fail loudly. Manual fallback stays available: paste saved-chart URLs on
/strategies/import (configs parse from the URL), and adjust `scarr.js`.
