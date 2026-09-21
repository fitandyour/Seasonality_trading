const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { batchInto } = require('../scarr-export-all');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scarr-batch-')); }
function writeCsvs(dir, n, tag) {
  for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, `chart${String(i).padStart(3, '0')}.csv`), tag);
}
function allCsvs(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.csv')) out.push(path.join(d, e.name));
    }
  }(dir));
  return out;
}

test('first run: batches into folders of N, nothing to archive', () => {
  const dir = tmpDir();
  writeCsvs(dir, 45, 'run1');
  const logs = [];
  batchInto(dir, 20, (l) => logs.push(l));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['batch 1', 'batch 2', 'batch 3']);
  assert.equal(fs.readdirSync(path.join(dir, 'batch 3')).length, 5);
  assert.ok(!fs.existsSync(path.join(dir, 'Old')));
});

test('next run: previous batches move to Old/<date>/ and are never deleted', () => {
  const dir = tmpDir();
  writeCsvs(dir, 45, 'run1');
  batchInto(dir, 20, () => {});
  writeCsvs(dir, 25, 'run2');
  batchInto(dir, 20, () => {});

  // new run is in the top-level batch folders
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Old', 'batch 1', 'batch 2']);
  assert.equal(fs.readFileSync(path.join(dir, 'batch 1', 'chart001.csv'), 'utf8'), 'run2');
  // old run is intact under one dated folder
  const dated = fs.readdirSync(path.join(dir, 'Old'));
  assert.equal(dated.length, 1);
  assert.match(dated[0], /^\d{4}-\d{2}-\d{2}$/);
  const archived = allCsvs(path.join(dir, 'Old'));
  assert.equal(archived.length, 45);
  assert.ok(archived.every((f) => fs.readFileSync(f, 'utf8') === 'run1'));
});

test('two archives on the same day do not collide or overwrite', () => {
  const dir = tmpDir();
  writeCsvs(dir, 5, 'run1'); batchInto(dir, 20, () => {});
  writeCsvs(dir, 5, 'run2'); batchInto(dir, 20, () => {});
  writeCsvs(dir, 5, 'run3'); batchInto(dir, 20, () => {});
  const dated = fs.readdirSync(path.join(dir, 'Old')).sort();
  assert.equal(dated.length, 2);
  assert.match(dated[1], /-2$/);
  assert.equal(allCsvs(dir).length, 15); // every file from all three runs still exists
});

test('existing Old contents are left untouched', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'Old', '2026-09-01', 'batch 1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Old', '2026-09-01', 'batch 1', 'keep.csv'), 'keep');
  writeCsvs(dir, 3, 'run1'); batchInto(dir, 20, () => {});
  writeCsvs(dir, 3, 'run2'); batchInto(dir, 20, () => {});
  assert.equal(fs.readFileSync(path.join(dir, 'Old', '2026-09-01', 'batch 1', 'keep.csv'), 'utf8'), 'keep');
});
