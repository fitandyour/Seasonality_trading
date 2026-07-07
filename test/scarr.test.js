const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, parseChartSeries } = require('../scarr');

function fakeFetchFactory(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error('no fake route for ' + url);
    return {
      ok: route.status < 400, status: route.status,
      headers: { getSetCookie: () => route.setCookies || [] },
      text: async () => route.body || '',
    };
  };
  return { fetchImpl, calls };
}

const endpoints = {
  base: 'https://scarr.test',
  login: { path: '/Login.action', usernameField: 'username', passwordField: 'password', staticFields: {} },
  savedCharts: { path: '/SavedCharts.action', type: 'json' },
  chartData: { path: '/ChartData.action', method: 'GET', param: 'newGeneralForm' },
};

test('login posts credentials and stores session cookie for later requests', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: '/Login.action', status: 302, setCookies: ['JSESSIONID=abc123; Path=/'] },
    { match: '/SavedCharts.action', status: 200, body: '[]' },
  ]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  await client.login();
  await client.listSavedCharts();
  assert.match(calls[0].opts.body, /username=u/);
  assert.match(calls[0].opts.body, /password=p/);
  assert.match(calls[1].opts.headers.cookie, /JSESSIONID=abc123/);
});

test('login throws on HTTP 401', async () => {
  const { fetchImpl } = fakeFetchFactory([{ match: '/Login.action', status: 401 }]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  await assert.rejects(() => client.login(), /Scarr login failed/);
});

test('fetchChartData sends the form JSON as the configured param', async () => {
  const { fetchImpl, calls } = fakeFetchFactory([
    { match: '/ChartData.action', status: 200, body: '{"dataProvider":[]}' },
  ]);
  const client = createClient({ username: 'u', password: 'p', endpoints, fetchImpl });
  const out = await client.fetchChartData({ saveName: 'X' });
  assert.deepEqual(out, { dataProvider: [] });
  assert.match(calls[0].url, /newGeneralForm=%7B%22saveName%22%3A%22X%22%7D/);
});

test('parseChartSeries splits rows into per-line series', () => {
  const payload = { dataProvider: [
    { date: '2026-05-01', 'FC2027H/FC2027J/FC2027K': -0.5, 'FC2026H/FC2026J/FC2026K': 0.2 },
    { date: '2026-05-02', 'FC2027H/FC2027J/FC2027K': -0.4 },
  ] };
  const series = parseChartSeries(payload);
  assert.equal(series['FC2027H/FC2027J/FC2027K'].length, 2);
  assert.equal(series['FC2026H/FC2026J/FC2026K'].length, 1);
  assert.deepEqual(series['FC2027H/FC2027J/FC2027K'][0], { date: '2026-05-01', value: -0.5 });
});

const FIXTURE = path.join(__dirname, 'fixtures/scarr/chart-data.json');
test('parseChartSeries handles the real captured fixture',
  { skip: fs.existsSync(FIXTURE) ? false : 'fixture not captured yet (Task 7 discovery pending)' },
  () => {
    const payload = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const series = parseChartSeries(payload);
    const labels = Object.keys(series);
    assert.ok(labels.length >= 2, 'expected multiple year lines, got: ' + labels.join());
    for (const label of labels) {
      assert.match(series[label][0].date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof series[label][0].value, 'number');
    }
  });
