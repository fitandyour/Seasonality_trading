#!/usr/bin/env node
// Export a saved Scarr chart's aligned year-by-year data to CSV (and SVG),
// ready to hand to a Claude coach. Usage:
//   node scarr-export.js "<chart name or substring>" [years] [outDir]
// e.g. node scarr-export.js "FKQ" 5 ~/Downloads

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient, loadEndpoints, rollForwardAt, feasibleAnchors } = require('./scarr');
const { matrixFromPayload } = require('./sync');
const { seasonChartSvg } = require('./chartsvg');

const USERNAME = process.env.SCARR_USERNAME || 'bakkerh';

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
  const name = matches[0];

  const form = await client.fetchChartConfig(name);
  const contracts = await client.fetchContracts(form.sampleContract);
  const anchors = feasibleAnchors(form, contracts);
  const rolled = rollForwardAt(form, contracts, years, anchors[0]); // current + `years` priors
  const payload = await client.fetchChartData(rolled);
  const { dates, cols } = matrixFromPayload(payload);
  const labels = rolled.selected;

  // CSV: Date + one column per contract-year line (current first, then priors).
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
  const safe = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const csvPath = path.join(outDir, `${safe}_last${years}yr.csv`);
  fs.writeFileSync(csvPath, lines.join('\n'));

  // SVG chart: current line highlighted (blue), priors grey — same alignment
  // as the app. White background + inline strokes so it stands alone.
  const toPts = (c) => dates.map((d, i) => (cols[c][i] == null ? null : { x: i, y: cols[c][i] })).filter(Boolean);
  const svgLines = [];
  for (let c = cols.length - 1; c >= 1; c--) svgLines.push({ points: toPts(c), cls: 'prior' });
  svgLines.push({ points: toPts(0), cls: 'current' });
  const inner = seasonChartSvg({ lines: svgLines, width: 950, height: 460, yAxis: true })
    .replace('<svg ', '<svg style="background:#ffffff" ')
    .replace('>', `><style>.line{fill:none}.current{stroke:#1560d4;stroke-width:2.5}.prior{stroke:#9aa7bd;stroke-width:1}text{fill:#333}</style><rect width="950" height="460" fill="#ffffff"/>`);
  const svgPath = path.join(outDir, `${safe}_last${years}yr.svg`);
  fs.writeFileSync(svgPath, inner);

  console.log(`Chart: ${name}`);
  console.log(`Years: ${labels.join(', ')}`);
  console.log(`Rows:  ${dates.length}  (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`CSV:   ${csvPath}`);
  console.log(`SVG:   ${svgPath}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
