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

// ---- Analog-year matching (Henk's requirement: compare year-by-year, no averaging) ----

// Overlapping-path similarity: Pearson correlation of this year's values
// vs a prior year's values, aligned by season index, from the season
// start up to `todayIdx`. Returns null if fewer than 8 shared points.
function pathSimilarity(currentIndexed, priorIndexed, todayIdx) {
  const xs = []; const ys = [];
  for (const [idx, v] of currentIndexed) {
    if (idx > todayIdx) continue;
    if (priorIndexed.has(idx)) { xs.push(v); ys.push(priorIndexed.get(idx)); }
  }
  if (xs.length < 8) return null;
  return pearson(xs, ys);
}

// What a prior year did from today's calendar point to the window close:
// net move plus the best (favorable) and worst (adverse) excursions,
// signed so that positive = up. Returns null if endpoints are missing.
function forwardMove(priorIndexed, todayIdx, windowCloseIdx) {
  const start = valueAt(priorIndexed, todayIdx);
  if (start == null) return null;
  const lo = Math.min(todayIdx, windowCloseIdx);
  const hi = Math.max(todayIdx, windowCloseIdx);
  let end = null; let maxUp = 0; let maxDown = 0;
  for (const [idx, v] of priorIndexed) {
    if (idx < lo || idx > hi) continue;
    const delta = v - start;
    if (delta > maxUp) maxUp = delta;
    if (delta < maxDown) maxDown = delta;
    if (end == null || Math.abs(idx - windowCloseIdx) < Math.abs(end.idx - windowCloseIdx)) {
      end = { idx, v };
    }
  }
  if (end == null) return null;
  return { nextMove: end.v - start, maxFavorable: maxUp, maxAdverse: maxDown, levelThen: start };
}

// Per-year analog features + aggregate agreement / opposite-side risk / score.
function analogMatch({
  current, priors, seasonStartMonth, todayDate, windowCloseIdx,
  similarityThreshold = 0.85, tolerance = 6,
}) {
  const curIdx = toIndexed(current, seasonStartMonth);
  const todayIdx = seasonIndex(monthDayKey(todayDate), seasonStartMonth);
  const levelNow = valueAt(curIdx, todayIdx, tolerance);

  const years = priors.map(({ label, points }) => {
    const pIdx = toIndexed(points, seasonStartMonth);
    const similarity = pathSimilarity(curIdx, pIdx, todayIdx);
    const fwd = forwardMove(pIdx, todayIdx, windowCloseIdx);
    return {
      label,
      similarity,
      nextMove: fwd ? fwd.nextMove : null,
      maxFavorable: fwd ? fwd.maxFavorable : null,
      maxAdverse: fwd ? fwd.maxAdverse : null,
      levelThen: fwd ? fwd.levelThen : null,
      levelGap: (fwd && levelNow != null) ? levelNow - fwd.levelThen : null,
    };
  });
  years.sort((a, b) => (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity));

  // Close analogs: similar path AND a known forward move.
  const analogs = years.filter((y) => y.similarity != null
    && y.similarity >= similarityThreshold && y.nextMove != null);
  const ups = analogs.filter((y) => y.nextMove > 0);
  const downs = analogs.filter((y) => y.nextMove < 0);
  const agreementDirection = ups.length === downs.length ? 0 : (ups.length > downs.length ? 1 : -1);
  const agreementCount = Math.max(ups.length, downs.length);
  const withSide = agreementDirection >= 0 ? ups : downs;
  const against = agreementDirection >= 0 ? downs : ups;

  const meanNextMove = analogs.length
    ? analogs.reduce((s, y) => s + y.nextMove, 0) / analogs.length : 0;
  // Opposite-side risk: mean adverse magnitude among the agreeing years,
  // plus the size of any contrary moves.
  const agreeAdverse = withSide.length
    ? withSide.reduce((s, y) => s + Math.abs(y.maxAdverse || 0), 0) / withSide.length : 0;
  const contraryMove = against.length
    ? against.reduce((s, y) => s + Math.abs(y.nextMove), 0) / against.length : 0;
  const oppositeRisk = agreeAdverse + contraryMove;

  // Ranking score: how many analogs agree, how alike they are, and how big
  // the expected move is, discounted by opposite-side risk. 0..100.
  let score = 0;
  if (analogs.length && agreementDirection !== 0) {
    const agreeFrac = agreementCount / analogs.length;
    const meanSim = withSide.reduce((s, y) => s + y.similarity, 0) / (withSide.length || 1);
    const moveMag = Math.abs(meanNextMove);
    const raw = agreeFrac * meanSim * (moveMag / (moveMag + oppositeRisk + 1e-9));
    score = Math.round(100 * raw);
  }

  return {
    years, levelNow, todayIdx, windowCloseIdx,
    analogCount: analogs.length,
    agreementDirection, agreementCount,
    meanNextMove, oppositeRisk, score,
  };
}

module.exports = {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
  reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch,
  inWindow, DEFAULT_WEIGHTS, computeStrategyMetrics,
  pathSimilarity, forwardMove, analogMatch,
};
