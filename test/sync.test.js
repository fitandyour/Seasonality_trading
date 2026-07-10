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

// Columnar payload on one shared axis (Jan–Mar 2027). The current/front line
// (col 1) has data only through row 29 ("today"); the 5 priors span the whole
// window and all rise, so analogs are highly similar and agree up → long trade.
function syntheticPayload() {
  const values = [];
  for (let d = 0; d < 60; d += 1) {
    const dt = new Date(Date.UTC(2027, 0, 1 + d));
    const ymd = Number(dt.toISOString().slice(0, 10).replace(/-/g, ''));
    const row = [ymd, d <= 29 ? 1 + d / 31 : null];
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

test('runSync analyses alive cycles, evaluates each, stores opportunities', async () => {
  const strategy = {
    id: 1, save_name: 'Test_HJK', years_back: 5,
    config: { window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 }, form: STORED_FORM },
  };
  const db = fakeDb([strategy]);
  const { syncRunId, results } = await runSync({ db, client: fakeClient(), todayDate: '2027-01-20' });
  assert.equal(syncRunId, 7);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok(results[0].points > 0);
  assert.ok(results[0].trade >= 1, 'at least one opportunity identified');
  assert.ok(db.log.some((q) => /DELETE FROM series_points/.test(q.text)));
  assert.ok(db.log.some((q) => /INSERT INTO series_points/.test(q.text)));

  const scoreInsert = db.log.find((q) => /INSERT INTO daily_scores/.test(q.text));
  assert.ok(scoreInsert);
  const analog = JSON.parse(scoreInsert.params[6]);
  assert.ok(Array.isArray(analog.cycles) && analog.cycles.length >= 1, 'cycles stored');
  const first = analog.cycles[0];
  assert.equal(first.label, 'current');
  assert.ok(first.front, 'front contracts recorded');
  assert.equal(first.analog.agreementDirection, 1, 'analogs agree up');
  assert.ok(first.verdict, 'every analysed cycle gets a verdict');
  assert.equal(first.verdict.opportunity, true);
  assert.equal(first.verdict.side, 'long');
  assert.ok(first.verdict.entry != null && first.verdict.target != null && first.verdict.stop != null);
  assert.equal(first.verdict.source, 'fallback');
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

// Next-cycle classification: line 0's data ends far earlier on the shared
// axis than line 1's (a next-year spread mapped back one season), so line 1
// is the live current spread and line 0 the next cycle.
test('runSync classifies a next-year line and analyses both cycles', async () => {
  const contracts = [[['FC2027H', 'FC2026H', 'FC2025H', 'FC2024H', 'FC2023H', 'FC2022H', 'FC2021H']]];
  function payload() {
    const values = [];
    for (let d = 0; d < 400; d += 1) {
      const dt = new Date(Date.UTC(2026, 0, 1 + d)); // axis from 2026-01-01
      const ymd = Number(dt.toISOString().slice(0, 10).replace(/-/g, ''));
      const row = [ymd];
      row.push(d <= 60 ? 0.5 + d / 120 : null);   // col0: NEXT — ends ~300d before today
      row.push(d <= 360 ? 1 + d / 130 : null);    // col1: CURRENT live (ends "today")
      for (let k = 0; k < 5; k++) row.push(2 + d / 130); // 5 full priors
      values.push(row);
    }
    return { unit: 'd', values };
  }
  const strategy = {
    id: 9, save_name: 'NextTest', years_back: 5,
    config: { window: { openMonth: 'January', openDate: 1, closeMonth: 'March', closeDate: 1 }, form: STORED_FORM },
  };
  const db = fakeDb([strategy]);
  const client = fakeClient({
    fetchContracts: async () => contracts,
    fetchChartData: async () => payload(),
  });
  const { results } = await runSync({ db, client, todayDate: '2026-12-27' }); // = axis row 360
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  const scoreInsert = db.log.find((q) => /INSERT INTO daily_scores/.test(q.text));
  const analog = JSON.parse(scoreInsert.params[6]);
  assert.equal(analog.cycles.length, 2);
  const current = analog.cycles.find((c) => c.label === 'current');
  const next = analog.cycles.find((c) => c.label === 'next');
  assert.ok(current && next, 'both cycles present');
  assert.equal(current.front, 'FC2026H', 'live line is the current front');
  assert.equal(next.front, 'FC2027H', 'newest year is the next cycle');
  assert.ok(current.verdict, 'current evaluated');
  assert.ok(next.verdict, 'next evaluated');
  // next-cycle exit dates are shifted forward to real calendar time
  if (next.verdict.opportunity && next.verdict.exitDate) {
    assert.ok(next.verdict.exitDate >= '2026-12-27', `exitDate ${next.verdict.exitDate} should be in real future`);
  }
});
