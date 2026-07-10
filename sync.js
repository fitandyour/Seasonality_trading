const { rollForwardAt, feasibleAnchors } = require('./scarr');
const { configFromForm, MONTH_NUM } = require('./scarrparse');
const { alignedAnalog, identifyTrade, lastDataRow } = require('./scoring');
const { evaluateCycle } = require('./analysis');

const DEFAULT_ANALOG_YEARS = 5;

function pad2(n) { return String(n).padStart(2, '0'); }

// The row nearest the next occurrence of the window-close calendar date at or
// after today. Falls back to the last row when the window has already passed.
function closeRowOf(dates, window, todayRow) {
  const [ty, tm, td] = dates[todayRow].split('-').map(Number);
  const cm = MONTH_NUM[window.closeMonth]; const cd = window.closeDate;
  const year = (cm < tm || (cm === tm && cd < td)) ? ty + 1 : ty;
  const target = `${year}-${pad2(cm)}-${pad2(cd)}`;
  for (let i = todayRow + 1; i < dates.length; i++) if (dates[i] >= target) return i;
  return dates.length - 1;
}

// Scarr's columnar payload → shared date axis + one value column per year.
function matrixFromPayload(payload) {
  const dates = payload.values.map((r) => {
    const s = String(r[0]);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  });
  const nCols = payload.values[0].length - 1;
  const cols = [];
  for (let c = 0; c < nCols; c++) {
    cols.push(payload.values.map((r) => (typeof r[c + 1] === 'number' ? r[c + 1] : null)));
  }
  return { dates, cols };
}

// Fetch one contract cycle, align it, and identify a mechanical candidate.
async function analyseCycle({ client, form, contracts, anchor, analogYears, window }) {
  const rolled = rollForwardAt(form, contracts, analogYears, anchor);
  const payload = await client.fetchChartData(rolled);
  const { dates, cols } = matrixFromPayload(payload);
  if (cols.length < 2) throw new Error('chart returned fewer than 2 year lines');
  const todayRow = lastDataRow(cols[0]);
  const base = {
    anchor, rolled, dates, cols, labels: rolled.selected,
    front: rolled.selected[0], todayRow,
    axisEnd: dates[dates.length - 1],
  };
  if (todayRow < 5) return { ...base, analog: null, trade: null };
  const closeRow = closeRowOf(dates, window, todayRow);
  const analog = alignedAnalog({ cols, labels: rolled.selected, todayRow, closeRow });
  const trade = identifyTrade(analog, { dates, todayRow });
  return { ...base, analog, trade: trade || null };
}

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

async function syncOneStrategy({ db, client, strategy, todayDate, analogYears }) {
  // Prefer the live stored config from Scarr; fall back to the config
  // captured at import time (pasted URL).
  let form = strategy.config.form;
  try {
    form = await client.fetchChartConfig(strategy.save_name);
  } catch (err) {
    if (!form) throw err;
  }
  if (!form) throw new Error('no config available');

  const cfg = configFromForm(form);
  const contracts = await client.fetchContracts(form.sampleContract);
  const anchors = feasibleAnchors(form, contracts);
  if (!anchors.length) throw new Error(`no feasible contracts for "${strategy.save_name}"`);

  // Fetch the two newest cycles; keep the ones still alive (axis end not yet
  // past). The alive cycle expiring soonest is what you'd trade now
  // ("current"); the later one is "next" (MRCI: entry date determines the
  // delivery months).
  const fetched = [];
  for (const anchor of anchors.slice(0, 2)) {
    try {
      fetched.push(await analyseCycle({
        client, form, contracts, anchor, analogYears, window: cfg.window,
      }));
    } catch (err) { /* skip an unbuildable cycle */ }
  }
  if (!fetched.length) throw new Error('no cycle produced usable data');
  let alive = fetched.filter((c) => c.axisEnd >= todayDate);
  if (!alive.length) alive = [fetched[0]];
  alive.sort((a, b) => (a.axisEnd < b.axisEnd ? -1 : 1));
  alive = alive.slice(0, 2);
  alive.forEach((c, i) => { c.label = i === 0 ? 'current' : 'next'; });

  // Wipe and rewrite all alive cycles' series (labels are per-year, no clash).
  await db.query('DELETE FROM series_points WHERE strategy_id = $1', [strategy.id]);
  const rows = [];
  for (const c of alive) {
    c.cols.forEach((col, j) => {
      col.forEach((v, i) => {
        if (v != null) rows.push([strategy.id, c.labels[j], c.dates[i], v]);
      });
    });
  }
  await upsertPoints(db, rows);

  // Hybrid judgment: Claude (or the mechanical fallback) evaluates EVERY
  // alive cycle with usable analogs — not only the ones that passed filters.
  const cycles = [];
  for (const c of alive) {
    const analog = c.analog
      || { years: [], analogCount: 0, agreementDirection: 0, agreementCount: 0, score: 0, entry: null };
    const verdict = c.analog
      ? await evaluateCycle({ strategy, cycle: { label: c.label, front: c.front, analog, trade: c.trade }, todayDate })
      : null;
    cycles.push({
      label: c.label, anchor: c.anchor, front: c.front, labels: c.labels,
      analog, trade: c.trade, verdict,
    });
  }

  const opportunities = cycles.filter((c) => c.verdict && c.verdict.opportunity);
  const best = opportunities[0] || cycles.reduce((a, b) => ((b.analog.score || 0) > (a.analog.score || 0) ? b : a), cycles[0]);
  const flagged = opportunities.length > 0;

  await db.query(
    `INSERT INTO daily_scores (strategy_id, score_date, direction, setup_score,
                               in_window, flagged, analog, verdict, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (strategy_id, score_date) DO UPDATE SET
       direction=EXCLUDED.direction, setup_score=EXCLUDED.setup_score,
       in_window=EXCLUDED.in_window, flagged=EXCLUDED.flagged,
       analog=EXCLUDED.analog, verdict=EXCLUDED.verdict, details=EXCLUDED.details`,
    [strategy.id, todayDate, best.analog.agreementDirection || 0,
      Math.max(...cycles.map((c) => c.analog.score || 0)), flagged, flagged,
      JSON.stringify({ cycles }), best.verdict ? JSON.stringify(best.verdict) : null,
      JSON.stringify({ todayDate, anchors: cycles.map((c) => c.anchor) })]);
  return {
    points: rows.length,
    setupScore: Math.max(...cycles.map((c) => c.analog.score || 0)),
    flagged,
    trade: opportunities.length,
  };
}

async function runSync({ db, client, todayDate }) {
  const { rows: [run] } = await db.query(
    `INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`);
  const results = [];
  let status = 'ok';
  try {
    const { rows: strategies } = await db.query(
      'SELECT id, save_name, years_back, config FROM strategies WHERE active = true ORDER BY save_name');
    const analogYears = await getSetting(db, 'analog_years', DEFAULT_ANALOG_YEARS);
    for (const strategy of strategies) {
      try {
        const r = await syncOneStrategy({ db, client, strategy, todayDate, analogYears });
        results.push({ saveName: strategy.save_name, ok: true, ...r });
      } catch (err) {
        status = 'partial';
        results.push({ saveName: strategy.save_name, ok: false, error: err.message });
      }
    }
  } catch (err) {
    status = 'failed';
    results.push({ saveName: '(sync)', ok: false, error: err.message });
  }
  await db.query(
    `UPDATE sync_runs SET status = $1, finished_at = now(), detail = $2 WHERE id = $3`,
    [status, JSON.stringify(results), run.id]);
  return { syncRunId: run.id, results };
}

// Pull the full saved-charts list from Scarr and upsert every strategy.
async function importAllFromScarr({ db, client }) {
  const names = await client.listSavedCharts();
  const results = [];
  for (const name of names) {
    try {
      const form = await client.fetchChartConfig(name);
      const config = configFromForm(form);
      await db.query(
        `INSERT INTO strategies (save_name, source_url, config, years_back)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT (save_name) DO UPDATE
           SET config = EXCLUDED.config, years_back = EXCLUDED.years_back, updated_at = now()`,
        [name, JSON.stringify(config), config.yearsBack]);
      results.push({ saveName: name, ok: true });
    } catch (err) {
      results.push({ saveName: name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  runSync, importAllFromScarr, splitCurrentAndPrior, labelYear,
  upsertPoints, getSetting, setSetting,
};
