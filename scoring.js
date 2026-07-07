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

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function reliabilityAndDirection(moves) {
  const m = moves.filter((x) => x != null);
  if (m.length === 0) return { direction: 0, reliability: 0.5, nYears: 0 };
  const direction = Math.sign(mean(m)) || 1;
  return {
    direction,
    reliability: m.filter((x) => Math.sign(x) === direction).length / m.length,
    nYears: m.length,
  };
}

function strengthScore(moves) {
  const m = moves.filter((x) => x != null);
  if (m.length < 3) return 0.5;
  const t = Math.abs(mean(m)) / (stdev(m) + 1e-9);
  return t / (1 + t);
}

function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

function trackingCorrelation(currentIndexed, avgPath) {
  const xs = []; const ys = [];
  for (const [idx, v] of currentIndexed) {
    if (avgPath.has(idx)) { xs.push(v); ys.push(avgPath.get(idx)); }
  }
  if (xs.length < 10) return null;
  return pearson(xs, ys);
}

function entryStretch(currentIndexed, priorIndexedArray, todayIdx, direction) {
  const cur = valueAt(currentIndexed, todayIdx);
  if (cur == null) return { percentile: null, stretchScore: 0.5 };
  const vals = priorIndexedArray.map((m) => valueAt(m, todayIdx)).filter((v) => v != null);
  if (vals.length < 2) return { percentile: null, stretchScore: 0.5 };
  const percentile = vals.filter((v) => v < cur).length / vals.length;
  return { percentile, stretchScore: direction > 0 ? 1 - percentile : percentile };
}

function inWindow(todayIdx, openIdx, closeIdx, leadDays = 21) {
  const start = openIdx - leadDays;
  if (closeIdx >= start) return todayIdx >= start && todayIdx <= closeIdx;
  return todayIdx >= start || todayIdx <= closeIdx; // window wraps the season boundary
}

const DEFAULT_WEIGHTS = { reliability: 0.25, strength: 0.25, tracking: 0.25, stretch: 0.25 };

function computeStrategyMetrics({ currentYear, priorYears, window, seasonStartMonth, todayDate, weights = DEFAULT_WEIGHTS }) {
  const curIdx = toIndexed(currentYear, seasonStartMonth);
  const priors = priorYears.map((s) => toIndexed(s, seasonStartMonth));
  const { openIdx, closeIdx } = windowIndices(window, seasonStartMonth);
  const moves = priors.map((m) => {
    const a = valueAt(m, openIdx); const b = valueAt(m, closeIdx);
    return (a == null || b == null) ? null : b - a;
  });
  const { direction, reliability, nYears } = reliabilityAndDirection(moves);
  const strength = strengthScore(moves);
  const tracking = trackingCorrelation(curIdx, seasonalAveragePath(priors));
  const todayIdx = seasonIndex(monthDayKey(todayDate), seasonStartMonth);
  const { percentile, stretchScore } = entryStretch(curIdx, priors, todayIdx, direction);
  const trackingScore = tracking == null ? 0.5 : (tracking + 1) / 2;
  const setupScore = Math.round(100 * (
    weights.reliability * reliability
    + weights.strength * strength
    + weights.tracking * trackingScore
    + weights.stretch * stretchScore
  ));
  return {
    direction, nYears, reliability, strength, tracking, trackingScore,
    percentile, stretchScore, setupScore,
    inWindow: inWindow(todayIdx, openIdx, closeIdx),
    todayIdx, openIdx, closeIdx,
  };
}

module.exports = {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
  reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch,
  inWindow, DEFAULT_WEIGHTS, computeStrategyMetrics,
};
