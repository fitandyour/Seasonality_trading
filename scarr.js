const fs = require('node:fs');
const path = require('node:path');

function loadEndpoints() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config/scarr-endpoints.json'), 'utf8'));
}

function createClient({ username, password, endpoints, fetchImpl = fetch }) {
  const cookies = {};

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
  }

  async function request(pathAndQuery, { form = null } = {}) {
    const opts = { method: 'GET', headers: { cookie: cookieHeader() }, redirect: 'manual' };
    if (form) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(form).toString();
    }
    const res = await fetchImpl(endpoints.base + pathAndQuery, opts);
    storeCookies(res);
    return res;
  }

  async function login() {
    const e = endpoints.login;
    const form = { ...e.staticFields, [e.usernameField]: username, [e.passwordField]: password };
    const res = await request(e.path, { form });
    if (res.status >= 400) throw new Error('Scarr login failed: HTTP ' + res.status);
    return res;
  }

  async function listSavedCharts() {
    const e = endpoints.savedCharts;
    const res = await request(e.path);
    if (res.status >= 400) throw new Error('Scarr savedCharts failed: HTTP ' + res.status);
    const body = await res.text();
    return e.type === 'json' ? JSON.parse(body) : body;
  }

  async function fetchChartData(formObj) {
    const e = endpoints.chartData;
    const encoded = new URLSearchParams({ [e.param]: JSON.stringify(formObj) }).toString();
    const res = e.method === 'GET'
      ? await request(e.path + '?' + encoded)
      : await request(e.path, { form: { [e.param]: JSON.stringify(formObj) } });
    if (res.status >= 400) throw new Error('Scarr chartData failed: HTTP ' + res.status);
    return JSON.parse(await res.text());
  }

  return { login, listSavedCharts, fetchChartData, _cookies: () => ({ ...cookies }) };
}

function parseChartSeries(payload) {
  const rows = Array.isArray(payload) ? payload : payload && payload.dataProvider;
  if (!Array.isArray(rows)) throw new Error('Unrecognized chart payload shape');
  const series = {};
  for (const row of rows) {
    const date = row.date || row.category;
    if (!date) continue;
    for (const [key, value] of Object.entries(row)) {
      if (key === 'date' || key === 'category' || typeof value !== 'number') continue;
      (series[key] ||= []).push({ date: String(date).slice(0, 10), value });
    }
  }
  return series;
}

module.exports = { createClient, parseChartSeries, loadEndpoints };
