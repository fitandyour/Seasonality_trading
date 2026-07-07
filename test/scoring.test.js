const test = require('node:test');
const assert = require('node:assert/strict');
const {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
  reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch,
  inWindow, computeStrategyMetrics, DEFAULT_WEIGHTS,
} = require('../scoring');

test('monthDayKey extracts MM-DD', () => {
  assert.equal(monthDayKey('2026-07-07'), '07-07');
});

test('seasonIndex orders dates within a May-start season, wrapping the year', () => {
  const may1 = seasonIndex('05-01', 5);
  const dec1 = seasonIndex('12-01', 5);
  const feb1 = seasonIndex('02-01', 5); // belongs to the tail of the season
  assert.equal(may1, 0);
  assert.ok(dec1 > may1);
  assert.ok(feb1 > dec1, 'February comes after December in a May-start season');
});

test('toIndexed + valueAt finds exact and nearest values', () => {
  const idxMap = toIndexed([
    { date: '2026-05-01', value: 1.0 },
    { date: '2026-05-08', value: 2.0 },
  ], 5);
  assert.equal(valueAt(idxMap, seasonIndex('05-01', 5)), 1.0);
  assert.equal(valueAt(idxMap, seasonIndex('05-03', 5)), 1.0); // nearest within tolerance
  assert.equal(valueAt(idxMap, seasonIndex('06-15', 5)), null); // too far
});

test('windowIndices maps a January->February window in a May-start season', () => {
  const { openIdx, closeIdx } = windowIndices(
    { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 }, 5);
  assert.ok(openIdx > seasonIndex('12-01', 5));
  assert.ok(closeIdx > openIdx);
});

test('seasonalAveragePath averages indices present in at least half the years', () => {
  const y1 = toIndexed([{ date: '2025-05-01', value: 2 }, { date: '2025-05-08', value: 4 }], 5);
  const y2 = toIndexed([{ date: '2024-05-01', value: 4 }], 5);
  const avg = seasonalAveragePath([y1, y2]);
  assert.equal(avg.get(seasonIndex('05-01', 5)), 3); // both years
  assert.equal(avg.get(seasonIndex('05-08', 5)), 4); // 1 of 2 years = exactly half, kept
});

test('reliabilityAndDirection: 4 of 5 years up', () => {
  const r = reliabilityAndDirection([2, 3, -1, 4, 2]);
  assert.equal(r.direction, 1);
  assert.equal(r.reliability, 0.8);
  assert.equal(r.nYears, 5);
});

test('reliabilityAndDirection ignores null moves and handles all-down', () => {
  const r = reliabilityAndDirection([-2, -3, null, -1]);
  assert.equal(r.direction, -1);
  assert.equal(r.reliability, 1);
  assert.equal(r.nYears, 3);
});

test('strengthScore: consistent moves score high, noisy moves low, few moves neutral', () => {
  assert.ok(strengthScore([3, 3.1, 2.9, 3, 3.05]) > 0.9);
  assert.ok(strengthScore([3, -2.8, 3.1, -3, 0.2]) < 0.3);
  assert.equal(strengthScore([3, 2]), 0.5);
});

test('trackingCorrelation: perfectly tracking year correlates ~1, needs 10 points', () => {
  const cur = new Map(); const avg = new Map();
  for (let i = 0; i < 12; i++) { cur.set(i, i * 2 + 1); avg.set(i, i * 3); }
  assert.ok(trackingCorrelation(cur, avg) > 0.999);
  const short = new Map([...cur].slice(0, 5));
  assert.equal(trackingCorrelation(short, avg), null);
});

test('entryStretch: cheap entry for a long seasonal scores high', () => {
  const cur = new Map([[10, 1.0]]);
  const priors = [new Map([[10, 2]]), new Map([[10, 3]]), new Map([[10, 4]]), new Map([[10, 5]])];
  const { percentile, stretchScore } = entryStretch(cur, priors, 10, 1);
  assert.equal(percentile, 0);       // below every prior year
  assert.equal(stretchScore, 1);     // best possible long entry
  assert.equal(entryStretch(cur, priors, 10, -1).stretchScore, 0); // worst short entry
});

test('inWindow includes 21-day lead and handles season wrap', () => {
  assert.equal(inWindow(100, 110, 140), true);   // in lead period
  assert.equal(inWindow(80, 110, 140), false);   // too early
  assert.equal(inWindow(150, 110, 140), false);  // past close
  assert.equal(inWindow(5, 340, 20), true);      // wrapped window, today after boundary
});

test('computeStrategyMetrics end-to-end on synthetic 5-year seasonal', () => {
  // 5 prior years all rising 1.0 between Jan 1 and Feb 1; current year tracking but cheaper.
  function yearSeries(startYear, base) {
    const pts = [];
    for (let d = 0; d < 60; d += 3) {
      const dt = new Date(Date.UTC(startYear, 0, 1 + d));
      pts.push({ date: dt.toISOString().slice(0, 10), value: base + d * (1 / 31) });
    }
    return pts;
  }
  const priorYears = [2021, 2022, 2023, 2024, 2025].map((y) => yearSeries(y, 2));
  const currentYear = yearSeries(2026, 1); // same shape, lower level = cheap
  const m = computeStrategyMetrics({
    currentYear, priorYears,
    window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
    seasonStartMonth: 12, todayDate: '2026-01-05',
  });
  assert.equal(m.direction, 1);
  assert.equal(m.reliability, 1);
  assert.ok(m.strength > 0.9);
  assert.ok(m.tracking > 0.99);
  assert.equal(m.stretchScore, 1);
  assert.ok(m.setupScore >= 95, `expected >=95, got ${m.setupScore}`);
  assert.equal(m.inWindow, true);
});
