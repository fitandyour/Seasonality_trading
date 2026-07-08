const test = require('node:test');
const assert = require('node:assert/strict');

// Force the deterministic fallback verdict (no network) in the sync path.
delete process.env.ANTHROPIC_API_KEY;

const { splitCurrentAndPrior, labelYear, runSync, importAllFromScarr } = require('../sync');

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
      if (/SELECT id, save_name, years_back, config FROM strategies/.test(text)) return { rows: strategies };
      if (/INSERT INTO sync_runs/.test(text)) return { rows: [{ id: 7 }] };
      if (/SELECT value FROM settings/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
}

const STORED_FORM = {
  saveName: 'Test_HJK', y1: 5,
  openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1,
  sampleContract: ['FC2021H'], selected: ['FC2021H', 'FC2020H'],
  startDate: '2019-12-01T00:00:00.000Z',
};

const CONTRACTS = [[['FC2027H', 'FC2026H', 'FC2025H', 'FC2024H', 'FC2023H', 'FC2022H', 'FC2021H']]];

// Columnar payload on the season axis (Jan 2027). Current (col 1) and the 5
// priors all rise ~1.0/31 per day, so analogs are highly similar and agree up.
function syntheticPayload() {
  const values = [];
  for (let d = 0; d < 60; d += 1) {
    const dt = new Date(Date.UTC(2027, 0, 1 + d));
    const ymd = Number(dt.toISOString().slice(0, 10).replace(/-/g, ''));
    const row = [ymd, 1 + d / 31];
    for (let k = 0; k < 5; k++) row.push(2 + d / 31);
    values.push(row);
  }
  return { unit: 'd', values };
}

function fakeClient(overrides = {}) {
  return {
    listSavedCharts: async () => ['Test_HJK'],
    fetchChartConfig: async () => STORED_FORM,
    fetchContracts: async () => CONTRACTS,
    fetchChartData: async () => syntheticPayload(),
    ...overrides,
  };
}

test('runSync rolls forward, analog-matches, stores verdict, reports', async () => {
  const strategy = {
    id: 1, save_name: 'Test_HJK', years_back: 5,
    config: { window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 }, form: STORED_FORM },
  };
  const db = fakeDb([strategy]);
  const { syncRunId, results } = await runSync({ db, client: fakeClient(), todayDate: '2027-01-20' });
  assert.equal(syncRunId, 7);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok(results[0].points > 0);
  assert.ok(results[0].setupScore >= 0 && results[0].setupScore <= 100);
  assert.ok(db.log.some((q) => /DELETE FROM series_points/.test(q.text)));
  assert.ok(db.log.some((q) => /INSERT INTO series_points/.test(q.text)));

  const scoreInsert = db.log.find((q) => /INSERT INTO daily_scores/.test(q.text));
  assert.ok(scoreInsert);
  const analog = JSON.parse(scoreInsert.params[6]);
  const verdict = JSON.parse(scoreInsert.params[7]);
  assert.ok(Array.isArray(analog.years), 'analog.years stored');
  assert.equal(analog.agreementDirection, 1, 'analogs agree up');
  assert.ok(['long', 'short', 'none'].includes(verdict.direction));
  assert.equal(verdict.source, 'fallback');
  assert.ok(db.log.some((q) => /UPDATE sync_runs/.test(q.text)));
});

test('runSync marks a failing strategy but continues, status partial', async () => {
  const good = {
    id: 1, save_name: 'Good', years_back: 5,
    config: { window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 }, form: STORED_FORM },
  };
  const bad = { id: 2, save_name: 'Bad', years_back: 5, config: { form: null } };
  const db = fakeDb([bad, good]);
  const client = fakeClient({
    fetchChartConfig: async (name) => {
      if (name === 'Bad') throw new Error('boom');
      return STORED_FORM;
    },
  });
  const { results } = await runSync({ db, client, todayDate: '2027-01-20' });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /boom/);
  assert.equal(results[1].ok, true, JSON.stringify(results[1]));
  const update = db.log.find((q) => /UPDATE sync_runs/.test(q.text));
  assert.equal(update.params[0], 'partial');
});

test('importAllFromScarr upserts every saved chart with its config', async () => {
  const db = fakeDb([]);
  const client = fakeClient({ listSavedCharts: async () => ['A', 'B'] });
  const results = await importAllFromScarr({ db, client });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  const inserts = db.log.filter((q) => /INSERT INTO strategies/.test(q.text));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[0], 'A');
  const config = JSON.parse(inserts[0].params[1]);
  assert.equal(config.yearsBack, 5);
  assert.equal(config.window.openMonth, 'January');
});
