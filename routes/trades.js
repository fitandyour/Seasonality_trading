const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { parseFillsFromImage, matchFills, DEFAULT_MULTIPLIERS } = require('../trades');
const { computeMonthlyReport, coachNotes } = require('../report');
const { getSetting } = require('../sync');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function todayStr() { return new Date().toISOString().slice(0, 10); }

async function loadMultipliers() {
  const saved = await getSetting(pool, 'multipliers', {});
  return { ...DEFAULT_MULTIPLIERS, ...saved };
}

async function allFills() {
  const { rows } = await pool.query(
    `SELECT id, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, side, qty,
            exchange, symbol, contract, price, account, tif, order_type, source
       FROM trades ORDER BY trade_date, id`);
  return rows;
}

async function insertFill(f, tradeDate, source) {
  // Skip exact duplicates (same day, side, qty, contract, price, account) —
  // protects against uploading the same screenshot twice.
  const { rows } = await pool.query(
    `SELECT id FROM trades WHERE trade_date = $1 AND side = $2 AND qty = $3
       AND symbol = $4 AND contract = $5 AND price = $6
       AND COALESCE(account,'') = COALESCE($7,'')`,
    [tradeDate, f.side, f.qty, f.symbol, f.contract, f.price, f.account]);
  if (rows.length) return false;
  await pool.query(
    `INSERT INTO trades (trade_date, side, qty, exchange, symbol, contract,
                         price, account, tif, order_type, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tradeDate, f.side, f.qty, f.exchange, f.symbol, f.contract,
      f.price, f.account, f.tif, f.orderType, source]);
  return true;
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const fills = await allFills();
  const multipliers = await loadMultipliers();
  const { open, closed, status } = matchFills(fills, multipliers);
  const recentClosed = closed.slice(-15).reverse();
  res.render('trades', {
    fills: fills.slice(-60).reverse(),
    status,
    open,
    recentClosed,
    msg: req.query.msg || null,
    err: req.query.err || null,
    today: todayStr(),
    visionAvailable: !!process.env.ANTHROPIC_API_KEY,
  });
});

router.post('/upload', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No image attached');
    const tradeDate = req.body.trade_date || todayStr();
    const fills = await parseFillsFromImage({
      imageBase64: req.file.buffer.toString('base64'),
      mediaType: req.file.mimetype || 'image/png',
    });
    if (!fills.length) throw new Error('No filled orders found in the screenshot');
    let added = 0; let skipped = 0;
    for (const f of fills) {
      (await insertFill(f, tradeDate, 'screenshot')) ? added++ : skipped++;
    }
    res.redirect(`/trades?msg=${encodeURIComponent(`Imported ${added} fill(s)` + (skipped ? `, skipped ${skipped} duplicate(s)` : ''))}`);
  } catch (err) {
    res.redirect(`/trades?err=${encodeURIComponent(err.message)}`);
  }
});

router.post('/add', async (req, res) => {
  try {
    const { normalizeFill } = require('../trades');
    const f = normalizeFill({
      side: req.body.side, qty: req.body.qty, symbol: req.body.symbol,
      contract: req.body.contract, price: req.body.price,
      exchange: req.body.exchange, account: req.body.account,
    });
    const added = await insertFill(f, req.body.trade_date || todayStr(), 'manual');
    res.redirect(`/trades?msg=${encodeURIComponent(added ? 'Trade added' : 'Duplicate — not added')}`);
  } catch (err) {
    res.redirect(`/trades?err=${encodeURIComponent(err.message)}`);
  }
});

router.post('/:id(\\d+)/date', async (req, res) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.trade_date || '')) {
    await pool.query('UPDATE trades SET trade_date = $1 WHERE id = $2',
      [req.body.trade_date, req.params.id]);
  }
  res.redirect('/trades');
});

// Edit a fill's key fields — used to correct an OCR misread so a stuck pair
// matches (e.g. align the contract text of a buy and sell).
router.post('/:id(\\d+)/edit', async (req, res) => {
  try {
    const { normalizeFill } = require('../trades');
    const f = normalizeFill({
      side: req.body.side, qty: req.body.qty, symbol: req.body.symbol,
      contract: req.body.contract, price: req.body.price,
    });
    const td = /^\d{4}-\d{2}-\d{2}$/.test(req.body.trade_date || '') ? req.body.trade_date : null;
    await pool.query(
      `UPDATE trades SET side=$1, qty=$2, symbol=$3, contract=$4, price=$5${td ? ', trade_date=$7' : ''}
         WHERE id=$6`,
      td ? [f.side, f.qty, f.symbol, f.contract, f.price, req.params.id, td]
        : [f.side, f.qty, f.symbol, f.contract, f.price, req.params.id]);
    res.redirect('/trades?msg=' + encodeURIComponent('Fill updated'));
  } catch (err) {
    res.redirect('/trades?err=' + encodeURIComponent(err.message));
  }
});

router.post('/:id(\\d+)/delete', async (req, res) => {
  await pool.query('DELETE FROM trades WHERE id = $1', [req.params.id]);
  res.redirect('/trades');
});

router.get('/report/:ym?', async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.params.ym || '') ? req.params.ym : todayStr().slice(0, 7);
  const fills = await allFills();
  const multipliers = await loadMultipliers();
  const { open, closed } = matchFills(fills, multipliers);
  const report = computeMonthlyReport({ closed, open, month: ym });
  const coach = await coachNotes({ report });
  // Months that actually have closed trades, for the picker.
  const months = [...new Set(closed.map((t) => t.exitDate.slice(0, 7)))].sort().reverse();
  if (!months.includes(ym)) months.unshift(ym);
  res.render('report', { report, coach, months, ym });
});

module.exports = { router };
