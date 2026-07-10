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
  // One card per cycle where a tradeable setup was identified.
  const setups = [];
  for (const r of all) {
    const cycles = (r.analog && r.analog.cycles) || [];
    for (const c of cycles) {
      if (c.verdict && c.verdict.opportunity) {
        setups.push({ id: r.id, save_name: r.save_name, cycle: c });
      }
    }
  }
  setups.sort((a, b) => (b.cycle.verdict.probability || 0) - (a.cycle.verdict.probability || 0));
  const { rows: [lastRun] } = await pool.query(
    'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1');
  res.render('dashboard', { setups, scanned: all.length, lastRun });
});

router.get('/admin', async (req, res) => {
  const { rows: runs } = await pool.query(
    'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20');
  const threshold = await getSetting(pool, 'score_threshold', 65);
  const { DEFAULT_MULTIPLIERS } = require('../trades');
  const saved = await getSetting(pool, 'multipliers', {});
  const multipliers = { ...DEFAULT_MULTIPLIERS, ...saved };
  res.render('admin', { runs, threshold, multipliers });
});

router.post('/admin/multipliers', async (req, res) => {
  try {
    const parsed = JSON.parse(req.body.multipliers || '{}');
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) clean[String(k).toUpperCase()] = n;
    }
    await setSetting(pool, 'multipliers', clean);
  } catch (err) {
    console.error('bad multipliers JSON:', err.message);
  }
  res.redirect('/admin');
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
