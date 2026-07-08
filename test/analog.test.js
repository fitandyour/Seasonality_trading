const test = require('node:test');
const assert = require('node:assert/strict');
const { analogMatch } = require('../scoring');

// Build a season-aligned series from a value function over day-indices.
function series(startYear, startMonth0, fn, days = 90, step = 1) {
  const pts = [];
  for (let d = 0; d < days; d += step) {
    const dt = new Date(Date.UTC(startYear, startMonth0, 1 + d));
    pts.push({ date: dt.toISOString().slice(0, 10), value: fn(d) });
  }
  return pts;
}

test('analogMatch ranks the most similar prior year first and reports its next move', () => {
  // Current year rises 0..30 days at slope +0.1 (so far), then we are "today" at day 30.
  const current = series(2027, 0, (d) => d * 0.1, 31);
  // Prior A: same early slope, then keeps rising to +6 by day 60 (strong up next).
  const priorA = series(2026, 0, (d) => d * 0.1, 90);
  // Prior B: same early slope, then falls hard after day 30 (down next).
  const priorB = series(2025, 0, (d) => (d <= 30 ? d * 0.1 : 3 - (d - 30) * 0.2), 90);
  // Prior C: unrelated/noisy, low similarity.
  const priorC = series(2024, 0, (d) => Math.sin(d) * 2 - 1, 90);

  const res = analogMatch({
    current,
    priors: [{ label: 'Y2026', points: priorA }, { label: 'Y2025', points: priorB }, { label: 'Y2024', points: priorC }],
    seasonStartMonth: 1,
    todayDate: '2027-01-31',
    windowCloseIdx: 59, // day 60
  });

  assert.equal(res.years.length, 3);
  // A and B both track the early slope perfectly, so both are high-similarity analogs.
  const byLabel = Object.fromEntries(res.years.map((y) => [y.label, y]));
  assert.ok(byLabel.Y2026.similarity > 0.99);
  assert.ok(byLabel.Y2025.similarity > 0.99);
  assert.ok(byLabel.Y2024.similarity < 0.8, `noisy year sim=${byLabel.Y2024.similarity}`);
  // A went up next, B went down next.
  assert.ok(byLabel.Y2026.nextMove > 2, `A nextMove=${byLabel.Y2026.nextMove}`);
  assert.ok(byLabel.Y2025.nextMove < 0, `B nextMove=${byLabel.Y2025.nextMove}`);
  // years sorted by similarity descending
  assert.ok(res.years[0].similarity >= res.years[1].similarity);
});

test('analogMatch aggregates agreement and opposite-side risk among close analogs', () => {
  const current = series(2027, 0, (d) => d * 0.1, 31);
  const up1 = series(2026, 0, (d) => (d <= 30 ? d * 0.1 : 3 + (d - 30) * 0.1), 90);
  const up2 = series(2025, 0, (d) => (d <= 30 ? d * 0.1 : 3 + (d - 30) * 0.12), 90);
  const up3 = series(2024, 0, (d) => (d <= 30 ? d * 0.1 : 3 + (d - 30) * 0.08), 90);
  const down1 = series(2023, 0, (d) => (d <= 30 ? d * 0.1 : 3 - (d - 30) * 0.15), 90);

  const res = analogMatch({
    current,
    priors: [
      { label: 'U1', points: up1 }, { label: 'U2', points: up2 },
      { label: 'U3', points: up3 }, { label: 'D1', points: down1 },
    ],
    seasonStartMonth: 1,
    todayDate: '2027-01-31',
    windowCloseIdx: 59,
    similarityThreshold: 0.9,
  });

  // 4 close analogs; 3 up, 1 down.
  assert.equal(res.agreementDirection, 1);
  assert.equal(res.agreementCount, 3);
  assert.equal(res.analogCount, 4);
  assert.ok(res.meanNextMove > 0);
  // opposite side risk: the one down year's adverse move is captured (>0 magnitude)
  assert.ok(res.oppositeRisk > 0, `oppositeRisk=${res.oppositeRisk}`);
  // score in 0..100
  assert.ok(res.score >= 0 && res.score <= 100);
});

test('analogMatch handles a year with no overlap gracefully', () => {
  const current = series(2027, 0, (d) => d * 0.1, 31);
  const disjoint = series(2026, 6, (d) => d, 30); // July start, no calendar overlap
  const res = analogMatch({
    current,
    priors: [{ label: 'DIS', points: disjoint }],
    seasonStartMonth: 1,
    todayDate: '2027-01-31',
    windowCloseIdx: 59,
  });
  assert.equal(res.years[0].similarity, null);
  assert.equal(res.analogCount, 0);
  assert.equal(res.score, 0);
});
