const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFrontIndex, safeName } = require('../scarr-export');

// Daily axis from `start` to `end` (inclusive); a column has data up to and
// including `last` (or none when last is null).
function axis(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function colsEndingAt(dates, lasts) {
  return lasts.map((last) => dates.map((d) => (last != null && d <= last ? 1 : null)));
}

const TODAY = '2026-09-21';

test('front near expiry: completed years ending a few weeks apart do not hijack it (Feeder U/V)', () => {
  // Real case: axis ends 09-30, live 2026 ends 09-18, completed 2025 ended 09-12.
  const dates = axis('2025-09-25', '2026-09-30');
  const cols = colsEndingAt(dates, ['2026-09-18', '2026-09-12', '2026-09-27', '2026-09-29']);
  assert.deepEqual(pickFrontIndex(dates, cols, TODAY), { index: 0, confirmed: true, k: 0 });
});

test('completed year ending inside today+60d does not beat the live front (Live Cattle V/Z)', () => {
  const dates = axis('2025-06-01', '2026-10-31');
  const cols = colsEndingAt(dates, ['2026-09-18', '2026-10-30', '2026-10-29', '2026-10-31']);
  assert.equal(pickFrontIndex(dates, cols, TODAY).index, 0);
});

test('axis anchored to an already-expired cycle: live front sits one year back (Soybeans X/K)', () => {
  const dates = axis('2023-11-13', '2026-05-14');
  const cols = colsEndingAt(dates, ['2025-09-18', '2026-05-13', '2026-05-13', '2026-05-14']);
  assert.deepEqual(pickFrontIndex(dates, cols, TODAY), { index: 0, confirmed: true, k: 1 });
});

test('further-out cycles ahead of the front are skipped (k steps down to the nearest)', () => {
  const dates = axis('2024-01-01', '2026-12-15');
  // 2028 cycle (k=2), 2027 cycle (k=1), live 2026 (k=0), then completed years
  const cols = colsEndingAt(dates, ['2024-09-18', '2025-09-18', '2026-09-18', '2026-12-14', '2026-12-15']);
  assert.deepEqual(pickFrontIndex(dates, cols, TODAY), { index: 2, confirmed: true, k: 0 });
});

test('a completed year that coincidentally ends at today does not extend the run', () => {
  // front k=0, next column also matches k=0 by coincidence → k did not step down
  const dates = axis('2025-09-25', '2026-09-30');
  const cols = colsEndingAt(dates, ['2026-09-18', '2026-09-19', '2026-09-29']);
  assert.equal(pickFrontIndex(dates, cols, TODAY).index, 0);
});

test('listed-but-empty and stale far-out columns before the front are passed over', () => {
  const dates = axis('2025-01-01', '2026-12-15');
  const cols = colsEndingAt(dates, [null, '2025-06-30', '2026-09-18', '2026-12-15']);
  assert.deepEqual(pickFrontIndex(dates, cols, TODAY), { index: 2, confirmed: true, k: 0 });
});

test('nothing provably trading: newest column with data, flagged unconfirmed', () => {
  const dates = axis('2025-01-01', '2026-12-15');
  const cols = colsEndingAt(dates, [null, '2026-12-14', '2026-12-15']);
  assert.deepEqual(pickFrontIndex(dates, cols, TODAY), { index: 1, confirmed: false, k: null });
});

test('weekend / holiday lag still counts as live', () => {
  const dates = axis('2025-06-01', '2026-10-31');
  const cols = colsEndingAt(dates, ['2026-09-15', '2026-10-30']); // 6 days old
  assert.equal(pickFrontIndex(dates, cols, TODAY).confirmed, true);
});

test('safeName replaces path separators', () => {
  assert.equal(safeName('Wheat_C_Z/H'), 'Wheat_C_Z-H');
});
