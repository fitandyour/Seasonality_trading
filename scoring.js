const { MONTH_NUM } = require('./scarrparse');

function monthDayKey(dateStr) { return dateStr.slice(5, 10); }

function seasonIndex(mdKey, seasonStartMonth) {
  const m = Number(mdKey.slice(0, 2));
  const d = Number(mdKey.slice(3, 5));
  return ((m - seasonStartMonth + 12) % 12) * 31 + (d - 1);
}

function toIndexed(series, seasonStartMonth) {
  const map = new Map();
  for (const p of series) map.set(seasonIndex(monthDayKey(p.date), seasonStartMonth), p.value);
  return map;
}

function valueAt(indexed, idx, tolerance = 6) {
  if (indexed.has(idx)) return indexed.get(idx);
  for (let off = 1; off <= tolerance; off++) {
    if (indexed.has(idx - off)) return indexed.get(idx - off);
    if (indexed.has(idx + off)) return indexed.get(idx + off);
  }
  return null;
}

function mdFrom(monthName, day) {
  return String(MONTH_NUM[monthName]).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function windowIndices(window, seasonStartMonth) {
  return {
    openIdx: seasonIndex(mdFrom(window.openMonth, window.openDate), seasonStartMonth),
    closeIdx: seasonIndex(mdFrom(window.closeMonth, window.closeDate), seasonStartMonth),
  };
}

function seasonalAveragePath(priorIndexedArray) {
  const acc = new Map();
  for (const map of priorIndexedArray) {
    for (const [idx, v] of map) {
      const e = acc.get(idx) || { sum: 0, n: 0 };
      e.sum += v; e.n += 1;
      acc.set(idx, e);
    }
  }
  const need = Math.ceil(priorIndexedArray.length / 2);
  const out = new Map();
  for (const [idx, e] of acc) if (e.n >= need) out.set(idx, e.sum / e.n);
  return out;
}

module.exports = {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
};
