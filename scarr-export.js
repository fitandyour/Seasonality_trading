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

// Fetch + write one chart. Returns { name, labels, rows, csvPath, svgPath }.
async function exportChart({ client, name, years = 10, outDir, csvOnly = false }) {
  const form = await client.fetchChartConfig(name);
  const contracts = await client.fetchContracts(form.sampleContract);
  const anchors = feasibleAnchors(form, contracts);
  if (!anchors.length) throw new Error('no feasible contracts');
  const rolled = rollForwardAt(form, contracts, years, anchors[0]); // current + `years` priors
  const payload = await client.fetchChartData(rolled);
  const { dates, cols } = matrixFromPayload(payload);
  const labels = rolled.selected;

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
  return { name, labels, rows: dates.length, csvPath, svgPath };
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

module.exports = { exportChart, safeName };
