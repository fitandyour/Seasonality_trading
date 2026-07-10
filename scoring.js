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

// ---- Aligned analog matching ----
// Scarr already maps every contract-year onto ONE shared date axis (each
// `values` row is [date, thisYear, lastYear, ...]). So we compare column-to-
// column at the same row — no season-index reprojection, which was what
// mangled long-dated (multi-year) spreads. cols[0] = current/front year,
// cols[1..] = priors; every col is the same length, null where no data.

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

// Last row where the current/front year still has data — i.e. "today".
function lastDataRow(col) {
  for (let i = col.length - 1; i >= 0; i--) if (col[i] != null) return i;
  return -1;
}

// Real spread paths rarely correlate above ~0.8 year-to-year; 0.5 marks a
// usable analog (direction of the read is decided by agreement, not one year).
function alignedAnalog({ cols, labels, todayRow, closeRow, similarityThreshold = 0.5 }) {
  const current = cols[0];
  const entry = current[todayRow] != null ? current[todayRow] : null;
  const years = [];
  for (let j = 1; j < cols.length; j++) {
    const prior = cols[j];
    const xs = []; const ys = [];
    for (let i = 0; i <= todayRow; i++) {
      if (current[i] != null && prior[i] != null) { xs.push(current[i]); ys.push(prior[i]); }
    }
    const similarity = xs.length >= 8 ? pearson(xs, ys) : null;
    const start = prior[todayRow] != null ? prior[todayRow] : null;
    let nextMove = null; let maxFav = 0; let maxAdv = 0; let favOffset = 0; let advOffset = 0;
    if (start != null) {
      let end = null;
      for (let i = todayRow; i <= closeRow; i++) {
        if (prior[i] == null) continue;
        const d = prior[i] - start;
        if (d > maxFav) { maxFav = d; favOffset = i - todayRow; }
        if (d < maxAdv) { maxAdv = d; advOffset = i - todayRow; }
        end = prior[i];
      }
      nextMove = end != null ? end - start : null;
    }
    years.push({
      label: labels[j], similarity, nextMove,
      maxFavorable: maxFav, maxAdverse: maxAdv, favOffset, advOffset,
      levelThen: start, levelGap: (entry != null && start != null) ? entry - start : null,
    });
  }
  years.sort((a, b) => (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity));

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
  const agreeAdverse = withSide.length
    ? withSide.reduce((s, y) => s + Math.abs(agreementDirection > 0 ? y.maxAdverse : y.maxFavorable), 0) / withSide.length
    : 0;
  const contraryMove = against.length
    ? against.reduce((s, y) => s + Math.abs(y.nextMove), 0) / against.length : 0;
  const oppositeRisk = agreeAdverse + contraryMove;

  let score = 0;
  if (analogs.length && agreementDirection !== 0) {
    const agreeFrac = agreementCount / analogs.length;
    const meanSim = withSide.reduce((s, y) => s + y.similarity, 0) / (withSide.length || 1);
    const moveMag = Math.abs(meanNextMove);
    score = Math.round(100 * agreeFrac * meanSim * (moveMag / (moveMag + oppositeRisk + 1e-9)));
  }

  return {
    entry: round2(entry), years,
    analogCount: analogs.length, agreementDirection, agreementCount,
    meanNextMove, oppositeRisk, score,
  };
}

// Turn an analog result into a concrete trade, or null if none is worth
// flagging. Entry = this year's current level; target/timing from the agreeing
// analogs' profit extreme; stop from their worst adverse excursion.
function identifyTrade(analog, { dates, todayRow, minAnalogs = 3, minScore = 35, buffer = 1.1 } = {}) {
  const dir = analog.agreementDirection;
  if (dir === 0 || analog.entry == null) return null;
  if (analog.agreementCount < minAnalogs || analog.score < minScore) return null;
  const agree = analog.years.filter((y) => y.similarity != null && y.nextMove != null
    && Math.sign(y.nextMove) === dir);
  if (!agree.length) return null;

  const entry = analog.entry;
  const profitMoves = agree.map((y) => (dir > 0 ? y.maxFavorable : y.maxAdverse));
  const adverseMoves = agree.map((y) => (dir > 0 ? y.maxAdverse : y.maxFavorable));
  const peakOffsets = agree.map((y) => (dir > 0 ? y.favOffset : y.advOffset));

  const target = entry + median(profitMoves);
  const worstAdverse = dir > 0 ? Math.min(...adverseMoves) : Math.max(...adverseMoves);
  const stop = entry + worstAdverse * buffer;
  const exitOffset = Math.round(median(peakOffsets));
  const exitRow = todayRow != null ? todayRow + exitOffset : null;
  const exitDate = (dates && exitRow != null && dates[exitRow]) ? dates[exitRow] : null;

  const reward = Math.abs(target - entry);
  const risk = Math.abs(entry - stop) || 1e-9;
  return {
    side: dir > 0 ? 'long' : 'short',
    entry: round2(entry), target: round2(target), stop: round2(stop),
    exitDate, exitOffset, rr: Math.round((reward / risk) * 10) / 10,
    agreeCount: agree.length,
  };
}

module.exports = {
  monthDayKey, seasonIndex, toIndexed, valueAt, windowIndices, seasonalAveragePath,
  reliabilityAndDirection, strengthScore, trackingCorrelation, entryStretch,
  inWindow, DEFAULT_WEIGHTS, computeStrategyMetrics,
  median, round2, lastDataRow, alignedAnalog, identifyTrade,
};
