const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyRecordFromUrl } = require('../routes/strategies');

const URL_A = 'https://scarrtrading.com/SeasonalsGenerator.action?newGeneralForm=%7B%22saveName%22:%22Corn_C_UZ%22,%22legs%22:2,%22y1%22:5,%22openMonth%22:%22June%22,%22openDate%22:15,%22closeMonth%22:%22August%22,%22closeDate%22:1,%22selected%22:%5B%22C2026N/C2026Z%22%5D,%22startDate%22:%222026-01-05T00:00:00.000Z%22%7D';

test('strategyRecordFromUrl maps parse result to a DB record', () => {
  const rec = strategyRecordFromUrl(URL_A);
  assert.equal(rec.save_name, 'Corn_C_UZ');
  assert.equal(rec.years_back, 5);
  assert.equal(rec.source_url, URL_A);
  assert.equal(rec.config.window.openMonth, 'June');
});
