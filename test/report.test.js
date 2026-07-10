const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMonthlyReport, coachNotes } = require('../report');

function rt(over) {
  return {
    symbol: 'GF', contract: 'Aug26-Oct26 Calendar', type: 'Calendar', side: 'long',
    qty: 1, entryDate: '2026-07-01', exitDate: '2026-07-10',
    entryPrice: 6, exitPrice: 7, points: 1, pnl: 500, holdDays: 9, ...over,
  };
}

const CLOSED = [
  rt({ pnl: 500, points: 1 }),
  rt({ pnl: 250, points: 0.5, exitDate: '2026-07-12', type: 'Butterfly', contract: 'Aug26 1mo Butterfly' }),
  rt({ pnl: -200, points: -0.5, exitDate: '2026-07-15', side: 'short', symbol: 'HE' }),
  rt({ pnl: -100, points: -0.25, exitDate: '2026-07-20', symbol: 'HE' }),
  rt({ pnl: 400, points: 0.8, exitDate: '2026-08-02' }), // next month — excluded
];

test('computeMonthlyReport core stats', () => {
  const r = computeMonthlyReport({ closed: CLOSED, open: [], month: '2026-07' });
  assert.equal(r.month, '2026-07');
  assert.equal(r.trades, 4);
  assert.equal(r.wins, 2);
  assert.equal(r.losses, 2);
  assert.equal(r.winRate, 50);
  assert.equal(r.netPnl, 450);
  assert.equal(r.grossWin, 750);
  assert.equal(r.grossLoss, 300);
  assert.equal(r.profitFactor, 2.5);
  assert.equal(r.expectancy, 112.5);      // 450 / 4
  assert.equal(r.avgWin, 375);
  assert.equal(r.avgLoss, -150);
  assert.equal(r.payoff, 2.5);            // 375 / 150
  assert.equal(r.largestWin, 500);
  assert.equal(r.largestLoss, -200);
  assert.ok(r.avgHoldDays > 0);
});

test('computeMonthlyReport max drawdown follows cumulative realized P&L', () => {
  // +500, +250, -200, -100 → peak 750, trough 450 → dd 300
  const r = computeMonthlyReport({ closed: CLOSED, open: [], month: '2026-07' });
  assert.equal(r.maxDrawdown, 300);
});

test('computeMonthlyReport breakdowns by symbol, type, side', () => {
  const r = computeMonthlyReport({ closed: CLOSED, open: [], month: '2026-07' });
  const gf = r.bySymbol.find((x) => x.key === 'GF');
  const he = r.bySymbol.find((x) => x.key === 'HE');
  assert.equal(gf.trades, 2); assert.equal(gf.netPnl, 750);
  assert.equal(he.trades, 2); assert.equal(he.netPnl, -300);
  const cal = r.byType.find((x) => x.key === 'Calendar');
  assert.equal(cal.trades, 3);
  const long = r.bySide.find((x) => x.key === 'long');
  assert.equal(long.trades, 3);
  // expectancy per bucket present (per-setup insight)
  assert.equal(he.expectancy, -150);
});

test('computeMonthlyReport empty month', () => {
  const r = computeMonthlyReport({ closed: [], open: [], month: '2026-06' });
  assert.equal(r.trades, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.profitFactor, null);
  assert.equal(r.netPnl, 0);
});

test('coachNotes falls back to null without API key and flags source', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = computeMonthlyReport({ closed: CLOSED, open: [], month: '2026-07' });
    const notes = await coachNotes({ report: r });
    assert.equal(notes, null);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('coachNotes uses injected createMessage', async () => {
  const r = computeMonthlyReport({ closed: CLOSED, open: [], month: '2026-07' });
  const fake = { summary: 'Solid month.', strengths: ['GF calendars carried the month'], weaknesses: ['HE shorts drained'], actions: ['Cut HE size'] };
  let seen = null;
  const notes = await coachNotes({ report: r, createMessage: async (args) => { seen = args; return fake; } });
  assert.equal(notes.summary, 'Solid month.');
  assert.match(seen.user, /GF/);
  assert.match(seen.user, /profit factor/i);
});
