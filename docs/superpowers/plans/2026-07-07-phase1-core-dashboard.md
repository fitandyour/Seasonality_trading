# Trading Seasonals Dashboard — Phase 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A login-gated Express app on Railway that pulls Henk's saved scarrtrading.com strategies daily, scores each one with four seasonal-quality metrics, and shows today's flagged setups on a dashboard.

**Architecture:** Node/Express monolith, server-rendered EJS, Railway Postgres with boot-time migrations, in-process cron at 07:00 Europe/Amsterdam. Scarr access is a swappable module driven by an endpoints config file captured in a one-time discovery session; scoring is pure functions over stored per-year series.

**Tech Stack:** Node ≥20 (global `fetch`, `node --test`), express, ejs, pg, bcryptjs, express-session, connect-pg-simple, node-cron. No build step, no frontend framework.

## Global Constraints

- Repo: `/Users/elsub_macmini/Desktop/Trading_Seasonals` — completely separate from the CRM; own Railway service and database.
- Secrets only in Railway env vars: `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SCARR_USERNAME`, `SCARR_PASSWORD`. Never in code, never committed, never echoed in chat/logs.
- No HTML crawling of Scarr. Only replay the JSON data requests the user's own browser makes, once daily, for his own saved charts.
- There is no local Postgres and no local `.env` (same workflow as the CRM): unit tests must be pure (no DB, no network); DB-touching code is verified on Railway after deploy.
- Schema self-migrates at boot; migrations are append-only `CREATE TABLE IF NOT EXISTS` / `ALTER ... IF NOT EXISTS` statements.
- All series dates are `YYYY-MM-DD` strings. All metric values are 0–1 floats except `setupScore` (integer 0–100) and `tracking` (−1..1 or null).
- Default score threshold 65, default metric weights 0.25 each, entry-window lead 21 days — all stored in the `settings` table, tunable from the admin page.
- Commit after every green test cycle. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (end state of Phase 1)

```
Trading_Seasonals/
  package.json            deps + scripts (start, test)
  .gitignore              node_modules, .env
  README.md               env vars, deploy notes
  server.js               express wiring, boot (migrate+seed), cron
  db.js                   pg pool
  schema.js               boot migrations
  auth.js                 seedAdmin, requireAuth, login/logout routes
  scarrparse.js           saved-chart URL/JSON config parser (pure)
  scoring.js              alignment + 4 metrics + setup score (pure)
  scarr.js                Scarr HTTP client (endpoint-config-driven) + series parser
  sync.js                 orchestration: fetch → upsert → score → flag
  chartsvg.js             SVG polyline generator (pure)
  routes/strategies.js    import page, list page, detail page
  routes/dashboard.js     home page, admin page, sync-now
  config/scarr-endpoints.json   produced by Task 7 discovery (gitignored? NO — committed, contains no secrets)
  views/ _head.ejs _nav.ejs login.ejs dashboard.ejs strategies.ejs strategy.ejs import.ejs admin.ejs
  public/style.css
  test/ scarrparse.test.js scoring.test.js scarr.test.js sync.test.js chartsvg.test.js auth.test.js
  test/fixtures/scarr/    captured during Task 7 discovery
  docs/scarr-endpoints.md written during Task 7
```

---

### Task 1: Scaffold, DB pool, schema migrations

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `db.js`, `schema.js`, `server.js`, `public/style.css`

**Interfaces:**
- Produces: `db.js` exports `{ pool, query(text, params) }`. `schema.js` exports `{ migrate() }` (runs all migrations, idempotent). `server.js` boots: migrate → listen on `process.env.PORT || 3000`, serves `GET /healthz` → `{ ok: true }` without auth.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "trading-seasonals",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "connect-pg-simple": "^9.0.1",
    "ejs": "^3.1.10",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "node-cron": "^3.0.3",
    "pg": "^8.12.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
.env
*.log
```

- [ ] **Step 3: Write `db.js`**

```js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
```

- [ ] **Step 4: Write `schema.js`**

```js
const { pool } = require('./db');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS strategies (
     id SERIAL PRIMARY KEY,
     save_name TEXT UNIQUE NOT NULL,
     source_url TEXT,
     config JSONB NOT NULL,
     years_back INT NOT NULL DEFAULT 5,
     active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS series_points (
     strategy_id INT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     line_label TEXT NOT NULL,
     trade_date DATE NOT NULL,
     value DOUBLE PRECISION NOT NULL,
     PRIMARY KEY (strategy_id, line_label, trade_date)
   )`,
  `CREATE TABLE IF NOT EXISTS daily_scores (
     strategy_id INT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     score_date DATE NOT NULL,
     direction INT,
     reliability DOUBLE PRECISION,
     strength DOUBLE PRECISION,
     tracking DOUBLE PRECISION,
     stretch_score DOUBLE PRECISION,
     setup_score DOUBLE PRECISION,
     in_window BOOLEAN,
     flagged BOOLEAN,
     details JSONB,
     PRIMARY KEY (strategy_id, score_date)
   )`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
     id SERIAL PRIMARY KEY,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     status TEXT NOT NULL DEFAULT 'running',
     detail JSONB
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL
   )`,
];

async function migrate() {
  for (const sql of MIGRATIONS) await pool.query(sql);
}

module.exports = { migrate, MIGRATIONS };
```

- [ ] **Step 5: Write minimal `server.js`**

```js
const express = require('express');
const path = require('path');
const { migrate } = require('./schema');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

async function boot() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — refusing to start.');
    process.exit(1);
  }
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`trading-seasonals listening on :${port}`));
}

if (require.main === module) boot();
module.exports = { app, boot };
```

- [ ] **Step 6: Write `public/style.css`**

```css
:root { --bg:#0f172a; --panel:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --good:#4ade80; --bad:#f87171; --warn:#facc15; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
a { color: var(--accent); text-decoration: none; }
nav { display:flex; gap:1.2rem; padding:.8rem 1.2rem; background:var(--panel); align-items:center; }
nav .spacer { flex:1; }
main { max-width:1100px; margin:1.2rem auto; padding:0 1rem; }
.card { background:var(--panel); border-radius:8px; padding:1rem 1.2rem; margin-bottom:1rem; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid #334155; font-size:.92rem; }
.badge { padding:.1rem .5rem; border-radius:999px; font-size:.8rem; }
.badge.flag { background:var(--good); color:#052e16; }
.badge.off { background:#334155; color:var(--muted); }
.badge.fail { background:var(--bad); color:#450a0a; }
input, select, button, textarea { background:#0b1220; color:var(--text); border:1px solid #334155; border-radius:6px; padding:.45rem .6rem; font-size:.95rem; }
button { background:var(--accent); color:#04121f; border:none; cursor:pointer; font-weight:600; }
form.stack { display:flex; flex-direction:column; gap:.7rem; max-width:420px; }
.muted { color:var(--muted); }
.score { font-weight:700; font-size:1.1rem; }
```

- [ ] **Step 7: Write `README.md`**

```markdown
# Trading Seasonals Dashboard

Private dashboard: daily Scarr seasonality pull → setup scoring → flagged spread trades.
Phase 1 spec: docs/superpowers/specs/2026-07-07-trading-seasonals-dashboard-design.md

## Environment variables (Railway)

| Var | Purpose |
|---|---|
| DATABASE_URL | Railway Postgres (auto-injected) |
| SESSION_SECRET | random 32+ char string for session cookies |
| ADMIN_EMAIL / ADMIN_PASSWORD | the single login account (seeded at boot) |
| SCARR_USERNAME / SCARR_PASSWORD | Scarr subscription login for the daily pull |
| PGSSL | set to `require` only if the DB needs SSL |

Schema self-migrates at boot. Deploys on git push (Railway GitHub integration).
Run tests: `npm test` (pure unit tests, no DB needed).
```

- [ ] **Step 8: Install and syntax-check**

Run: `cd /Users/elsub_macmini/Desktop/Trading_Seasonals && npm install && node --check server.js && node --check db.js && node --check schema.js`
Expected: install completes; no syntax errors. (No DB locally — boot is verified on Railway in Task 11.)

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffold app, db pool, boot migrations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Auth — seeded admin, session login

**Files:**
- Create: `auth.js`, `views/_head.ejs`, `views/_nav.ejs`, `views/login.ejs`
- Modify: `server.js` (add session middleware + auth routes)
- Test: `test/auth.test.js`

**Interfaces:**
- Consumes: `db.js` `{ pool }`.
- Produces: `auth.js` exports `{ seedAdmin(), requireAuth(req,res,next), registerAuthRoutes(app) }`. `requireAuth` passes through when `req.session.userId` is set, otherwise redirects `/login`. `registerAuthRoutes` adds `GET /login`, `POST /login`, `POST /logout`.

- [ ] **Step 1: Write the failing test `test/auth.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAuth } = require('../auth');

test('requireAuth passes through when session has userId', () => {
  let nexted = false;
  requireAuth({ session: { userId: 1 } }, {}, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('requireAuth redirects to /login when no session user', () => {
  let redirectedTo = null;
  const res = { redirect: (url) => { redirectedTo = url; } };
  requireAuth({ session: {} }, res, () => { throw new Error('must not call next'); });
  assert.equal(redirectedTo, '/login');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../auth'`

- [ ] **Step 3: Write `auth.js`**

```js
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not set — no login account seeded.');
    return;
  }
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length === 0) {
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      [email, bcrypt.hashSync(password, 10)]);
    console.log('Seeded admin user.');
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function registerAuthRoutes(app) {
  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email || '']);
    if (rows.length === 1 && bcrypt.compareSync(password || '', rows[0].password_hash)) {
      req.session.userId = rows[0].id;
      return res.redirect('/');
    }
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
}

module.exports = { seedAdmin, requireAuth, registerAuthRoutes };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (2 tests)

- [ ] **Step 5: Write views**

`views/_head.ejs`:
```html
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trading Seasonals</title>
<link rel="stylesheet" href="/style.css"></head><body>
```

`views/_nav.ejs`:
```html
<nav>
  <a href="/"><strong>Seasonals</strong></a>
  <a href="/strategies">Strategies</a>
  <a href="/admin">Admin</a>
  <span class="spacer"></span>
  <form method="post" action="/logout" style="margin:0"><button>Log out</button></form>
</nav>
```

`views/login.ejs`:
```html
<%- include('_head') %>
<main><div class="card" style="max-width:420px;margin:4rem auto">
  <h2>Log in</h2>
  <% if (error) { %><p style="color:var(--bad)"><%= error %></p><% } %>
  <form method="post" action="/login" class="stack">
    <input name="email" type="email" placeholder="Email" required>
    <input name="password" type="password" placeholder="Password" required>
    <button>Log in</button>
  </form>
</div></main></body></html>
```

- [ ] **Step 6: Wire sessions + auth into `server.js`**

Replace the `const { migrate } = require('./schema');` block region at the top with:

```js
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { migrate } = require('./schema');
const { pool } = require('./db');
const { seedAdmin, registerAuthRoutes } = require('./auth');
```

After `app.use(express.static(...))` add:

```js
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' },
}));
registerAuthRoutes(app);
```

In `boot()`, after `await migrate();` add:

```js
await seedAdmin();
```

- [ ] **Step 7: Syntax check + tests**

Run: `node --check server.js && node --check auth.js && npm test`
Expected: no errors, tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: session auth with seeded admin account

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Scarr saved-chart URL parser

**Files:**
- Create: `scarrparse.js`
- Test: `test/scarrparse.test.js`

**Interfaces:**
- Produces: `scarrparse.js` exports `{ parseSavedChartUrl(url), MONTH_NUM }`.
  - `parseSavedChartUrl(url)` → `{ saveName, legs, selected: string[], yearsBack, window: { openMonth, openDate, closeMonth, closeDate }, startDate, endDate, form }` where `form` is the full decoded JSON object (needed later to replay the data request). Throws `Error('URL has no newGeneralForm parameter')` / JSON errors otherwise.
  - `MONTH_NUM` maps `'January'→1 … 'December'→12`.

- [ ] **Step 1: Write the failing test `test/scarrparse.test.js`** — uses the user's real saved-chart URL from the spec:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSavedChartUrl, MONTH_NUM } = require('../scarrparse');

const REAL_URL = 'https://scarrtrading.com/SeasonalsGenerator.action?newGeneralForm=%7B%22json%22:%22%22,%22chartType%22:%22amcharts%22,%22grouping%22:%22off%22,%22balloons%22:false,%22lineWidth%22:1,%22height%22:750,%22width%22:950,%22legendLocation%22:%22bottom%22,%22legsPanel%22:%22yes%22,%22study%22:%22stacked%22,%22generator%22:%22SeasonalsGenerator%22,%22startDate%22:%222026-04-29T22:00:00.000Z%22,%22endDate%22:%222026-12-14T23:00:00.000Z%22,%22hiddenAmchartsItems%22:%5B%22FC2013J/FC2013K%22%5D,%22eye%22:%5B1.9,0.93,0.31%5D,%22sampleContract%22:%5B%22FC2027H%22,%22FC2027J%22,%22FC2027K%22%5D,%22saveName%22:%22Feeder%20cattle_A_%20HJK%22,%22legs%22:3,%22intracommodity%22:true,%22mult%22:%5B1,2,1,1%5D,%22p%22:%5B1,-1,1,1%5D,%22unitMove%22:%5B500,500,500,500%5D,%22openMonth%22:%22January%22,%22openDate%22:1,%22closeMonth%22:%22February%22,%22closeDate%22:1,%22y1%22:5,%22method%22:%22average%22,%22normalization%22:%22off%22,%22normalizationMonth%22:%22January%22,%22normalizationDate%22:1,%22truncate%22:1.5,%22addCOTPanel%22:true,%22selected%22:%5B%22FC2027H/FC2027J/FC2027K%22,%22FC2026H/FC2026J/FC2026K%22,%22FC2025H/FC2025J/FC2025K%22,%22FC2024H/FC2024J/FC2024K%22,%22FC2023H/FC2023J/FC2023K%22,%22FC2022H/FC2022J/FC2022K%22,%22FC2021H/FC2021J/FC2021K%22,%22FC2020H/FC2020J/FC2020K%22%5D,%22seasonalSelectionMode%22:%22custom%22,%22seasonals%22:%5B5,15%5D,%22database%22:%22saves%22,%22language%22:%22en%22%7D';

test('parses saved chart URL into strategy config', () => {
  const cfg = parseSavedChartUrl(REAL_URL);
  assert.equal(cfg.saveName, 'Feeder cattle_A_ HJK');
  assert.equal(cfg.legs, 3);
  assert.equal(cfg.yearsBack, 5);
  assert.equal(cfg.selected.length, 8);
  assert.equal(cfg.selected[0], 'FC2027H/FC2027J/FC2027K');
  assert.deepEqual(cfg.window, { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 });
  assert.equal(cfg.form.study, 'stacked');
  assert.equal(new Date(cfg.startDate).getUTCMonth() + 1, 4);
});

test('throws on URL without newGeneralForm', () => {
  assert.throws(() => parseSavedChartUrl('https://scarrtrading.com/Home.action'),
    /newGeneralForm/);
});

test('MONTH_NUM maps names', () => {
  assert.equal(MONTH_NUM.January, 1);
  assert.equal(MONTH_NUM.December, 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scarrparse'`

- [ ] **Step 3: Write `scarrparse.js`**

```js
const MONTH_NUM = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

function parseSavedChartUrl(url) {
  const u = new URL(url);
  const raw = u.searchParams.get('newGeneralForm');
  if (!raw) throw new Error('URL has no newGeneralForm parameter');
  const form = JSON.parse(raw);
  return {
    saveName: form.saveName,
    legs: form.legs,
    selected: form.selected || [],
    yearsBack: form.y1 || 5,
    window: {
      openMonth: form.openMonth, openDate: form.openDate,
      closeMonth: form.closeMonth, closeDate: form.closeDate,
    },
    startDate: form.startDate,
    endDate: form.endDate,
    form,
  };
}

module.exports = { parseSavedChartUrl, MONTH_NUM };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: parse Scarr saved-chart URLs into strategy configs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Scoring — season alignment helpers

**Files:**
- Create: `scoring.js`
- Test: `test/scoring.test.js`

**Interfaces:**
- Consumes: `MONTH_NUM` from `scarrparse.js`.
- Produces (all exported from `scoring.js`, all pure):
  - `monthDayKey(dateStr)` → `'MM-DD'`
  - `seasonIndex(mdKey, seasonStartMonth)` → integer ordering position within a season that may wrap the year boundary
  - `toIndexed(series, seasonStartMonth)` → `Map<idx, value>` from `[{date, value}]`
  - `valueAt(indexed, idx, tolerance=6)` → nearest value within ±tolerance or `null`
  - `windowIndices(window, seasonStartMonth)` → `{ openIdx, closeIdx }`
  - `seasonalAveragePath(priorIndexedArray)` → `Map<idx, avgValue>` (only indices present in ≥ half the years)

- [ ] **Step 1: Write the failing tests** — append to a new `test/scoring.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
} = require('../scoring');

test('monthDayKey extracts MM-DD', () => {
  assert.equal(monthDayKey('2026-07-07'), '07-07');
});

test('seasonIndex orders dates within a May-start season, wrapping the year', () => {
  const may1 = seasonIndex('05-01', 5);
  const dec1 = seasonIndex('12-01', 5);
  const feb1 = seasonIndex('02-01', 5); // belongs to the tail of the season
  assert.equal(may1, 0);
  assert.ok(dec1 > may1);
  assert.ok(feb1 > dec1, 'February comes after December in a May-start season');
});

test('toIndexed + valueAt finds exact and nearest values', () => {
  const idxMap = toIndexed([
    { date: '2026-05-01', value: 1.0 },
    { date: '2026-05-08', value: 2.0 },
  ], 5);
  assert.equal(valueAt(idxMap, seasonIndex('05-01', 5)), 1.0);
  assert.equal(valueAt(idxMap, seasonIndex('05-03', 5)), 1.0); // nearest within tolerance
  assert.equal(valueAt(idxMap, seasonIndex('06-15', 5)), null); // too far
});

test('windowIndices maps a January->February window in a May-start season', () => {
  const { openIdx, closeIdx } = windowIndices(
    { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 }, 5);
  assert.ok(openIdx > seasonIndex('12-01', 5));
  assert.ok(closeIdx > openIdx);
});

test('seasonalAveragePath averages indices present in at least half the years', () => {
  const y1 = toIndexed([{ date: '2025-05-01', value: 2 }, { date: '2025-05-08', value: 4 }], 5);
  const y2 = toIndexed([{ date: '2024-05-01', value: 4 }], 5);
  const avg = seasonalAveragePath([y1, y2]);
  assert.equal(avg.get(seasonIndex('05-01', 5)), 3); // both years
  assert.equal(avg.get(seasonIndex('05-08', 5)), 4); // 1 of 2 years = exactly half, kept
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scoring'`

- [ ] **Step 3: Write `scoring.js` (alignment part)**

```js
const { MONTH_NUM } = require('./scarrparse');

function monthDayKey(dateStr) { return dateStr.slice(5, 10); }

function seasonIndex(mdKey, seasonStartMonth) {
  const m = Number(mdKey.slice(0, 2));
  const d = Number(mdKey.slice(3, 5));
  return ((m - seasonStartMonth + 12) % 12) * 31 + (d - 1);
}

function toIndexed(series, seasonStartMonth) {
  const map = new Map();
  for (const p of series) map.set(seasonIndex(monthDayKey(p.date), seasonStartMonth), p.value);
  return map;
}

function valueAt(indexed, idx, tolerance = 6) {
  if (indexed.has(idx)) return indexed.get(idx);
  for (let off = 1; off <= tolerance; off++) {
    if (indexed.has(idx - off)) return indexed.get(idx - off);
    if (indexed.has(idx + off)) return indexed.get(idx + off);
  }
  return null;
}

function mdFrom(monthName, day) {
  return String(MONTH_NUM[monthName]).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function windowIndices(window, seasonStartMonth) {
  return {
    openIdx: seasonIndex(mdFrom(window.openMonth, window.openDate), seasonStartMonth),
    closeIdx: seasonIndex(mdFrom(window.closeMonth, window.closeDate), seasonStartMonth),
  };
}

function seasonalAveragePath(priorIndexedArray) {
  const acc = new Map();
  for (const map of priorIndexedArray) {
    for (const [idx, v] of map) {
      const e = acc.get(idx) || { sum: 0, n: 0 };
      e.sum += v; e.n += 1;
      acc.set(idx, e);
    }
  }
  const need = Math.ceil(priorIndexedArray.length / 2);
  const out = new Map();
  for (const [idx, e] of acc) if (e.n >= need) out.set(idx, e.sum / e.n);
  return out;
}

module.exports = {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: season-calendar alignment helpers for scoring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Scoring — the four metrics and Setup Score

**Files:**
- Modify: `scoring.js` (append metric functions + `computeStrategyMetrics`)
- Test: `test/scoring.test.js` (append)

**Interfaces:**
- Produces (added exports):
  - `reliabilityAndDirection(moves)` → `{ direction: -1|0|1, reliability: 0..1, nYears }` (null moves ignored; direction = sign of mean move, defaults to 1 on exact zero)
  - `strengthScore(moves)` → 0..1 (`0.5` neutral when <3 usable moves)
  - `trackingCorrelation(currentIndexed, avgPath)` → Pearson −1..1, or `null` when <10 shared points
  - `entryStretch(currentIndexed, priorIndexedArray, todayIdx, direction)` → `{ percentile: 0..1|null, stretchScore: 0..1 }` (0.5 neutral when today's value or <2 prior values missing)
  - `inWindow(todayIdx, openIdx, closeIdx, leadDays=21)` → boolean, wrap-safe
  - `DEFAULT_WEIGHTS` = `{ reliability: .25, strength: .25, tracking: .25, stretch: .25 }`
  - `computeStrategyMetrics({ currentYear, priorYears, window, seasonStartMonth, todayDate, weights? })` → `{ direction, nYears, reliability, strength, tracking, trackingScore, percentile, stretchScore, setupScore, inWindow, todayIdx, openIdx, closeIdx }` — `currentYear`/`priorYears` are `[{date,value}]` arrays; `setupScore` integer 0–100.

- [ ] **Step 1: Append failing tests to `test/scoring.test.js`**

```js
const {
  reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch,
  inWindow, computeStrategyMetrics, DEFAULT_WEIGHTS,
} = require('../scoring');

test('reliabilityAndDirection: 4 of 5 years up', () => {
  const r = reliabilityAndDirection([2, 3, -1, 4, 2]);
  assert.equal(r.direction, 1);
  assert.equal(r.reliability, 0.8);
  assert.equal(r.nYears, 5);
});

test('reliabilityAndDirection ignores null moves and handles all-down', () => {
  const r = reliabilityAndDirection([-2, -3, null, -1]);
  assert.equal(r.direction, -1);
  assert.equal(r.reliability, 1);
  assert.equal(r.nYears, 3);
});

test('strengthScore: consistent moves score high, noisy moves low, few moves neutral', () => {
  assert.ok(strengthScore([3, 3.1, 2.9, 3, 3.05]) > 0.9);
  assert.ok(strengthScore([3, -2.8, 3.1, -3, 0.2]) < 0.3);
  assert.equal(strengthScore([3, 2]), 0.5);
});

test('trackingCorrelation: perfectly tracking year correlates ~1, needs 10 points', () => {
  const cur = new Map(); const avg = new Map();
  for (let i = 0; i < 12; i++) { cur.set(i, i * 2 + 1); avg.set(i, i * 3); }
  assert.ok(trackingCorrelation(cur, avg) > 0.999);
  const short = new Map([...cur].slice(0, 5));
  assert.equal(trackingCorrelation(short, avg), null);
});

test('entryStretch: cheap entry for a long seasonal scores high', () => {
  const cur = new Map([[10, 1.0]]);
  const priors = [new Map([[10, 2]]), new Map([[10, 3]]), new Map([[10, 4]]), new Map([[10, 5]])];
  const { percentile, stretchScore } = entryStretch(cur, priors, 10, 1);
  assert.equal(percentile, 0);       // below every prior year
  assert.equal(stretchScore, 1);     // best possible long entry
  assert.equal(entryStretch(cur, priors, 10, -1).stretchScore, 0); // worst short entry
});

test('inWindow includes 21-day lead and handles season wrap', () => {
  assert.equal(inWindow(100, 110, 140), true);   // in lead period
  assert.equal(inWindow(80, 110, 140), false);   // too early
  assert.equal(inWindow(150, 110, 140), false);  // past close
  assert.equal(inWindow(5, 340, 20), true);      // wrapped window, today after boundary
});

test('computeStrategyMetrics end-to-end on synthetic 5-year seasonal', () => {
  // 5 prior years all rising 1.0 between Jan 1 and Feb 1; current year tracking but cheaper.
  function yearSeries(startYear, base) {
    const pts = [];
    for (let d = 0; d < 60; d += 3) {
      const dt = new Date(Date.UTC(startYear, 0, 1 + d));
      pts.push({ date: dt.toISOString().slice(0, 10), value: base + d * (1 / 31) });
    }
    return pts;
  }
  const priorYears = [2021, 2022, 2023, 2024, 2025].map((y) => yearSeries(y, 2));
  const currentYear = yearSeries(2026, 1); // same shape, lower level = cheap
  const m = computeStrategyMetrics({
    currentYear, priorYears,
    window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
    seasonStartMonth: 12, todayDate: '2026-01-05',
  });
  assert.equal(m.direction, 1);
  assert.equal(m.reliability, 1);
  assert.ok(m.strength > 0.9);
  assert.ok(m.tracking > 0.99);
  assert.equal(m.stretchScore, 1);
  assert.ok(m.setupScore >= 95, `expected >=95, got ${m.setupScore}`);
  assert.equal(m.inWindow, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — new functions are not exported.

- [ ] **Step 3: Append implementations to `scoring.js`** (before `module.exports`, then extend the export list):

```js
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function reliabilityAndDirection(moves) {
  const m = moves.filter((x) => x != null);
  if (m.length === 0) return { direction: 0, reliability: 0.5, nYears: 0 };
  const direction = Math.sign(mean(m)) || 1;
  return {
    direction,
    reliability: m.filter((x) => Math.sign(x) === direction).length / m.length,
    nYears: m.length,
  };
}

function strengthScore(moves) {
  const m = moves.filter((x) => x != null);
  if (m.length < 3) return 0.5;
  const t = Math.abs(mean(m)) / (stdev(m) + 1e-9);
  return t / (1 + t);
}

function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

function trackingCorrelation(currentIndexed, avgPath) {
  const xs = []; const ys = [];
  for (const [idx, v] of currentIndexed) {
    if (avgPath.has(idx)) { xs.push(v); ys.push(avgPath.get(idx)); }
  }
  if (xs.length < 10) return null;
  return pearson(xs, ys);
}

function entryStretch(currentIndexed, priorIndexedArray, todayIdx, direction) {
  const cur = valueAt(currentIndexed, todayIdx);
  if (cur == null) return { percentile: null, stretchScore: 0.5 };
  const vals = priorIndexedArray.map((m) => valueAt(m, todayIdx)).filter((v) => v != null);
  if (vals.length < 2) return { percentile: null, stretchScore: 0.5 };
  const percentile = vals.filter((v) => v < cur).length / vals.length;
  return { percentile, stretchScore: direction > 0 ? 1 - percentile : percentile };
}

function inWindow(todayIdx, openIdx, closeIdx, leadDays = 21) {
  const start = openIdx - leadDays;
  if (closeIdx >= start) return todayIdx >= start && todayIdx <= closeIdx;
  return todayIdx >= start || todayIdx <= closeIdx; // window wraps the season boundary
}

const DEFAULT_WEIGHTS = { reliability: 0.25, strength: 0.25, tracking: 0.25, stretch: 0.25 };

function computeStrategyMetrics({ currentYear, priorYears, window, seasonStartMonth, todayDate, weights = DEFAULT_WEIGHTS }) {
  const curIdx = toIndexed(currentYear, seasonStartMonth);
  const priors = priorYears.map((s) => toIndexed(s, seasonStartMonth));
  const { openIdx, closeIdx } = windowIndices(window, seasonStartMonth);
  const moves = priors.map((m) => {
    const a = valueAt(m, openIdx); const b = valueAt(m, closeIdx);
    return (a == null || b == null) ? null : b - a;
  });
  const { direction, reliability, nYears } = reliabilityAndDirection(moves);
  const strength = strengthScore(moves);
  const tracking = trackingCorrelation(curIdx, seasonalAveragePath(priors));
  const todayIdx = seasonIndex(monthDayKey(todayDate), seasonStartMonth);
  const { percentile, stretchScore } = entryStretch(curIdx, priors, todayIdx, direction);
  const trackingScore = tracking == null ? 0.5 : (tracking + 1) / 2;
  const setupScore = Math.round(100 * (
    weights.reliability * reliability
    + weights.strength * strength
    + weights.tracking * trackingScore
    + weights.stretch * stretchScore
  ));
  return {
    direction, nYears, reliability, strength, tracking, trackingScore,
    percentile, stretchScore, setupScore,
    inWindow: inWindow(todayIdx, openIdx, closeIdx),
    todayIdx, openIdx, closeIdx,
  };
}
```

Extend `module.exports` to also include: `reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch, inWindow, DEFAULT_WEIGHTS, computeStrategyMetrics`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: four seasonal metrics and composite setup score

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Strategy import + list pages

**Files:**
- Create: `routes/strategies.js`, `views/import.ejs`, `views/strategies.ejs`
- Modify: `server.js` (mount router)
- Test: `test/strategies.test.js`

**Interfaces:**
- Consumes: `parseSavedChartUrl` from `scarrparse.js`, `requireAuth` from `auth.js`, `pool` from `db.js`.
- Produces: `routes/strategies.js` exports `{ router, strategyRecordFromUrl(url) }`.
  - `strategyRecordFromUrl(url)` (pure) → `{ save_name, source_url, config, years_back }` where `config` is the parse result object.
  - Routes (all behind `requireAuth`): `GET /strategies` (list), `GET /strategies/import` (form), `POST /strategies/import` (textarea of one-URL-per-line; upserts by `save_name`), `POST /strategies/:id/toggle` (flip `active`).

- [ ] **Step 1: Write the failing test `test/strategies.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyRecordFromUrl } = require('../routes/strategies');

const URL_A = 'https://scarrtrading.com/SeasonalsGenerator.action?newGeneralForm=%7B%22saveName%22:%22Corn_C_UZ%22,%22legs%22:2,%22y1%22:5,%22openMonth%22:%22June%22,%22openDate%22:15,%22closeMonth%22:%22August%22,%22closeDate%22:1,%22selected%22:%5B%22C2026N/C2026Z%22%5D,%22startDate%22:%222026-01-05T00:00:00.000Z%22%7D';

test('strategyRecordFromUrl maps parse result to a DB record', () => {
  const rec = strategyRecordFromUrl(URL_A);
  assert.equal(rec.save_name, 'Corn_C_UZ');
  assert.equal(rec.years_back, 5);
  assert.equal(rec.source_url, URL_A);
  assert.equal(rec.config.window.openMonth, 'June');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../routes/strategies'`

- [ ] **Step 3: Write `routes/strategies.js`**

```js
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { parseSavedChartUrl } = require('../scarrparse');

function strategyRecordFromUrl(url) {
  const config = parseSavedChartUrl(url);
  return {
    save_name: config.saveName,
    source_url: url,
    config,
    years_back: config.yearsBack,
  };
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, d.setup_score, d.flagged, d.score_date
       FROM strategies s
       LEFT JOIN LATERAL (
         SELECT setup_score, flagged, score_date FROM daily_scores
          WHERE strategy_id = s.id ORDER BY score_date DESC LIMIT 1
       ) d ON true
      ORDER BY s.save_name`);
  res.render('strategies', { strategies: rows });
});

router.get('/import', (req, res) => res.render('import', { results: null }));

router.post('/import', async (req, res) => {
  const urls = String(req.body.urls || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const url of urls) {
    try {
      const rec = strategyRecordFromUrl(url);
      await pool.query(
        `INSERT INTO strategies (save_name, source_url, config, years_back)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (save_name) DO UPDATE
           SET source_url = EXCLUDED.source_url, config = EXCLUDED.config,
               years_back = EXCLUDED.years_back, updated_at = now()`,
        [rec.save_name, rec.source_url, JSON.stringify(rec.config), rec.years_back]);
      results.push({ url, ok: true, saveName: rec.save_name });
    } catch (err) {
      results.push({ url, ok: false, error: err.message });
    }
  }
  res.render('import', { results });
});

router.post('/:id/toggle', async (req, res) => {
  await pool.query('UPDATE strategies SET active = NOT active, updated_at = now() WHERE id = $1',
    [req.params.id]);
  res.redirect('/strategies');
});

module.exports = { router, strategyRecordFromUrl };
```

- [ ] **Step 4: Write `views/import.ejs`**

```html
<%- include('_head') %><%- include('_nav') %>
<main>
  <div class="card">
    <h2>Import strategies</h2>
    <p class="muted">Paste Scarr saved-chart URLs, one per line (open a saved chart on Scarr and copy the address bar).</p>
    <form method="post" action="/strategies/import" class="stack" style="max-width:100%">
      <textarea name="urls" rows="8" placeholder="https://scarrtrading.com/SeasonalsGenerator.action?newGeneralForm=..."></textarea>
      <button>Import</button>
    </form>
  </div>
  <% if (results) { %>
  <div class="card"><h3>Results</h3><table>
    <% for (const r of results) { %>
      <tr>
        <td><%= r.ok ? r.saveName : r.url.slice(0, 60) + '…' %></td>
        <td><span class="badge <%= r.ok ? 'flag' : 'fail' %>"><%= r.ok ? 'imported' : r.error %></span></td>
      </tr>
    <% } %>
  </table></div>
  <% } %>
</main></body></html>
```

- [ ] **Step 5: Write `views/strategies.ejs`**

```html
<%- include('_head') %><%- include('_nav') %>
<main>
  <div class="card">
    <h2>Strategies <a href="/strategies/import" style="font-size:.9rem">+ import</a></h2>
    <table>
      <tr><th>Name</th><th>Years</th><th>Latest score</th><th>Status</th><th></th></tr>
      <% for (const s of strategies) { %>
      <tr>
        <td><a href="/strategies/<%= s.id %>"><%= s.save_name %></a></td>
        <td><%= s.years_back %></td>
        <td class="score"><%= s.setup_score == null ? '—' : Math.round(s.setup_score) %></td>
        <td><span class="badge <%= s.flagged ? 'flag' : 'off' %>"><%= s.flagged ? 'FLAGGED' : (s.active ? 'active' : 'paused') %></span></td>
        <td><form method="post" action="/strategies/<%= s.id %>/toggle" style="margin:0"><button><%= s.active ? 'Pause' : 'Activate' %></button></form></td>
      </tr>
      <% } %>
    </table>
  </div>
</main></body></html>
```

- [ ] **Step 6: Mount router in `server.js`** — after `registerAuthRoutes(app);` add:

```js
app.use('/strategies', require('./routes/strategies').router);
```

- [ ] **Step 7: Run tests + syntax check**

Run: `npm test && node --check routes/strategies.js && node --check server.js`
Expected: PASS, no syntax errors.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: strategy import from saved-chart URLs and list page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Scarr endpoint discovery session (MANUAL — requires Henk + Chrome)

**This task cannot be done by a subagent.** It is an interactive session between Claude (main session, Chrome extension / claude-in-chrome MCP) and Henk, who logs into Scarr himself. **No credentials are typed into chat.**

**Files:**
- Create: `config/scarr-endpoints.json` (no secrets — paths and field names only)
- Create: `test/fixtures/scarr/chart-data.json` (one real chart-data response, may be trimmed)
- Create: `test/fixtures/scarr/saved-charts.json` (the saved-charts listing response)
- Create: `docs/scarr-endpoints.md` (what was observed: login flow, endpoints, payload shapes)

**Interfaces:**
- Produces: `config/scarr-endpoints.json` with exactly this shape (values filled from observation):

```json
{
  "base": "https://www.scarrtrading.com",
  "login": {
    "path": "/<observed login action path>",
    "usernameField": "<observed form field name>",
    "passwordField": "<observed form field name>",
    "staticFields": {}
  },
  "savedCharts": {
    "path": "/<observed path that returns the saved charts list>",
    "type": "json"
  },
  "chartData": {
    "path": "/<observed path the amCharts data comes from>",
    "method": "GET",
    "param": "newGeneralForm"
  }
}
```

**Procedure:**

- [ ] **Step 1:** Henk opens Chrome (with the Claude extension connected) and logs into scarrtrading.com himself.
- [ ] **Step 2:** Claude opens one saved chart (e.g. "Feeder cattle_A_ HJK") and reads network requests (`read_network_requests`) to identify: (a) the request that returned the chart's numeric series (JSON, contains per-year line data), (b) the request that lists saved charts, (c) the login POST (from Henk's earlier login, or by observing a fresh login — Henk types the password himself).
- [ ] **Step 3:** Save the two response bodies as the fixture files above (trim chart-data to ~30 rows per line if huge, keeping structure intact).
- [ ] **Step 4:** Fill in `config/scarr-endpoints.json` from observations. Verify the JSON payload row shape and document it in `docs/scarr-endpoints.md`: how dates appear, how line labels appear, whether all year-lines share one aligned date axis.
- [ ] **Step 5:** Sanity-check with Henk that the observed "chart data" numbers match what the chart shows (hover a point on the chart, compare).
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: Scarr endpoint discovery — endpoints config and replay fixtures

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Checkpoint:** If discovery shows the data cannot be fetched as JSON (e.g. it's baked into HTML), STOP and revisit with Henk — the fallback is Export-Charts-file import + per-chart manual JSON capture; `scarr.js`'s interface (Task 8) stays the same either way.

---

### Task 8: Scarr HTTP client + series parser

**Files:**
- Create: `scarr.js`
- Test: `test/scarr.test.js`

**Interfaces:**
- Consumes: `config/scarr-endpoints.json` and fixtures from Task 7.
- Produces: `scarr.js` exports `{ createClient, parseChartSeries, loadEndpoints }`.
  - `loadEndpoints()` → parsed `config/scarr-endpoints.json`.
  - `createClient({ username, password, endpoints, fetchImpl = fetch })` → `{ login(), listSavedCharts(), fetchChartData(formObj), _cookies() }`. Maintains a cookie jar across requests. `login()` throws on HTTP ≥ 400. `fetchChartData(formObj)` sends the strategy's saved `form` JSON as the `endpoints.chartData.param` parameter (GET query or POST form per `endpoints.chartData.method`) and returns parsed JSON.
  - `parseChartSeries(payload)` → `{ [lineLabel]: [{ date: 'YYYY-MM-DD', value: number }] }`. Accepts either a bare array of rows or `{ dataProvider: [...] }`; each row has a `date`/`category` field plus one numeric field per year-line. Throws `Error('Unrecognized chart payload shape')` otherwise. **If the Task 7 fixture shows a different shape, adapt this function until the fixture test passes — the fixture is the source of truth.**

- [ ] **Step 1: Write the failing test `test/scarr.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, parseChartSeries } = require('../scarr');

function fakeFetchFactory(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error('no fake route for ' + url);
    return {
      ok: route.status < 400, status: route.status,
      headers: { getSetCookie: () => route.setCookies || [] },
      text: async () => route.body || '',
    };
  };
  return { fetchImpl, calls };
}

const endpoints = {
  base: 'https://scarr.test',
  login: { path: '/Login.action', usernameField: 'username', passwordField: 'password', staticFields: {} },
  savedCharts: { path: '/SavedCharts.action', type: 'json' },
  chartData: { path: '/ChartData.action', method: 'GET', param: 'newGeneralForm' },
};

test('login posts credentials and stores session cookie for later requests', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: '/Login.action', status: 302, setCookies: ['JSESSIONID=abc123; Path=/'] },
    { match: '/SavedCharts.action', status: 200, body: '[]' },
  ]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  await client.login();
  await client.listSavedCharts();
  assert.match(calls[0].opts.body, /username=u/);
  assert.match(calls[0].opts.body, /password=p/);
  assert.match(calls[1].opts.headers.cookie, /JSESSIONID=abc123/);
});

test('login throws on HTTP 401', async () => {
  const { fetchImpl } = fakeFetchFactory([{ match: '/Login.action', status: 401 }]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  await assert.rejects(() => client.login(), /Scarr login failed/);
});

test('fetchChartData sends the form JSON as the configured param', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: '/ChartData.action', status: 200, body: '{"dataProvider":[]}' },
  ]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  const out = await client.fetchChartData({ saveName: 'X' });
  assert.deepEqual(out, { dataProvider: [] });
  assert.match(calls[0].url, /newGeneralForm=%7B%22saveName%22%3A%22X%22%7D/);
});

test('parseChartSeries splits rows into per-line series', () => {
  const payload = { dataProvider: [
    { date: '2026-05-01', 'FC2027H/FC2027J/FC2027K': -0.5, 'FC2026H/FC2026J/FC2026K': 0.2 },
    { date: '2026-05-02', 'FC2027H/FC2027J/FC2027K': -0.4 },
  ] };
  const series = parseChartSeries(payload);
  assert.equal(series['FC2027H/FC2027J/FC2027K'].length, 2);
  assert.equal(series['FC2026H/FC2026J/FC2026K'].length, 1);
  assert.deepEqual(series['FC2027H/FC2027J/FC2027K'][0], { date: '2026-05-01', value: -0.5 });
});

test('parseChartSeries handles the real captured fixture', () => {
  const fixture = path.join(__dirname, 'fixtures/scarr/chart-data.json');
  const payload = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const series = parseChartSeries(payload);
  const labels = Object.keys(series);
  assert.ok(labels.length >= 2, 'expected multiple year lines, got: ' + labels.join());
  for (const label of labels) {
    assert.match(series[label][0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof series[label][0].value, 'number');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scarr'`

- [ ] **Step 3: Write `scarr.js`**

```js
const fs = require('node:fs');
const path = require('node:path');

function loadEndpoints() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config/scarr-endpoints.json'), 'utf8'));
}

function createClient({ username, password, endpoints, fetchImpl = fetch }) {
  const cookies = {};

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
  }

  async function request(pathAndQuery, { form = null } = {}) {
    const opts = { method: 'GET', headers: { cookie: cookieHeader() }, redirect: 'manual' };
    if (form) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(form).toString();
    }
    const res = await fetchImpl(endpoints.base + pathAndQuery, opts);
    storeCookies(res);
    return res;
  }

  async function login() {
    const e = endpoints.login;
    const form = { ...e.staticFields, [e.usernameField]: username, [e.passwordField]: password };
    const res = await request(e.path, { form });
    if (res.status >= 400) throw new Error('Scarr login failed: HTTP ' + res.status);
    return res;
  }

  async function listSavedCharts() {
    const e = endpoints.savedCharts;
    const res = await request(e.path);
    if (res.status >= 400) throw new Error('Scarr savedCharts failed: HTTP ' + res.status);
    const body = await res.text();
    return e.type === 'json' ? JSON.parse(body) : body;
  }

  async function fetchChartData(formObj) {
    const e = endpoints.chartData;
    const encoded = new URLSearchParams({ [e.param]: JSON.stringify(formObj) }).toString();
    const res = e.method === 'GET'
      ? await request(e.path + '?' + encoded)
      : await request(e.path, { form: { [e.param]: JSON.stringify(formObj) } });
    if (res.status >= 400) throw new Error('Scarr chartData failed: HTTP ' + res.status);
    return JSON.parse(await res.text());
  }

  return { login, listSavedCharts, fetchChartData, _cookies: () => ({ ...cookies }) };
}

function parseChartSeries(payload) {
  const rows = Array.isArray(payload) ? payload : payload && payload.dataProvider;
  if (!Array.isArray(rows)) throw new Error('Unrecognized chart payload shape');
  const series = {};
  for (const row of rows) {
    const date = row.date || row.category;
    if (!date) continue;
    for (const [key, value] of Object.entries(row)) {
      if (key === 'date' || key === 'category' || typeof value !== 'number') continue;
      (series[key] ||= []).push({ date: String(date).slice(0, 10), value });
    }
  }
  return series;
}

module.exports = { createClient, parseChartSeries, loadEndpoints };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. If the real-fixture test fails, adjust `parseChartSeries` to the fixture's actual shape (documented in `docs/scarr-endpoints.md`) until it passes — do not change the function's output contract.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Scarr client with cookie session and chart-series parser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Sync engine — fetch, store, score, flag

**Files:**
- Create: `sync.js`
- Test: `test/sync.test.js`

**Interfaces:**
- Consumes: `computeStrategyMetrics` from `scoring.js`; `parseChartSeries` from `scarr.js`; a `client` matching Task 8's shape; a `db` with `query(text, params)`.
- Produces: `sync.js` exports `{ runSync, splitCurrentAndPrior, labelYear, upsertPoints, getSetting, setSetting }`.
  - `labelYear(label)` → first 4-digit number in a line label, else 0.
  - `splitCurrentAndPrior(labels, yearsBack)` → `{ current, prior: string[] }` — newest label is current, next `yearsBack` are prior.
  - `getSetting(db, key, fallback)` / `setSetting(db, key, value)` — JSONB settings row.
  - `runSync({ db, client, todayDate })` → `{ syncRunId, results: [{ saveName, ok, points?, setupScore?, flagged?, error? }] }`. Logs a `sync_runs` row (status `'ok'` if every strategy succeeded, `'partial'` if some failed, `'failed'` if login threw). One failing strategy never aborts the rest. Idempotent per day (upserts).

- [ ] **Step 1: Write the failing test `test/sync.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCurrentAndPrior, labelYear, runSync } = require('../sync');

test('labelYear pulls the first 4-digit year', () => {
  assert.equal(labelYear('FC2027H/FC2027J/FC2027K'), 2027);
  assert.equal(labelYear('no-year'), 0);
});

test('splitCurrentAndPrior: newest is current, next N are prior', () => {
  const labels = ['FC2025H', 'FC2027H', 'FC2026H', 'FC2024H', 'FC2023H', 'FC2022H', 'FC2021H'];
  const { current, prior } = splitCurrentAndPrior(labels, 5);
  assert.equal(current, 'FC2027H');
  assert.deepEqual(prior, ['FC2026H', 'FC2025H', 'FC2024H', 'FC2023H', 'FC2022H']);
});

function fakeDb(strategies) {
  const log = [];
  return {
    log,
    async query(text, params) {
      log.push({ text, params });
      if (/SELECT .* FROM strategies/.test(text)) return { rows: strategies };
      if (/INSERT INTO sync_runs/.test(text)) return { rows: [{ id: 7 }] };
      if (/SELECT value FROM settings/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function syntheticPayload() {
  const rows = [];
  for (let d = 0; d < 60; d += 3) {
    for (const [label, yr, base] of [
      ['FC2027H', 2027, 1], ['FC2026H', 2026, 2], ['FC2025H', 2025, 2],
      ['FC2024H', 2024, 2], ['FC2023H', 2023, 2], ['FC2022H', 2022, 2],
    ]) {
      const dt = new Date(Date.UTC(yr - 1, 11, 20 + d)); // season Dec -> Feb
      rows.push({ date: dt.toISOString().slice(0, 10), [label]: base + d / 31 });
    }
  }
  return { dataProvider: rows };
}

test('runSync fetches, scores, upserts, and reports per strategy', async () => {
  const strategy = {
    id: 1, save_name: 'Test_HJK', years_back: 5,
    config: {
      startDate: '2026-12-01T00:00:00.000Z',
      window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
      form: { saveName: 'Test_HJK' },
    },
  };
  const db = fakeDb([strategy]);
  const client = {
    login: async () => {},
    fetchChartData: async () => syntheticPayload(),
  };
  const { syncRunId, results } = await runSync({ db, client, todayDate: '2027-01-05' });
  assert.equal(syncRunId, 7);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.ok(results[0].points > 0);
  assert.ok(results[0].setupScore >= 0 && results[0].setupScore <= 100);
  assert.ok(db.log.some((q) => /INSERT INTO series_points/.test(q.text)));
  assert.ok(db.log.some((q) => /INSERT INTO daily_scores/.test(q.text)));
  assert.ok(db.log.some((q) => /UPDATE sync_runs/.test(q.text)));
});

test('runSync marks a failing strategy but continues, status partial', async () => {
  const good = {
    id: 1, save_name: 'Good', years_back: 5,
    config: { startDate: '2026-12-01T00:00:00.000Z',
      window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
      form: {} },
  };
  const bad = { id: 2, save_name: 'Bad', years_back: 5, config: { form: {},
    window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 } } };
  const db = fakeDb([bad, good]);
  let call = 0;
  const client = {
    login: async () => {},
    fetchChartData: async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return syntheticPayload();
    },
  };
  const { results } = await runSync({ db, client, todayDate: '2027-01-05' });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /boom/);
  assert.equal(results[1].ok, true);
  const update = db.log.find((q) => /UPDATE sync_runs/.test(q.text));
  assert.equal(update.params[0], 'partial');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../sync'`

- [ ] **Step 3: Write `sync.js`**

```js
const { parseChartSeries } = require('./scarr');
const { computeStrategyMetrics, DEFAULT_WEIGHTS } = require('./scoring');

function labelYear(label) {
  const m = String(label).match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

function splitCurrentAndPrior(labels, yearsBack) {
  const sorted = [...labels].sort((a, b) => labelYear(b) - labelYear(a));
  return { current: sorted[0], prior: sorted.slice(1, 1 + yearsBack) };
}

async function getSetting(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]);
}

async function upsertPoints(db, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const placeholders = []; const params = [];
    chunk.forEach((r, j) => {
      const b = j * 4;
      placeholders.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(...r);
    });
    await db.query(
      `INSERT INTO series_points (strategy_id, line_label, trade_date, value)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (strategy_id, line_label, trade_date) DO UPDATE SET value = EXCLUDED.value`,
      params);
  }
}

function seasonStartMonthOf(strategy, currentSeries) {
  const sd = strategy.config && strategy.config.startDate;
  if (sd) return new Date(sd).getUTCMonth() + 1;
  const months = currentSeries.map((p) => Number(p.date.slice(5, 7)));
  return months.length ? Math.min(...months) : 1;
}

async function syncOneStrategy({ db, client, strategy, todayDate, threshold, weights }) {
  const payload = await client.fetchChartData(strategy.config.form);
  const series = parseChartSeries(payload);
  const labels = Object.keys(series);
  if (labels.length < 2) throw new Error('chart returned fewer than 2 year lines');

  const rows = [];
  for (const label of labels) {
    for (const p of series[label]) rows.push([strategy.id, label, p.date, p.value]);
  }
  await upsertPoints(db, rows);

  const { current, prior } = splitCurrentAndPrior(labels, strategy.years_back);
  const seasonStartMonth = seasonStartMonthOf(strategy, series[current]);
  const m = computeStrategyMetrics({
    currentYear: series[current],
    priorYears: prior.map((l) => series[l]),
    window: strategy.config.window,
    seasonStartMonth,
    todayDate,
    weights,
  });
  const flagged = m.inWindow && m.setupScore >= threshold;
  await db.query(
    `INSERT INTO daily_scores (strategy_id, score_date, direction, reliability, strength,
                               tracking, stretch_score, setup_score, in_window, flagged, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (strategy_id, score_date) DO UPDATE SET
       direction=EXCLUDED.direction, reliability=EXCLUDED.reliability, strength=EXCLUDED.strength,
       tracking=EXCLUDED.tracking, stretch_score=EXCLUDED.stretch_score,
       setup_score=EXCLUDED.setup_score, in_window=EXCLUDED.in_window,
       flagged=EXCLUDED.flagged, details=EXCLUDED.details`,
    [strategy.id, todayDate, m.direction, m.reliability, m.strength, m.tracking,
      m.stretchScore, m.setupScore, m.inWindow, flagged,
      JSON.stringify({ currentLabel: current, priorLabels: prior, nYears: m.nYears,
        percentile: m.percentile, seasonStartMonth })]);
  return { points: rows.length, setupScore: m.setupScore, flagged };
}

async function runSync({ db, client, todayDate }) {
  const { rows: [run] } = await db.query(
    `INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`);
  const results = [];
  let status = 'ok';
  try {
    await client.login();
    const { rows: strategies } = await db.query(
      'SELECT id, save_name, years_back, config FROM strategies WHERE active = true ORDER BY save_name');
    const threshold = await getSetting(db, 'score_threshold', 65);
    const weights = await getSetting(db, 'weights', DEFAULT_WEIGHTS);
    for (const strategy of strategies) {
      try {
        const r = await syncOneStrategy({ db, client, strategy, todayDate, threshold, weights });
        results.push({ saveName: strategy.save_name, ok: true, ...r });
      } catch (err) {
        status = 'partial';
        results.push({ saveName: strategy.save_name, ok: false, error: err.message });
      }
    }
  } catch (err) {
    status = 'failed';
    results.push({ saveName: '(login)', ok: false, error: err.message });
  }
  await db.query(
    `UPDATE sync_runs SET status = $1, finished_at = now(), detail = $2 WHERE id = $3`,
    [status, JSON.stringify(results), run.id]);
  return { syncRunId: run.id, results };
}

module.exports = { runSync, splitCurrentAndPrior, labelYear, upsertPoints, getSetting, setSetting };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sync engine - fetch series, upsert, score, flag, log runs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Dashboard, strategy detail with SVG chart, admin page

**Files:**
- Create: `chartsvg.js`, `routes/dashboard.js`, `views/dashboard.ejs`, `views/strategy.ejs`, `views/admin.ejs`
- Modify: `routes/strategies.js` (add `GET /:id` detail route), `server.js` (mount dashboard router, add cron)
- Test: `test/chartsvg.test.js`

**Interfaces:**
- Consumes: `toIndexed`, `seasonalAveragePath`, `seasonIndex`, `monthDayKey` from `scoring.js`; `runSync`, `getSetting`, `setSetting`, `splitCurrentAndPrior` from `sync.js`; `createClient`, `loadEndpoints` from `scarr.js`.
- Produces:
  - `chartsvg.js` exports `seasonChartSvg({ lines, width = 640, height = 220 })` → SVG string. `lines` = `[{ points: [{x, y}], cls }]` where `x`/`y` are raw data coordinates; the function normalizes into the viewBox and emits one `<polyline>` per line with `class="line {cls}"`.
  - `routes/dashboard.js` exports `{ router }` with (behind `requireAuth`): `GET /` (today's scores ranked), `GET /admin` (sync runs + threshold form), `POST /admin/settings` (save `score_threshold`), `POST /admin/sync` (run sync now, then redirect `/admin`).
  - `routes/strategies.js` gains `GET /:id` rendering `views/strategy.ejs` with the metric row + SVG of current year vs seasonal average.

- [ ] **Step 1: Write the failing test `test/chartsvg.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { seasonChartSvg } = require('../chartsvg');

test('seasonChartSvg renders one polyline per line, normalized to viewBox', () => {
  const svg = seasonChartSvg({
    lines: [
      { points: [{ x: 0, y: 10 }, { x: 50, y: 20 }], cls: 'current' },
      { points: [{ x: 0, y: 12 }, { x: 50, y: 18 }], cls: 'avg' },
    ],
    width: 100, height: 50,
  });
  assert.match(svg, /^<svg[^>]*viewBox="0 0 100 50"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, /class="line current"/);
  assert.match(svg, /class="line avg"/);
  assert.doesNotMatch(svg, /NaN/);
});

test('seasonChartSvg survives empty lines', () => {
  const svg = seasonChartSvg({ lines: [{ points: [], cls: 'current' }] });
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /NaN/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../chartsvg'`

- [ ] **Step 3: Write `chartsvg.js`**

```js
function seasonChartSvg({ lines, width = 640, height = 220 }) {
  const all = lines.flatMap((l) => l.points);
  const pad = 6;
  let body = '';
  if (all.length > 0) {
    const xs = all.map((p) => p.x); const ys = all.map((p) => p.y);
    const xmin = Math.min(...xs); const xmax = Math.max(...xs);
    const ymin = Math.min(...ys); const ymax = Math.max(...ys);
    const sx = (x) => xmax === xmin ? width / 2 : pad + (x - xmin) / (xmax - xmin) * (width - 2 * pad);
    const sy = (y) => ymax === ymin ? height / 2 : height - pad - (y - ymin) / (ymax - ymin) * (height - 2 * pad);
    for (const line of lines) {
      if (line.points.length === 0) continue;
      const pts = line.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
      body += `<polyline class="line ${line.cls}" fill="none" points="${pts}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

module.exports = { seasonChartSvg };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Write `routes/dashboard.js`**

```js
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { runSync, getSetting, setSetting } = require('../sync');
const { createClient, loadEndpoints } = require('../scarr');

function todayStr() { return new Date().toISOString().slice(0, 10); }

function buildClient() {
  return createClient({
    username: process.env.SCARR_USERNAME,
    password: process.env.SCARR_PASSWORD,
    endpoints: loadEndpoints(),
  });
}

async function runSyncNow() {
  return runSync({ db: pool, client: buildClient(), todayDate: todayStr() });
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows: scores } = await pool.query(
    `SELECT s.id, s.save_name, d.* FROM daily_scores d
       JOIN strategies s ON s.id = d.strategy_id
      WHERE d.score_date = (SELECT max(score_date) FROM daily_scores)
      ORDER BY d.flagged DESC, d.setup_score DESC`);
  const { rows: [lastRun] } = await pool.query(
    'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1');
  res.render('dashboard', { scores, lastRun });
});

router.get('/admin', async (req, res) => {
  const { rows: runs } = await pool.query(
    'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20');
  const threshold = await getSetting(pool, 'score_threshold', 65);
  res.render('admin', { runs, threshold });
});

router.post('/admin/settings', async (req, res) => {
  const t = Number(req.body.threshold);
  if (Number.isFinite(t) && t >= 0 && t <= 100) await setSetting(pool, 'score_threshold', t);
  res.redirect('/admin');
});

router.post('/admin/sync', async (req, res) => {
  try { await runSyncNow(); } catch (err) { console.error('manual sync failed:', err); }
  res.redirect('/admin');
});

module.exports = { router, runSyncNow };
```

- [ ] **Step 6: Write `views/dashboard.ejs`**

```html
<%- include('_head') %><%- include('_nav') %>
<main>
  <% if (lastRun && lastRun.status !== 'ok') { %>
    <div class="card" style="border-left:4px solid var(--bad)">
      Sync <strong><%= lastRun.status %></strong> — started <%= new Date(lastRun.started_at).toLocaleString('nl-NL') %>.
      Showing last good data. <a href="/admin">Details</a>
    </div>
  <% } %>
  <div class="card">
    <h2>Today's setups <span class="muted" style="font-size:.85rem"><%= scores.length ? scores[0].score_date.toISOString ? scores[0].score_date.toISOString().slice(0,10) : scores[0].score_date : '' %></span></h2>
    <% if (!scores.length) { %><p class="muted">No scores yet — import strategies and run a sync from <a href="/admin">Admin</a>.</p><% } %>
    <table>
      <tr><th>Strategy</th><th>Score</th><th>Dir</th><th>Reliability</th><th>Strength</th><th>Tracking</th><th>Entry</th><th>Window</th></tr>
      <% for (const r of scores) { %>
      <tr>
        <td><a href="/strategies/<%= r.id %>"><%= r.save_name %></a>
            <% if (r.flagged) { %><span class="badge flag">FLAGGED</span><% } %></td>
        <td class="score"><%= Math.round(r.setup_score) %></td>
        <td><%= r.direction > 0 ? '▲ long' : '▼ short' %></td>
        <td><%= Math.round(r.reliability * 100) %>%</td>
        <td><%= Math.round(r.strength * 100) %>%</td>
        <td><%= r.tracking == null ? '—' : r.tracking.toFixed(2) %></td>
        <td><%= Math.round(r.stretch_score * 100) %>%</td>
        <td><span class="badge <%= r.in_window ? 'flag' : 'off' %>"><%= r.in_window ? 'open' : 'closed' %></span></td>
      </tr>
      <% } %>
    </table>
  </div>
</main></body></html>
```

- [ ] **Step 7: Write `views/admin.ejs`**

```html
<%- include('_head') %><%- include('_nav') %>
<main>
  <div class="card">
    <h2>Admin</h2>
    <form method="post" action="/admin/sync" style="display:inline"><button>Sync now</button></form>
    <form method="post" action="/admin/settings" style="display:inline;margin-left:1rem">
      Flag threshold: <input name="threshold" type="number" min="0" max="100" value="<%= threshold %>" style="width:5rem">
      <button>Save</button>
    </form>
  </div>
  <div class="card"><h3>Sync history</h3><table>
    <tr><th>Started</th><th>Status</th><th>Detail</th></tr>
    <% for (const r of runs) { %>
    <tr>
      <td><%= new Date(r.started_at).toLocaleString('nl-NL') %></td>
      <td><span class="badge <%= r.status === 'ok' ? 'flag' : (r.status === 'running' ? 'off' : 'fail') %>"><%= r.status %></span></td>
      <td class="muted" style="font-size:.8rem">
        <% const d = r.detail || []; %>
        <%= d.filter(x => x.ok).length %> ok, <%= d.filter(x => !x.ok).length %> failed
        <% for (const f of d.filter(x => !x.ok).slice(0, 5)) { %><br><%= f.saveName %>: <%= f.error %><% } %>
      </td>
    </tr>
    <% } %>
  </table></div>
</main></body></html>
```

- [ ] **Step 8: Add strategy detail route** — in `routes/strategies.js`, add requires at top:

```js
const { toIndexed, seasonalAveragePath, seasonIndex, monthDayKey } = require('../scoring');
const { seasonChartSvg } = require('../chartsvg');
const { splitCurrentAndPrior } = require('../sync');
```

and add this route **before** `router.post('/:id/toggle', ...)`:

```js
router.get('/:id(\\d+)', async (req, res) => {
  const { rows: [strategy] } = await pool.query('SELECT * FROM strategies WHERE id = $1', [req.params.id]);
  if (!strategy) return res.status(404).send('Not found');
  const { rows: points } = await pool.query(
    `SELECT line_label, to_char(trade_date, 'YYYY-MM-DD') AS date, value
       FROM series_points WHERE strategy_id = $1 ORDER BY trade_date`, [strategy.id]);
  const { rows: [score] } = await pool.query(
    `SELECT * FROM daily_scores WHERE strategy_id = $1 ORDER BY score_date DESC LIMIT 1`, [strategy.id]);

  const byLabel = {};
  for (const p of points) (byLabel[p.line_label] ||= []).push({ date: p.date, value: p.value });
  let svg = null;
  const labels = Object.keys(byLabel);
  if (labels.length >= 2) {
    const seasonStartMonth = strategy.config.startDate
      ? new Date(strategy.config.startDate).getUTCMonth() + 1 : 1;
    const { current, prior } = splitCurrentAndPrior(labels, strategy.years_back);
    const avg = seasonalAveragePath(prior.map((l) => toIndexed(byLabel[l], seasonStartMonth)));
    const curPts = byLabel[current].map((p) => ({
      x: seasonIndex(monthDayKey(p.date), seasonStartMonth), y: p.value }));
    const avgPts = [...avg.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
    svg = seasonChartSvg({ lines: [
      { points: avgPts, cls: 'avg' },
      { points: curPts, cls: 'current' },
    ] });
  }
  res.render('strategy', { strategy, score, svg });
});
```

- [ ] **Step 9: Write `views/strategy.ejs`**

```html
<%- include('_head') %><%- include('_nav') %>
<main>
  <div class="card">
    <h2><%= strategy.save_name %></h2>
    <p class="muted">Window: <%= strategy.config.window.openMonth %> <%= strategy.config.window.openDate %>
      → <%= strategy.config.window.closeMonth %> <%= strategy.config.window.closeDate %>
      · <%= strategy.years_back %> years · <%= strategy.active ? 'active' : 'paused' %></p>
    <% if (score) { %>
    <table>
      <tr><th>Date</th><th>Score</th><th>Dir</th><th>Reliability</th><th>Strength</th><th>Tracking</th><th>Entry</th><th>Flagged</th></tr>
      <tr>
        <td><%= score.score_date.toISOString ? score.score_date.toISOString().slice(0,10) : score.score_date %></td>
        <td class="score"><%= Math.round(score.setup_score) %></td>
        <td><%= score.direction > 0 ? '▲ long' : '▼ short' %></td>
        <td><%= Math.round(score.reliability * 100) %>%</td>
        <td><%= Math.round(score.strength * 100) %>%</td>
        <td><%= score.tracking == null ? '—' : score.tracking.toFixed(2) %></td>
        <td><%= Math.round(score.stretch_score * 100) %>%</td>
        <td><span class="badge <%= score.flagged ? 'flag' : 'off' %>"><%= score.flagged ? 'YES' : 'no' %></span></td>
      </tr>
    </table>
    <% } else { %><p class="muted">Not scored yet.</p><% } %>
  </div>
  <% if (svg) { %>
  <div class="card">
    <h3>This year (blue) vs <%= strategy.years_back %>-year average (grey)</h3>
    <style>.line.current{stroke:var(--accent);stroke-width:2}.line.avg{stroke:#64748b;stroke-width:1.5;stroke-dasharray:4 3}</style>
    <%- svg %>
  </div>
  <% } %>
  <% if (strategy.source_url) { %>
  <p><a href="<%= strategy.source_url %>" target="_blank">Open on Scarr ↗</a></p>
  <% } %>
</main></body></html>
```

- [ ] **Step 10: Mount dashboard router + cron in `server.js`** — after the strategies mount add:

```js
const dashboard = require('./routes/dashboard');
app.use('/', dashboard.router);
```

and in `boot()`, after `await seedAdmin();` add:

```js
const cron = require('node-cron');
cron.schedule('0 7 * * *', () => {
  dashboard.runSyncNow().catch((err) => console.error('scheduled sync failed:', err));
}, { timezone: 'Europe/Amsterdam' });
```

- [ ] **Step 11: Run all tests + syntax checks**

Run: `npm test && node --check server.js && node --check routes/dashboard.js && node --check routes/strategies.js`
Expected: PASS, no errors.

- [ ] **Step 12: Commit**

```bash
git add -A && git commit -m "feat: dashboard, strategy detail chart, admin page, daily cron

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: GitHub + Railway deploy (MANUAL steps flagged)

**Files:** none new (README already documents env vars).

- [ ] **Step 1: Create the GitHub repo and push**

Run: `cd /Users/elsub_macmini/Desktop/Trading_Seasonals && gh repo create Trading_Seasonals --private --source . --push`
Expected: repo created under the user's GitHub account, `main` pushed.

- [ ] **Step 2 (MANUAL — Henk in Railway dashboard):** Create a new Railway project → "Deploy from GitHub repo" → select `Trading_Seasonals`. Add a Postgres service to the project (this injects `DATABASE_URL`).

- [ ] **Step 3 (MANUAL — Henk in Railway dashboard):** On the app service, set variables: `SESSION_SECRET` (random 32+ chars), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SCARR_USERNAME`, `SCARR_PASSWORD`. Never paste these into chat.

- [ ] **Step 4: Verify deploy**

Run: `curl -s https://<railway-domain>/healthz`
Expected: `{"ok":true}`

- [ ] **Step 5 (with Henk):** Log in at the Railway URL, import all saved-chart URLs on `/strategies/import`, press "Sync now" on `/admin`, and confirm: sync status `ok`, dashboard shows scored strategies, one strategy detail page shows the current-year vs average chart and the numbers eyeball-match the Scarr chart.

- [ ] **Step 6: Commit any fixes found during verification**, then tag:

```bash
git tag phase1 && git push --tags
```

---

## Self-Review Notes

- **Spec coverage:** Task 1–2 = scaffold/auth; Task 3+6 = strategy config parsing/import (also the manual-URL fallback path); Task 4–5 = the four metrics + Setup Score with lead-window flagging; Task 7 = discovery session (spec's "first implementation task"); Task 8 = swappable Scarr client + replay fixture tests (spec's format-change tripwire); Task 9 = idempotent daily sync + sync_runs logging; Task 10 = dashboard/detail/admin incl. failure banner, threshold tuning, Sync now, cron 07:00 Europe/Amsterdam; Task 11 = Railway deploy. Phase 2 (Vision TA) and Phase 3 (fundamentals + verdicts) are separate plans per the spec's build order.
- **Known open dependency:** Task 8's real-fixture test depends on Task 7's captured payload; the plan states the fixture is the source of truth and the output contract is fixed.
- **Type consistency check:** `computeStrategyMetrics` return keys match what `sync.js` reads (`m.direction, m.reliability, m.strength, m.tracking, m.stretchScore, m.setupScore, m.inWindow, m.percentile, m.nYears`); `parseChartSeries` output `{label: [{date, value}]}` matches `syncOneStrategy` usage; `splitCurrentAndPrior(labels, yearsBack)` signature consistent across Tasks 9–10.
