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
