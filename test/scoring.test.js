const test = require('node:test');
const assert = require('node:assert/strict');
const {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
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
