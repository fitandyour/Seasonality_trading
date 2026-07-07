const fs = require('node:fs');
const path = require('node:path');

// Endpoint paths/field names discovered 2026-07-08; see docs/scarr-endpoints.md.
function loadEndpoints() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config/scarr-endpoints.json'), 'utf8'));
}

function createClient({ username, endpoints, fetchImpl = fetch }) {
  if (!username) throw new Error('SCARR_USERNAME is required');

  async function get(pathAndQuery) {
    const res = await fetchImpl(endpoints.base + pathAndQuery, { redirect: 'manual' });
    if (res.status >= 400) throw new Error(`Scarr GET ${pathAndQuery.split('?')[0]} failed: HTTP ${res.status}`);
    return res.text();
  }

  async function postForm(p, fields) {
    const res = await fetchImpl(endpoints.base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    if (res.status >= 400) throw new Error(`Scarr POST ${p} failed: HTTP ${res.status}`);
    return res.text();
  }

  async function listSavedCharts() {
    const e = endpoints.savedCharts;
    return JSON.parse(await get(`${e.path}?${e.userParam}=${encodeURIComponent(username)}`));
  }

  async function fetchChartConfig(saveName) {
    const e = endpoints.chartConfig;
    const wrapper = JSON.parse(await postForm(e.path, {
      [e.keyField]: saveName,
      [e.userField]: username,
      [e.databaseField]: e.database,
    }));
    if (!wrapper.json) throw new Error(`Scarr has no stored config named "${saveName}"`);
    return JSON.parse(wrapper.json);
  }

  async function fetchContracts(sampleContract) {
    const e = endpoints.contracts;
    const body = await postForm(e.path, { [e.param]: JSON.stringify(sampleContract) });
    if (!body) throw new Error('Scarr contracts lookup returned an empty response');
    return JSON.parse(body);
  }

  async function fetchChartData(form) {
    const e = endpoints.chartData;
    const body = await postForm(e.path, { [e.param]: JSON.stringify(form) });
    if (!body) throw new Error('Scarr chart data returned an empty response');
    return JSON.parse(body);
  }

  return { listSavedCharts, fetchChartConfig, fetchContracts, fetchChartData };
}

// 'FC2027H' -> { prefix: 'FC', year: 2027, month: 'H' }
function parseContractCode(code) {
  const m = String(code).match(/^([A-Z]{1,3})(\d{4})(.+)$/);
  if (!m) throw new Error(`Unparseable contract code: ${code}`);
  return { prefix: m[1], year: Number(m[2]), month: m[3] };
}

// Contracts payload: [[ [leg1 newest-first], [leg2], ... ], ...extras]
function contractLegs(contractsPayload) {
  const first = contractsPayload[0];
  return Array.isArray(first) && Array.isArray(first[0]) ? first : contractsPayload;
}

// Rebuild sampleContract/selected anchored at the newest available
// contracts, preserving the saved row's per-leg year offsets and month
// letters (replicates the site's Contract Alignment). Row 0 = current year.
function rollForward(form, contractsPayload, yearsBack) {
  const rows = form.selected || [];
  if (!rows.length) throw new Error(`Config "${form.saveName}" has no selected contracts`);
  const legs = rows[0].split('/').map(parseContractCode);
  const baseYear = Math.min(...legs.map((l) => l.year));
  const offsets = legs.map((l) => l.year - baseYear);

  const avail = contractLegs(contractsPayload).map((leg) => new Set(leg));
  if (avail.length !== legs.length) {
    throw new Error(`Contract legs mismatch: config has ${legs.length}, Scarr returned ${avail.length}`);
  }
  const maxYear = Math.max(...[...avail[0]].map((c) => parseContractCode(c).year));

  let anchor = null;
  for (let b = maxYear; b >= baseYear; b--) {
    const ok = legs.every((l, i) => avail[i].has(`${l.prefix}${b + offsets[i]}${l.month}`));
    if (ok) { anchor = b; break; }
  }
  if (anchor == null) throw new Error(`No feasible current contracts found for "${form.saveName}"`);

  const selected = [];
  for (let k = 0; k <= yearsBack; k++) {
    selected.push(legs.map((l, i) => `${l.prefix}${anchor - k + offsets[i]}${l.month}`).join('/'));
  }
  return {
    ...form,
    sampleContract: selected[0].split('/'),
    selected,
    hiddenAmchartsItems: [],
  };
}

// {unit:'d', values:[[yyyymmdd, v0, v1, ...], ...]} + labels (selected order)
// -> [{ label, points: [{date:'YYYY-MM-DD', value}] }] in column order.
function parseChartSeries(payload, labels = []) {
  if (!payload || !Array.isArray(payload.values) || !payload.values.length) {
    throw new Error('Unrecognized chart payload shape');
  }
  const nCols = payload.values[0].length - 1;
  const lines = [];
  for (let c = 0; c < nCols; c++) lines.push({ label: labels[c] || `line_${c}`, points: [] });
  for (const row of payload.values) {
    const d = String(row[0]);
    if (d.length !== 8) continue;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    for (let c = 0; c < nCols; c++) {
      if (typeof row[c + 1] === 'number') lines[c].points.push({ date, value: row[c + 1] });
    }
  }
  return lines;
}

module.exports = { createClient, loadEndpoints, parseContractCode, rollForward, parseChartSeries };
