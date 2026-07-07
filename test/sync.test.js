const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCurrentAndPrior, labelYear, runSync } = require('../sync');

test('labelYear pulls the first 4-digit year', () => {
  assert.equal(labelYear('FC2027H/FC2027J/FC2027K'), 2027);
  assert.equal(labelYear('no-year'), 0);
});

test('splitCurrentAndPrior: newest is current, next N are prior', () => {
  const labels = ['FC2025H', 'FC2027H', 'FC2026H', 'FC2024H', 'FC2023H', 'FC2022H', 'FC2021H'];
  const { current, prior } = splitCurrentAndPrior(labels, 5);
  assert.equal(current, 'FC2027H');
  assert.deepEqual(prior, ['FC2026H', 'FC2025H', 'FC2024H', 'FC2023H', 'FC2022H']);
});

function fakeDb(strategies) {
  const log = [];
  return {
    log,
    async query(text, params) {
      log.push({ text, params });
      if (/SELECT .* FROM strategies/.test(text)) return { rows: strategies };
      if (/INSERT INTO sync_runs/.test(text)) return { rows: [{ id: 7 }] };
      if (/SELECT value FROM settings/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function syntheticPayload() {
  const rows = [];
  for (let d = 0; d < 60; d += 3) {
    for (const [label, yr, base] of [
      ['FC2027H', 2027, 1], ['FC2026H', 2026, 2], ['FC2025H', 2025, 2],
      ['FC2024H', 2024, 2], ['FC2023H', 2023, 2], ['FC2022H', 2022, 2],
    ]) {
      const dt = new Date(Date.UTC(yr, 0, 1 + d)); // season Jan -> Mar per year
      rows.push({ date: dt.toISOString().slice(0, 10), [label]: base + d / 31 });
    }
  }
  return { dataProvider: rows };
}

test('runSync fetches, scores, upserts, and reports per strategy', async () => {
  const strategy = {
    id: 1, save_name: 'Test_HJK', years_back: 5,
    config: {
      startDate: '2026-12-01T00:00:00.000Z',
      window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
      form: { saveName: 'Test_HJK' },
    },
  };
  const db = fakeDb([strategy]);
  const client = {
    login: async () => {},
    fetchChartData: async () => syntheticPayload(),
  };
  const { syncRunId, results } = await runSync({ db, client, todayDate: '2027-01-05' });
  assert.equal(syncRunId, 7);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok(results[0].points > 0);
  assert.ok(results[0].setupScore >= 0 && results[0].setupScore <= 100);
  assert.ok(db.log.some((q) => /INSERT INTO series_points/.test(q.text)));
  assert.ok(db.log.some((q) => /INSERT INTO daily_scores/.test(q.text)));
  assert.ok(db.log.some((q) => /UPDATE sync_runs/.test(q.text)));
});

test('runSync marks a failing strategy but continues, status partial', async () => {
  const good = {
    id: 1, save_name: 'Good', years_back: 5,
    config: { startDate: '2026-12-01T00:00:00.000Z',
      window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
      form: {} },
  };
  const bad = { id: 2, save_name: 'Bad', years_back: 5, config: { form: {},
    window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 } } };
  const db = fakeDb([bad, good]);
  let call = 0;
  const client = {
    login: async () => {},
    fetchChartData: async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return syntheticPayload();
    },
  };
  const { results } = await runSync({ db, client, todayDate: '2027-01-05' });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /boom/);
  assert.equal(results[1].ok, true);
  const update = db.log.find((q) => /UPDATE sync_runs/.test(q.text));
  assert.equal(update.params[0], 'partial');
});
