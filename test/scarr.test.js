const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, parseContractCode, rollForward, parseChartSeries } = require('../scarr');

function fakeFetchFactory(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error('no fake route for ' + url);
    return { ok: route.status < 400, status: route.status, text: async () => route.body || '' };
  };
  return { fetchImpl, calls };
}

const endpoints = {
  base: 'https://scarr.test',
  savedCharts: { path: '/GetSavedChartsFromDynamoDBServlet', method: 'GET', userParam: 'json' },
  chartConfig: {
    path: '/GetChartJsonFromDynamoDBServlet', method: 'POST',
    keyField: 'key', userField: 'user', databaseField: 'database', database: 'saved-charts',
  },
  contracts: { path: '/GetContractsServlet', method: 'POST', param: 'json' },
  chartData: { path: '/ControllerServlet', method: 'POST', param: 'json' },
};

test('listSavedCharts GETs with the username in the configured param', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: 'GetSavedChartsFromDynamoDBServlet', status: 200, body: '["A","B"]' },
  ]);
  const client = createClient({ username: 'henk', endpoints, fetchImpl });
  assert.deepEqual(await client.listSavedCharts(), ['A', 'B']);
  assert.match(calls[0].url, /GetSavedChartsFromDynamoDBServlet\?json=henk$/);
});

test('fetchChartConfig posts key/user/database and unwraps the json string', async () => {
  const inner = JSON.stringify({ saveName: 'X', y1: 5 });
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: 'GetChartJsonFromDynamoDBServlet', status: 200, body: JSON.stringify({ json: inner }) },
  ]);
  const client = createClient({ username: 'henk', endpoints, fetchImpl });
  const form = await client.fetchChartConfig('My Chart');
  assert.equal(form.saveName, 'X');
  assert.match(calls[0].opts.body, /key=My\+Chart/);
  assert.match(calls[0].opts.body, /user=henk/);
  assert.match(calls[0].opts.body, /database=saved-charts/);
});

test('fetchChartConfig throws a clear error when the name is unknown', async () => {
  const { fetchImpl } = fakeFetchFactory([
    { match: 'GetChartJsonFromDynamoDBServlet', status: 200, body: '{"json":""}' },
  ]);
  const client = createClient({ username: 'henk', endpoints, fetchImpl });
  await assert.rejects(() => client.fetchChartConfig('Nope'), /no stored config named "Nope"/);
});

test('fetchChartData posts the form JSON and parses the payload', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: 'ControllerServlet', status: 200, body: '{"unit":"d","values":[[20260430,1.4]]}' },
  ]);
  const client = createClient({ username: 'henk', endpoints, fetchImpl });
  const out = await client.fetchChartData({ saveName: 'X' });
  assert.equal(out.unit, 'd');
  assert.match(calls[0].opts.body, /json=%7B%22saveName%22%3A%22X%22%7D/);
});

test('parseContractCode handles 1- and 2-letter prefixes', () => {
  assert.deepEqual(parseContractCode('FC2027H'), { prefix: 'FC', year: 2027, month: 'H' });
  assert.deepEqual(parseContractCode('C2026N'), { prefix: 'C', year: 2026, month: 'N' });
});

test('rollForward anchors stale selected rows at the newest contracts', () => {
  const form = {
    saveName: 'T',
    sampleContract: ['FC2021H', 'FC2021J'],
    selected: ['FC2021H/FC2021J', 'FC2020H/FC2020J'],
  };
  const contracts = [[
    ['FC2027H', 'FC2026H', 'FC2025H', 'FC2024H', 'FC2023H', 'FC2022H'],
    ['FC2027J', 'FC2026J', 'FC2025J', 'FC2024J', 'FC2023J', 'FC2022J'],
  ]];
  const rolled = rollForward(form, contracts, 3);
  assert.deepEqual(rolled.sampleContract, ['FC2027H', 'FC2027J']);
  assert.deepEqual(rolled.selected, [
    'FC2027H/FC2027J', 'FC2026H/FC2026J', 'FC2025H/FC2025J', 'FC2024H/FC2024J',
  ]);
});

test('rollForward preserves cross-year leg offsets (old-crop/new-crop)', () => {
  const form = { saveName: 'C', selected: ['C2021N/C2022H'], sampleContract: ['C2021N', 'C2022H'] };
  const contracts = [[
    ['C2028N', 'C2027N', 'C2026N', 'C2025N'],
    ['C2029H', 'C2028H', 'C2027H', 'C2026H'],
  ]];
  const rolled = rollForward(form, contracts, 2);
  // newest feasible base: N=2028 needs H=2029 which exists
  assert.deepEqual(rolled.selected, ['C2028N/C2029H', 'C2027N/C2028H', 'C2026N/C2027H']);
});

test('parseChartSeries maps columnar values to labeled lines in order', () => {
  const payload = { unit: 'd', values: [
    [20260430, 1.4, null],
    [20260501, 0.2, -0.5],
    [20270325, null, -1.0],
  ] };
  const lines = parseChartSeries(payload, ['CUR', 'PRIOR']);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, 'CUR');
  assert.deepEqual(lines[0].points, [
    { date: '2026-04-30', value: 1.4 }, { date: '2026-05-01', value: 0.2 },
  ]);
  assert.deepEqual(lines[1].points[1], { date: '2027-03-25', value: -1.0 });
});

test('parseChartSeries handles the real captured fixture', () => {
  const payload = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/scarr/chart-data.json'), 'utf8'));
  const labels = ['FC2027H/FC2027J/FC2027K', 'FC2026H/FC2026J/FC2026K', 'FC2025H/FC2025J/FC2025K',
    'FC2024H/FC2024J/FC2024K', 'FC2023H/FC2023J/FC2023K', 'FC2022H/FC2022J/FC2022K',
    'FC2021H/FC2021J/FC2021K', 'FC2020H/FC2020J/FC2020K'];
  const lines = parseChartSeries(payload, labels);
  assert.equal(lines.length, 8);
  // current line is partial (stops near capture date), priors span the season
  assert.ok(lines[0].points.length > 30 && lines[0].points.length < 150,
    `current line pts: ${lines[0].points.length}`);
  assert.ok(lines[1].points.length > 250, `prior line pts: ${lines[1].points.length}`);
  assert.match(lines[0].points[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof lines[0].points[0].value, 'number');
});

test('rollForward works against the real stored config + contracts fixtures', () => {
  const stored = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/scarr/chart-config.json'), 'utf8'));
  const form = JSON.parse(stored.json);
  const contracts = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/scarr/contracts.json'), 'utf8'));
  const rolled = rollForward(form, contracts, form.y1);
  assert.equal(rolled.selected.length, form.y1 + 1);
  assert.match(rolled.selected[0], /^FC20\d\d[A-Z]/);
  const y0 = Number(rolled.selected[0].slice(2, 6));
  const y1 = Number(rolled.selected[1].slice(2, 6));
  assert.equal(y0 - y1, 1, 'consecutive years');
  assert.ok(y0 >= 2026, `anchored at current contracts, got ${y0}`);
});
