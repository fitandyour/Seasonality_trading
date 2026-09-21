#!/usr/bin/env node
// Bulk-export EVERY saved Scarr chart to CSV (last N years, one file per
// strategy) into a target folder, in "batch N" folders of 20. Run on request;
// the previous run's batches are archived to Old/<date>/, never deleted.
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

  let ok = 0; const failures = []; const unconfirmed = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const r = await exportChart({ client, name, years: YEARS, outDir: OUT_DIR, csvOnly: true });
      ok++;
      if (!r.frontConfirmed) unconfirmed.push(name);
      log(`[${i + 1}/${names.length}] ${r.frontConfirmed ? 'OK  ' : 'WARN'} ${name}  (${r.rows} rows, ${r.labels.length} years, front ${r.labels[0]}${r.frontConfirmed ? '' : ' NOT CONFIRMED LIVE'})`);
    } catch (err) {
      failures.push({ name, error: err.message });
      log(`[${i + 1}/${names.length}] FAIL ${name}  — ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  log(`\nDone: ${ok} exported, ${failures.length} failed.`);
  if (unconfirmed.length) {
    log(`\n${unconfirmed.length} charts where the front year could not be confirmed as still trading (check these):`);
    unconfirmed.forEach((n) => log(`  ${n}`));
  }
  if (failures.length) {
    log('Failed charts:');
    failures.forEach((f) => log(`  ${f.name} — ${f.error}`));
  }

  // Archive last run's batches, then batch into folders of 20 (Claude chat
  // uploads max 20 files at a time).
  batchInto(OUT_DIR, BATCH_SIZE, log);
}

const BATCH_SIZE = 20;

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Move the previous run's "batch N" folders into Old/<date of that run>/ so
// nothing is ever deleted and a new "batch 1" cannot collide with an old one.
// Returns the archive folder, or null when there was nothing to archive.
function archiveBatches(dir) {
  const old = fs.readdirSync(dir)
    .filter((e) => /^batch \d+$/.test(e) && fs.statSync(path.join(dir, e)).isDirectory());
  if (!old.length) return null;
  const newest = Math.max(...old.map((e) => fs.statSync(path.join(dir, e)).mtimeMs));
  const base = localDate(new Date(newest));
  let dest = path.join(dir, 'Old', base);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, 'Old', `${base}-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const e of old) fs.renameSync(path.join(dir, e), path.join(dest, e));
  return dest;
}

function batchInto(dir, size, log) {
  const archived = archiveBatches(dir);
  if (archived) log(`Archived previous batches to ${archived}`);
  const csvs = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .sort((a, b) => a.localeCompare(b));
  let batch = 0;
  csvs.forEach((f, i) => {
    if (i % size === 0) { batch += 1; fs.mkdirSync(path.join(dir, `batch ${batch}`), { recursive: true }); }
    fs.renameSync(path.join(dir, f), path.join(dir, `batch ${batch}`, f));
  });
  log(`Batched ${csvs.length} files into ${batch} folders of up to ${size}.`);
}

if (require.main === module) main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

module.exports = { archiveBatches, batchInto };
