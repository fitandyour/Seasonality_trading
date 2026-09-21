#!/usr/bin/env node
// Export a saved Scarr chart's aligned year-by-year data to CSV (and SVG),
// ready to hand to a Claude coach.
//   node scarr-export.js "<chart name or substring>" [years] [outDir]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient, loadEndpoints, rollForwardAt, feasibleAnchors } = require('./scarr');
const { matrixFromPayload } = require('./sync');
const { seasonChartSvg } = require('./chartsvg');

const USERNAME = process.env.SCARR_USERNAME || 'bakkerh';

// Filesystem-safe filename from a strategy name (macOS forbids '/', shows ':'
// as '/'), while staying readable and close to the original name.
function safeName(name) {
  return name.replace(/[\/:]+/g, '-').replace(/\s+/g, ' ').trim();
}

function addDaysStr(d, n) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Pick the LIVE FRONT column. Scarr maps every contract-year onto one shared
// axis by shifting it a whole number of years. A cycle that is still trading
// has its newest data point at REAL today, so on the axis it ends at
// today - k years: k = 0 for the cycle the axis is anchored to, k = 1 for the
// next one out, and so on. Completed years end wherever their expiry fell, not
// there. Columns are newest-first, so the still-trading cycles are a leading
// run with k stepping DOWN toward the nearest one; that nearest one is the
// front. (Rules based on "ends nearest to today" or "stops short of the axis
// end" both break: near expiry, and when the axis is anchored to a cycle that
// has already expired.)
// Returns { index, confirmed, k }. confirmed=false means no column could be
// shown to be trading (stale feed, odd chart) and index is only the newest
// column with data: callers should surface that, never trust it silently.
function yearsBack(dateStr, k) {
  return `${Number(dateStr.slice(0, 4)) - k}${dateStr.slice(4)}`;
}
function dayDiff(a, b) { // a - b in days
  return Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);
}
function liveOffset(last, today, toleranceDays, maxK = 6) {
  for (let k = 0; k <= maxK; k++) {
    const d = dayDiff(yearsBack(today, k), last);
    if (d >= 0 && d <= toleranceDays) return k;
  }
  return null;
}
function pickFrontIndex(dates, cols, today = new Date().toISOString().slice(0, 10), toleranceDays = 7) {
  let front = null; let frontK = null; let skipped = 0;
  for (let c = 0; c < cols.length; c++) {
    let last = null;
    for (let i = dates.length - 1; i >= 0; i--) if (cols[c][i] != null) { last = dates[i]; break; }
    if (last == null) continue;                       // listed, no data yet
    const k = liveOffset(last, today, toleranceDays);
    if (k == null && front == null && skipped < 3) { skipped += 1; continue; } // thin far-out cycle, stale quote
    if (k == null || (frontK != null && k >= frontK)) break; // run of live cycles ends
    front = c; frontK = k;
  }
  if (front != null) return { index: front, confirmed: true, k: frontK };
  const firstWithData = cols.findIndex((col) => col.some((v) => v != null));
  return { index: firstWithData === -1 ? 0 : firstWithData, confirmed: false, k: null };
}

// Fetch + write one chart. Returns { name, labels, rows, csvPath, svgPath }.
async function exportChart({ client, name, years = 10, outDir, csvOnly = false }) {
  const form = await client.fetchChartConfig(name);
  const contracts = await client.fetchContracts(form.sampleContract);
  const anchors = feasibleAnchors(form, contracts);
  if (!anchors.length) throw new Error('no feasible contracts');
  // Fetch a couple extra years so that after we skip any not-yet-live future
  // cycles, the live front + `years` real priors are all present.
  const rolled = rollForwardAt(form, contracts, years + 2, anchors[0]);
  const payload = await client.fetchChartData(rolled);
  const full = matrixFromPayload(payload);
  let { dates, cols } = full;
  let labels = rolled.selected;

  // Drop any further-out cycles ahead of the live front, keep front + `years`
  // priors.
  const front = pickFrontIndex(dates, cols);
  const frontIdx = front.index;
  cols = cols.slice(frontIdx, frontIdx + years + 1);
  labels = labels.slice(frontIdx, frontIdx + years + 1);

  const header = ['Date', ...labels];
  const lines = [header.join(',')];
  for (let i = 0; i < dates.length; i++) {
    const row = [dates[i]];
    for (let c = 0; c < cols.length; c++) {
      const v = cols[c][i];
      row.push(v == null ? '' : Math.round(v * 1000) / 1000);
    }
    lines.push(row.join(','));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = safeName(name);
  const csvPath = path.join(outDir, `${base}.csv`);
  fs.writeFileSync(csvPath, lines.join('\n'));

  let svgPath = null;
  if (!csvOnly) {
    const toPts = (c) => dates.map((d, i) => (cols[c][i] == null ? null : { x: i, y: cols[c][i] })).filter(Boolean);
    const svgLines = [];
    for (let c = cols.length - 1; c >= 1; c--) svgLines.push({ points: toPts(c), cls: 'prior' });
    svgLines.push({ points: toPts(0), cls: 'current' });
    const svg = seasonChartSvg({ lines: svgLines, width: 950, height: 460, yAxis: true })
      .replace('<svg ', '<svg style="background:#ffffff" ')
      .replace('>', '><style>.line{fill:none}.current{stroke:#1560d4;stroke-width:2.5}.prior{stroke:#9aa7bd;stroke-width:1}text{fill:#333}</style><rect width="950" height="460" fill="#ffffff"/>');
    svgPath = path.join(outDir, `${base}.svg`);
    fs.writeFileSync(svgPath, svg);
  }
  return { name, labels, rows: dates.length, csvPath, svgPath, frontConfirmed: front.confirmed };
}

async function main() {
  const query = process.argv[2];
  const years = Number(process.argv[3] || 5);
  const outDir = (process.argv[4] || path.join(os.homedir(), 'Downloads')).replace(/^~/, os.homedir());
  if (!query) { console.error('Usage: node scarr-export.js "<chart name/substring>" [years] [outDir]'); process.exit(1); }

  const client = createClient({ username: USERNAME, endpoints: loadEndpoints() });
  const names = await client.listSavedCharts();
  const exact = names.find((n) => n.toLowerCase() === query.toLowerCase());
  const matches = exact ? [exact] : names.filter((n) => n.toLowerCase().includes(query.toLowerCase()));
  if (!matches.length) { console.error(`No saved chart matches "${query}"`); process.exit(1); }
  if (matches.length > 1) {
    console.error(`"${query}" matches ${matches.length} charts — be more specific:`);
    matches.forEach((n) => console.error('  ', n));
    process.exit(1);
  }
  const r = await exportChart({ client, name: matches[0], years, outDir });
  console.log(`Chart: ${r.name}`);
  console.log(`Years: ${r.labels.join(', ')}`);
  console.log(`Rows:  ${r.rows}`);
  console.log(`CSV:   ${r.csvPath}`);
  console.log(`SVG:   ${r.svgPath}`);
}

if (require.main === module) main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

module.exports = { exportChart, safeName, pickFrontIndex };
