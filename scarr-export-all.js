#!/usr/bin/env node
// Bulk-export EVERY saved Scarr chart to CSV (last N years, one file per
// strategy) into a target folder. Intended to run weekly.
//   node scarr-export-all.js [years] [outDir]

const fs = require('fs');
const path = require('path');
const { createClient, loadEndpoints } = require('./scarr');
const { exportChart } = require('./scarr-export');

const USERNAME = process.env.SCARR_USERNAME || 'bakkerh';
const YEARS = Number(process.argv[2] || 10);
const OUT_DIR = process.argv[3] || '/Users/elsub_macmini/Documents/Trading/Trading CSV';
const THROTTLE_MS = 400; // be polite to Scarr between charts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logPath = path.join(OUT_DIR, '_export-log.txt');
  const stamp = new Date().toISOString();
  const log = (line) => { fs.appendFileSync(logPath, line + '\n'); process.stdout.write(line + '\n'); };
  fs.writeFileSync(logPath, `Scarr bulk export — ${stamp}\nLast ${YEARS} years · folder: ${OUT_DIR}\n\n`);

  const client = createClient({ username: USERNAME, endpoints: loadEndpoints() });
  const names = await client.listSavedCharts();
  log(`${names.length} saved charts found.\n`);

  let ok = 0; const failures = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const r = await exportChart({ client, name, years: YEARS, outDir: OUT_DIR, csvOnly: true });
      ok++;
      log(`[${i + 1}/${names.length}] OK   ${name}  (${r.rows} rows, ${r.labels.length} years)`);
    } catch (err) {
      failures.push({ name, error: err.message });
      log(`[${i + 1}/${names.length}] FAIL ${name}  — ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  log(`\nDone: ${ok} exported, ${failures.length} failed.`);
  if (failures.length) {
    log('Failed charts:');
    failures.forEach((f) => log(`  ${f.name} — ${f.error}`));
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
