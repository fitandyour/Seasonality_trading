const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { parseSavedChartUrl } = require('../scarrparse');
const { seasonIndex, monthDayKey } = require('../scoring');
const { seasonChartSvg } = require('../chartsvg');
const { splitCurrentAndPrior } = require('../sync');

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
    const seasonStartMonth = (score && score.details && score.details.seasonStartMonth)
      || (byLabel[labels[0]].length ? Number(byLabel[labels[0]][0].date.slice(5, 7)) : 1);
    const { current, prior } = splitCurrentAndPrior(labels, 5);
    const toPts = (label) => byLabel[label].map((p) => ({
      x: seasonIndex(monthDayKey(p.date), seasonStartMonth), y: p.value }));
    // Each prior year as its own line (year-by-year, not an average) + this year highlighted.
    const lines = prior.map((l) => ({ points: toPts(l), cls: 'prior' }));
    lines.push({ points: toPts(current), cls: 'current' });
    svg = seasonChartSvg({ lines });
  }
  res.render('strategy', { strategy, score, svg });
});

router.post('/:id/toggle', async (req, res) => {
  await pool.query('UPDATE strategies SET active = NOT active, updated_at = now() WHERE id = $1',
    [req.params.id]);
  res.redirect('/strategies');
});

module.exports = { router, strategyRecordFromUrl };
