#!/usr/bin/env node
// Re-export a specific punch-list of strategies (fixed live-front logic) into
// NEW batch folders (continuing after the existing batch N folders).
//   node reexport-list.js <listFile> <outDir> [years]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient, loadEndpoints } = require('./scarr');
const { exportChart } = require('./scarr-export');

const USERNAME = process.env.SCARR_USERNAME || 'bakkerh';
const LIST = process.argv[2];
const OUT_DIR = process.argv[3];
const YEARS = Number(process.argv[4] || 10);
const BATCH_SIZE = 20;
const THROTTLE_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Alphanumeric-only comparison key so different sanitizations still match.
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function main() {
  const raw = fs.readFileSync(LIST.replace(/^~/, os.homedir()), 'utf8');
  // Grab indented filename lines ending in .csv; strip .csv and any _lastNyr.
  const wanted = raw.split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.csv$/i.test(l))
    .map((l) => l.replace(/\.csv$/i, '').replace(/_last\d+yr$/i, ''));

  const client = createClient({ username: USERNAME, endpoints: loadEndpoints() });
  const names = await client.listSavedCharts();
  const byKey = new Map();
  for (const n of names) byKey.set(key(n), n);

  const resolved = []; const unmatched = [];
  for (const w of wanted) {
    const n = byKey.get(key(w));
    if (n) resolved.push(n); else unmatched.push(w);
  }
  // de-dupe, preserve order
  const uniq = [...new Set(resolved)];
  console.log(`Punch list: ${wanted.length} entries → ${uniq.length} matched, ${unmatched.length} unmatched.`);
  if (unmatched.length) { console.log('Unmatched:'); unmatched.forEach((u) => console.log('  ', u)); }

  // Export into a temp dir first.
  const tmp = path.join(os.tmpdir(), 'scarr-reexport');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const done = []; const failed = [];
  for (let i = 0; i < uniq.length; i++) {
    const n = uniq[i];
    try {
      const r = await exportChart({ client, name: n, years: YEARS, outDir: tmp, csvOnly: true });
      done.push(path.basename(r.csvPath));
      console.log(`[${i + 1}/${uniq.length}] OK   ${n}`);
    } catch (e) { failed.push({ n, e: e.message }); console.log(`[${i + 1}/${uniq.length}] FAIL ${n} — ${e.message}`); }
    await sleep(THROTTLE_MS);
  }

  // Determine next batch number after existing "batch N" folders in OUT_DIR.
  let maxBatch = 0;
  for (const entry of fs.readdirSync(OUT_DIR)) {
    const m = entry.match(/^batch (\d+)$/);
    if (m) maxBatch = Math.max(maxBatch, Number(m[1]));
  }
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.csv')).sort((a, b) => a.localeCompare(b));
  let batch = maxBatch;
  files.forEach((f, idx) => {
    if (idx % BATCH_SIZE === 0) { batch += 1; fs.mkdirSync(path.join(OUT_DIR, `batch ${batch}`), { recursive: true }); }
    fs.renameSync(path.join(tmp, f), path.join(OUT_DIR, `batch ${batch}`, f));
  });

  console.log(`\nDone: ${done.length} re-exported, ${failed.length} failed.`);
  console.log(`New batches: ${maxBatch + 1}..${batch} (${files.length} files).`);
  if (failed.length) { console.log('Failed:'); failed.forEach((f) => console.log(`  ${f.n} — ${f.e}`)); }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
