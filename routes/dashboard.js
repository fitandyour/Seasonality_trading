const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { runSync, importAllFromScarr, getSetting, setSetting } = require('../sync');
const { createClient, loadEndpoints } = require('../scarr');

function todayStr() { return new Date().toISOString().slice(0, 10); }

function buildClient() {
  return createClient({
    username: process.env.SCARR_USERNAME,
    endpoints: loadEndpoints(),
  });
}

async function runSyncNow() {
  return runSync({ db: pool, client: buildClient(), todayDate: todayStr() });
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows: all } = await pool.query(
    `SELECT s.id, s.save_name, d.* FROM daily_scores d
       JOIN strategies s ON s.id = d.strategy_id
      WHERE d.score_date = (SELECT max(score_date) FROM daily_scores)
      ORDER BY d.setup_score DESC`);
  // Only surface strategies where a tradeable setup was identified.
  const setups = all.filter((r) => r.analog && r.analog.trade);
  const { rows: [lastRun] } = await pool.query(
    'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1');
  res.render('dashboard', { setups, scanned: all.length, lastRun });
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

router.post('/admin/import-all', async (req, res) => {
  try {
    await importAllFromScarr({ db: pool, client: buildClient() });
  } catch (err) {
    console.error('import-all failed:', err);
  }
  res.redirect('/strategies');
});

module.exports = { router, runSyncNow };
