const { parseChartSeries, rollForward } = require('./scarr');
const { configFromForm } = require('./scarrparse');
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

async function syncOneStrategy({ db, client, strategy, todayDate, threshold, weights }) {
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
  const rolled = rollForward(form, contracts, strategy.years_back);
  const payload = await client.fetchChartData(rolled);
  const lines = parseChartSeries(payload, rolled.selected);
  if (lines.length < 2) throw new Error('chart returned fewer than 2 year lines');

  // Wipe and rewrite so rolled-forward labels never mix with stale ones.
  await db.query('DELETE FROM series_points WHERE strategy_id = $1', [strategy.id]);
  const rows = [];
  for (const line of lines) {
    for (const p of line.points) rows.push([strategy.id, line.label, p.date, p.value]);
  }
  await upsertPoints(db, rows);

  // Column order is authoritative: line 0 = current year, then priors.
  const current = lines[0];
  const priors = lines.slice(1, 1 + strategy.years_back);
  const seasonStartMonth = Number(String(payload.values[0][0]).slice(4, 6));
  const m = computeStrategyMetrics({
    currentYear: current.points,
    priorYears: priors.map((l) => l.points),
    window: cfg.window,
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
      JSON.stringify({ currentLabel: current.label, priorLabels: priors.map((l) => l.label),
        nYears: m.nYears, percentile: m.percentile, seasonStartMonth })]);
  return { points: rows.length, setupScore: m.setupScore, flagged };
}

async function runSync({ db, client, todayDate }) {
  const { rows: [run] } = await db.query(
    `INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`);
  const results = [];
  let status = 'ok';
  try {
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
