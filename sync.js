const { rollForwardAt, feasibleAnchors } = require('./scarr');
const { configFromForm, MONTH_NUM } = require('./scarrparse');
const { alignedAnalog, identifyTrade, lastDataRow } = require('./scoring');
const { evaluateCycle, fallbackSetup } = require('./analysis');

const DEFAULT_ANALOG_YEARS = 5;

// Spend a Claude call only where there is something to judge: a mechanical
// candidate, or at least 2 usable analog years agreeing on a direction.
// Empty / split cycles get a deterministic no-setup — this is what keeps a
// full sync cheap.
function worthEvaluating(line) {
  if (!line || !line.analog) return false;
  if (line.trade) return true;
  const a = line.analog;
  return a.agreementDirection !== 0 && a.agreementCount >= 2;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// The row nearest the next occurrence of the window-close calendar date at or
// after today. Falls back to the last row when the window has already passed.
function closeRowOf(dates, window, todayRow) {
  const [ty, tm, td] = dates[todayRow].split('-').map(Number);
  const cm = MONTH_NUM[window.closeMonth]; const cd = window.closeDate;
  const year = (cm < tm || (cm === tm && cd < td)) ? ty + 1 : ty;
  const target = `${year}-${pad2(cm)}-${pad2(cd)}`;
  for (let i = todayRow + 1; i < dates.length; i++) if (dates[i] >= target) return i;
  return dates.length - 1;
}

// Scarr's columnar payload → shared date axis + one value column per year.
function matrixFromPayload(payload) {
  const dates = payload.values.map((r) => {
    const s = String(r[0]);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  });
  const nCols = payload.values[0].length - 1;
  const cols = [];
  for (let c = 0; c < nCols; c++) {
    cols.push(payload.values.map((r) => (typeof r[c + 1] === 'number' ? r[c + 1] : null)));
  }
  return { dates, cols };
}

function daysBetweenStr(a, b) { return Math.abs(Math.round((new Date(b) - new Date(a)) / 86400000)); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Analyse one line (the subject) against the `analogYears` lines that follow
// it on the SAME shared axis. Scarr maps every contract year onto the current
// season's axis by seasonal offset, so a next-year spread simply has its data
// ending earlier on the axis — that point is its own "today". realDayShift
// translates axis dates to real calendar dates for display (≈ one season
// forward for the next cycle).
function analyseLine({ dates, cols, labels, startCol, analogYears, window, realDayShift = 0 }) {
  const subCols = cols.slice(startCol, startCol + 1 + analogYears);
  const subLabels = labels.slice(startCol, startCol + 1 + analogYears);
  const todayRow = lastDataRow(subCols[0]);
  if (todayRow < 5 || subCols.length < 3) return null;
  const closeRow = closeRowOf(dates, window, todayRow);
  const analog = alignedAnalog({ cols: subCols, labels: subLabels, todayRow, closeRow });
  const trade = identifyTrade(analog, { dates, todayRow });
  if (trade && trade.exitDate && realDayShift) trade.exitDate = addDays(trade.exitDate, realDayShift);
  return { analog, trade: trade || null, labels: subLabels, front: subLabels[0] };
}

function labelYear(label) {
  const m = String(label).match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

function splitCurrentAndPrior(labels, yearsBack) {
  const sorted = [...labels].sort((a, b) => labelYear(b) - labelYear(a));
  return { current: sorted[0], prior: sorted.slice(1, 1 + yearsBack) };
}

async function getSetting(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]);
}

async function upsertPoints(db, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const placeholders = []; const params = [];
    chunk.forEach((r, j) => {
      const b = j * 4;
      placeholders.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(...r);
    });
    await db.query(
      `INSERT INTO series_points (strategy_id, line_label, trade_date, value)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (strategy_id, line_label, trade_date) DO UPDATE SET value = EXCLUDED.value`,
      params);
  }
}

async function syncOneStrategy({ db, client, strategy, todayDate, analogYears }) {
  // Prefer the live stored config from Scarr; fall back to the config
  // captured at import time (pasted URL).
  let form = strategy.config.form;
  try {
    form = await client.fetchChartConfig(strategy.save_name);
  } catch (err) {
    if (!form) throw err;
  }
  if (!form) throw new Error('no config available');

  const cfg = configFromForm(form);
  const contracts = await client.fetchContracts(form.sampleContract);
  const anchors = feasibleAnchors(form, contracts);
  if (!anchors.length) throw new Error(`no feasible contracts for "${strategy.save_name}"`);

  // ONE fetch at the newest anchor, with 2 extra rows so both the possible
  // next-year line and the live line keep a full set of analogs beneath them.
  // Scarr maps every year onto one shared season axis, so cycles are
  // distinguished by where each line's data ENDS, not by separate requests.
  const rolled = rollForwardAt(form, contracts, analogYears + 1, anchors[0]);
  const payload = await client.fetchChartData(rolled);
  const { dates, cols } = matrixFromPayload(payload);
  if (cols.length < 3) throw new Error('chart returned fewer than 3 year lines');
  const labels = rolled.selected;

  // Wipe and rewrite the series (labels are per-year, no clash).
  await db.query('DELETE FROM series_points WHERE strategy_id = $1', [strategy.id]);
  const rows = [];
  cols.forEach((col, j) => {
    col.forEach((v, i) => {
      if (v != null) rows.push([strategy.id, labels[j], dates[i], v]);
    });
  });
  await upsertPoints(db, rows);

  // Classify by data recency against today. If line 0 ends near today, Scarr
  // has already rolled the axis to the newest season → line 0 IS the current
  // tradeable cycle (line 1 is just the completed prior year). If instead
  // line 0 ends ~a season back (mapped forward-year spread) while line 1 ends
  // near today, line 1 is the live current spread and line 0 the NEXT cycle.
  const end0 = lastDataRow(cols[0]);
  const end1 = lastDataRow(cols[1]);
  const d0 = end0 >= 0 ? daysBetweenStr(dates[end0], todayDate) : Infinity;
  const d1 = end1 >= 0 ? daysBetweenStr(dates[end1], todayDate) : Infinity;
  const line0IsNext = d0 > 200 && d1 <= 45;

  const plans = [];
  if (line0IsNext) {
    plans.push({ label: 'current', startCol: 1, realDayShift: 0 });
    plans.push({
      label: 'next', startCol: 0,
      realDayShift: Math.max(0, daysBetweenStr(dates[end0], todayDate)),
    });
  } else {
    plans.push({ label: 'current', startCol: 0, realDayShift: 0 });
  }

  // Hybrid judgment: Claude (or the mechanical fallback) evaluates EVERY
  // analysable cycle — not only the ones that passed the mechanical filter.
  const cycles = [];
  for (const p of plans) {
    const line = analyseLine({
      dates, cols, labels, startCol: p.startCol, analogYears,
      window: cfg.window, realDayShift: p.realDayShift,
    });
    if (!line) {
      cycles.push({
        label: p.label, front: labels[p.startCol], labels: labels.slice(p.startCol),
        analog: { years: [], analogCount: 0, agreementDirection: 0, agreementCount: 0, score: 0, entry: null },
        trade: null, verdict: null,
      });
      continue;
    }
    const verdict = worthEvaluating(line)
      ? await evaluateCycle({
        strategy,
        cycle: { label: p.label, front: line.front, analog: line.analog, trade: line.trade },
        todayDate,
      })
      : fallbackSetup(line.analog, line.trade); // deterministic, no API cost
    cycles.push({
      label: p.label, front: line.front, labels: line.labels,
      analog: line.analog, trade: line.trade, verdict,
    });
  }

  const opportunities = cycles.filter((c) => c.verdict && c.verdict.opportunity);
  const best = opportunities[0] || cycles.reduce((a, b) => ((b.analog.score || 0) > (a.analog.score || 0) ? b : a), cycles[0]);
  const flagged = opportunities.length > 0;

  await db.query(
    `INSERT INTO daily_scores (strategy_id, score_date, direction, setup_score,
                               in_window, flagged, analog, verdict, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (strategy_id, score_date) DO UPDATE SET
       direction=EXCLUDED.direction, setup_score=EXCLUDED.setup_score,
       in_window=EXCLUDED.in_window, flagged=EXCLUDED.flagged,
       analog=EXCLUDED.analog, verdict=EXCLUDED.verdict, details=EXCLUDED.details`,
    [strategy.id, todayDate, best.analog.agreementDirection || 0,
      Math.max(...cycles.map((c) => c.analog.score || 0)), flagged, flagged,
      JSON.stringify({ cycles }), best.verdict ? JSON.stringify(best.verdict) : null,
      JSON.stringify({ todayDate, anchor: anchors[0] })]);
  return {
    points: rows.length,
    setupScore: Math.max(...cycles.map((c) => c.analog.score || 0)),
    flagged,
    trade: opportunities.length,
  };
}

async function runSync({ db, client, todayDate }) {
  const { rows: [run] } = await db.query(
    `INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`);
  const results = [];
  let status = 'ok';
  try {
    const { rows: strategies } = await db.query(
      'SELECT id, save_name, years_back, config FROM strategies WHERE active = true ORDER BY save_name');
    const analogYears = await getSetting(db, 'analog_years', DEFAULT_ANALOG_YEARS);
    for (const strategy of strategies) {
      try {
        const r = await syncOneStrategy({ db, client, strategy, todayDate, analogYears });
        results.push({ saveName: strategy.save_name, ok: true, ...r });
      } catch (err) {
        status = 'partial';
        results.push({ saveName: strategy.save_name, ok: false, error: err.message });
      }
    }
  } catch (err) {
    status = 'failed';
    results.push({ saveName: '(sync)', ok: false, error: err.message });
  }
  await db.query(
    `UPDATE sync_runs SET status = $1, finished_at = now(), detail = $2 WHERE id = $3`,
    [status, JSON.stringify(results), run.id]);
  return { syncRunId: run.id, results };
}

// Pull the full saved-charts list from Scarr and upsert every strategy.
async function importAllFromScarr({ db, client }) {
  const names = await client.listSavedCharts();
  const results = [];
  for (const name of names) {
    try {
      const form = await client.fetchChartConfig(name);
      const config = configFromForm(form);
      await db.query(
        `INSERT INTO strategies (save_name, source_url, config, years_back)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT (save_name) DO UPDATE
           SET config = EXCLUDED.config, years_back = EXCLUDED.years_back, updated_at = now()`,
        [name, JSON.stringify(config), config.yearsBack]);
      results.push({ saveName: name, ok: true });
    } catch (err) {
      results.push({ saveName: name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  runSync, importAllFromScarr, splitCurrentAndPrior, labelYear,
  upsertPoints, getSetting, setSetting, analyseLine, matrixFromPayload,
};
