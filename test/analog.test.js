const test = require('node:test');
const assert = require('node:assert/strict');
const { alignedAnalog, identifyTrade, lastDataRow, median } = require('../scoring');

// Build columns on a shared row axis. current has data up to `todayRow`.
function cols({ todayRow, rows, currentFn, priorFns }) {
  const current = [];
  for (let i = 0; i < rows; i++) current.push(i <= todayRow ? currentFn(i) : null);
  return [current, ...priorFns.map((fn) => {
    const c = []; for (let i = 0; i < rows; i++) c.push(fn(i)); return c;
  })];
}

test('lastDataRow finds the final non-null row', () => {
  assert.equal(lastDataRow([1, 2, null, null]), 1);
  assert.equal(lastDataRow([null, null]), -1);
});

test('median handles even and odd lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('alignedAnalog: three analogs rise next, one falls — agreement long', () => {
  const todayRow = 20; const rows = 40;
  const early = (i) => i * 0.1;                 // shared early slope
  const up = (base) => (i) => (i <= todayRow ? i * 0.1 : base + (i - todayRow) * 0.2);
  const down = (i) => (i <= todayRow ? i * 0.1 : 2 - (i - todayRow) * 0.2);
  const columns = cols({
    todayRow, rows, currentFn: early,
    priorFns: [up(2), up(2), up(2), down],
  });
  const a = alignedAnalog({
    cols: columns, labels: ['CUR', 'U1', 'U2', 'U3', 'D1'], todayRow, closeRow: 39,
  });
  assert.equal(a.agreementDirection, 1);
  assert.equal(a.agreementCount, 3);
  assert.equal(a.analogCount, 4);
  assert.ok(a.meanNextMove > 0);
  assert.ok(a.oppositeRisk > 0);
  assert.ok(a.score > 0 && a.score <= 100);
  assert.equal(a.entry, columns[0][todayRow]);
});

test('alignedAnalog: a year with no overlap gets null similarity and is excluded', () => {
  const todayRow = 20; const rows = 40;
  const columns = cols({
    todayRow, rows, currentFn: (i) => i * 0.1,
    priorFns: [(i) => (i > 30 ? i : null)], // only data after today → no overlap
  });
  const a = alignedAnalog({ cols: columns, labels: ['CUR', 'DIS'], todayRow, closeRow: 39 });
  assert.equal(a.years[0].similarity, null);
  assert.equal(a.analogCount, 0);
  assert.equal(a.score, 0);
});

test('identifyTrade builds a long trade with entry/stop/target/exit from analogs', () => {
  const todayRow = 20;
  const analog = {
    entry: 2.0, agreementDirection: 1, agreementCount: 3, score: 70,
    years: [
      { label: 'U1', similarity: 0.97, nextMove: 3.0, maxFavorable: 3.4, maxAdverse: -0.5, favOffset: 12, advOffset: 3 },
      { label: 'U2', similarity: 0.95, nextMove: 2.6, maxFavorable: 2.8, maxAdverse: -0.7, favOffset: 10, advOffset: 2 },
      { label: 'U3', similarity: 0.92, nextMove: 2.9, maxFavorable: 3.1, maxAdverse: -0.4, favOffset: 14, advOffset: 4 },
    ],
  };
  const dates = Array.from({ length: 40 }, (_, i) => `2027-01-${String(i + 1).padStart(2, '0')}`);
  const t = identifyTrade(analog, { dates, todayRow });
  assert.equal(t.side, 'long');
  assert.equal(t.entry, 2.0);
  assert.ok(t.target > t.entry, `target ${t.target}`);
  assert.ok(t.stop < t.entry, `stop ${t.stop}`);
  assert.ok(t.exitDate && /^2027-/.test(t.exitDate));
  assert.ok(t.rr > 0);
  assert.equal(t.agreeCount, 3);
});

test('identifyTrade returns null when too few analogs agree', () => {
  const analog = { entry: 2.0, agreementDirection: 1, agreementCount: 2, score: 70, years: [] };
  assert.equal(identifyTrade(analog, { todayRow: 20 }), null);
});

test('identifyTrade returns null when score is below threshold', () => {
  const analog = {
    entry: 2.0, agreementDirection: 1, agreementCount: 4, score: 40,
    years: [{ label: 'U1', similarity: 0.9, nextMove: 1, maxFavorable: 1, maxAdverse: -1, favOffset: 5, advOffset: 1 }],
  };
  assert.equal(identifyTrade(analog, { todayRow: 20 }), null);
});

test('identifyTrade builds a short trade mirrored correctly', () => {
  const analog = {
    entry: 0.0, agreementDirection: -1, agreementCount: 3, score: 68,
    years: [
      { label: 'D1', similarity: 0.96, nextMove: -3.0, maxFavorable: 0.4, maxAdverse: -3.3, favOffset: 2, advOffset: 12 },
      { label: 'D2', similarity: 0.93, nextMove: -2.6, maxFavorable: 0.6, maxAdverse: -2.9, favOffset: 3, advOffset: 11 },
      { label: 'D3', similarity: 0.91, nextMove: -2.8, maxFavorable: 0.3, maxAdverse: -3.0, favOffset: 1, advOffset: 13 },
    ],
  };
  const dates = Array.from({ length: 40 }, (_, i) => `2027-02-${String(i + 1).padStart(2, '0')}`);
  const t = identifyTrade(analog, { dates, todayRow: 5 });
  assert.equal(t.side, 'short');
  assert.ok(t.target < t.entry, `target ${t.target}`);
  assert.ok(t.stop > t.entry, `stop ${t.stop}`);
});
