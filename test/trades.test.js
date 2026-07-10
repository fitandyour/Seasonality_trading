const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFill, matchFills, spreadType, parseFillsFromImage, DEFAULT_MULTIPLIERS,
} = require('../trades');

test('normalizeFill cleans sides, numbers, and casing', () => {
  const f = normalizeFill({ side: 'S', qty: '1', symbol: 'gf', contract: ' Aug26-Oct26 Calendar ', price: '7.425', account: 'LA229146' });
  assert.equal(f.side, 'sell');
  assert.equal(f.qty, 1);
  assert.equal(f.symbol, 'GF');
  assert.equal(f.contract, 'Aug26-Oct26 Calendar');
  assert.equal(f.price, 7.425);
});

test('normalizeFill accepts B/buy variants and rejects junk', () => {
  assert.equal(normalizeFill({ side: 'B', qty: 2, symbol: 'HE', contract: 'X', price: 1 }).side, 'buy');
  assert.equal(normalizeFill({ side: 'Buy', qty: 2, symbol: 'HE', contract: 'X', price: 1 }).side, 'buy');
  assert.throws(() => normalizeFill({ side: '?', qty: 1, symbol: 'HE', contract: 'X', price: 1 }), /side/);
  assert.throws(() => normalizeFill({ side: 'B', qty: 0, symbol: 'HE', contract: 'X', price: 1 }), /qty/);
});

test('spreadType classifies calendars and butterflies', () => {
  assert.equal(spreadType('Aug26-Oct26 Calendar'), 'Calendar');
  assert.equal(spreadType('Aug26 1mo Butterfly'), 'Butterfly');
  assert.equal(spreadType('Dec26 Outright'), 'Other');
});

function fill(over) {
  return { trade_date: '2026-07-01', side: 'buy', qty: 1, symbol: 'GF', contract: 'Aug26-Oct26 Calendar', price: 6.5, id: 1, ...over };
}

test('matchFills: open long position with average price', () => {
  const { open, closed } = matchFills([
    fill({ id: 1, price: 6.0 }),
    fill({ id: 2, price: 7.0 }),
  ]);
  assert.equal(closed.length, 0);
  assert.equal(open.length, 1);
  assert.equal(open[0].side, 'long');
  assert.equal(open[0].qty, 2);
  assert.equal(open[0].avgPrice, 6.5);
});

test('matchFills: FIFO round trip computes points, dollars, hold days', () => {
  const { open, closed } = matchFills([
    fill({ id: 1, trade_date: '2026-07-01', side: 'buy', price: 6.375 }),
    fill({ id: 2, trade_date: '2026-07-08', side: 'sell', price: 7.425 }),
  ]);
  assert.equal(open.length, 0);
  assert.equal(closed.length, 1);
  const t = closed[0];
  assert.equal(t.side, 'long');
  assert.equal(t.points, 1.05);
  assert.equal(t.pnl, 1.05 * DEFAULT_MULTIPLIERS.GF); // GF $500/pt
  assert.equal(t.holdDays, 7);
});

test('matchFills: short round trip mirrors sign', () => {
  const { closed } = matchFills([
    fill({ id: 1, side: 'sell', price: 18.5, symbol: 'GF', contract: 'Sep26-Mar27 Calendar' }),
    fill({ id: 2, trade_date: '2026-07-05', side: 'buy', price: 17.525, symbol: 'GF', contract: 'Sep26-Mar27 Calendar' }),
  ]);
  assert.equal(closed[0].side, 'short');
  assert.ok(Math.abs(closed[0].points - 0.975) < 1e-9);
  assert.ok(closed[0].pnl > 0);
});

test('matchFills: partial fill leaves remainder open, matches FIFO order', () => {
  const { open, closed } = matchFills([
    fill({ id: 1, side: 'buy', qty: 3, price: 6.0 }),
    fill({ id: 2, trade_date: '2026-07-03', side: 'sell', qty: 2, price: 7.0 }),
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].qty, 2);
  assert.equal(open.length, 1);
  assert.equal(open[0].qty, 1);
});

test('matchFills keeps different contracts separate', () => {
  const { open } = matchFills([
    fill({ id: 1, contract: 'Aug26-Oct26 Calendar', side: 'buy' }),
    fill({ id: 2, contract: 'Sep26-Mar27 Calendar', side: 'sell' }),
  ]);
  assert.equal(open.length, 2);
});

test('matchFills uses custom multipliers and leaves pnl null when unknown', () => {
  const { closed } = matchFills([
    fill({ id: 1, symbol: 'XX', side: 'buy', price: 1 }),
    fill({ id: 2, symbol: 'XX', side: 'sell', price: 2 }),
  ], { GF: 500 });
  assert.equal(closed[0].points, 1);
  assert.equal(closed[0].pnl, null);
});

test('parseFillsFromImage maps vision output through normalizeFill', async () => {
  const vision = async () => ({ fills: [
    { side: 'S', qty: 1, exchange: 'CME', symbol: 'GF', contract: 'Aug26-Oct26 Calendar', price: 7.425, account: 'LA229146', tif: 'Day', orderType: 'Limit' },
    { side: 'B', qty: 1, exchange: 'CME', symbol: 'HE', contract: 'Aug26-Oct26 Calendar', price: 14.2, account: 'LA229146', tif: 'Day', orderType: 'Limit' },
  ] });
  const fills = await parseFillsFromImage({ imageBase64: 'x', mediaType: 'image/png', vision });
  assert.equal(fills.length, 2);
  assert.equal(fills[0].side, 'sell');
  assert.equal(fills[1].symbol, 'HE');
});

test('parseFillsFromImage without key and without injected vision throws a clear error', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => parseFillsFromImage({ imageBase64: 'x', mediaType: 'image/png' }),
      /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

const { matchContract } = require('../trades');

test('matchContract canonicalizes spacing, dashes, slashes, case', () => {
  assert.equal(
    matchContract('GF', 'Aug26-Oct26 Calendar'),
    matchContract('gf', ' Aug26 Oct26  calendar '));
  assert.equal(
    matchContract('GF', 'Aug26-Oct26 Calendar'),
    matchContract('GF', 'Aug26/Oct26 Calendar'));
  assert.notEqual(
    matchContract('GF', 'Aug26-Oct26 Calendar'),
    matchContract('GF', 'Sep26-Mar27 Calendar'));
});

test('matchFills matches a buy/sell pair that differ only in contract punctuation', () => {
  const { open, closed } = matchFills([
    { id: 1, trade_date: '2026-07-01', side: 'buy', qty: 1, symbol: 'GF', contract: 'Aug26-Oct26 Calendar', price: 6.5 },
    { id: 2, trade_date: '2026-07-02', side: 'sell', qty: 1, symbol: 'GF', contract: 'Aug26 Oct26 Calendar', price: 7.5 },
  ]);
  assert.equal(open.length, 0, 'punctuation-only difference should still close');
  assert.equal(closed.length, 1);
});

test('matchFills reports per-fill status: closed / open / partial', () => {
  const { status } = matchFills([
    { id: 1, trade_date: '2026-07-01', side: 'buy', qty: 2, symbol: 'GF', contract: 'Aug26-Oct26 Calendar', price: 6 },
    { id: 2, trade_date: '2026-07-05', side: 'sell', qty: 1, symbol: 'GF', contract: 'Aug26-Oct26 Calendar', price: 7 },
    { id: 3, trade_date: '2026-07-06', side: 'buy', qty: 1, symbol: 'HE', contract: 'Aug26-Oct26 Calendar', price: 5 },
  ]);
  assert.equal(status[1], 'partial'); // 1 of 2 matched
  assert.equal(status[2], 'closed');  // fully matched
  assert.equal(status[3], 'open');    // nothing to match against
});
