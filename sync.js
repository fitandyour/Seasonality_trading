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
