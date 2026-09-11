// Period trading reports (monthly and year-to-date). Metrics follow the
// standard journal framework (expectancy, profit factor, win rate + payoff,
// max drawdown, per-setup breakdown — Edgewonk/JournalPlus style): the
// per-bucket expectancy is what reveals which setups carry the account and
// which drain it. The YTD view adds the month-by-month picture (consistency,
// best/worst month, equity curve) that a single month cannot show.
//
// Everything here is computed live from matched fills — nothing is stored.

const COACH_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';

function r2(n) { return Math.round(n * 100) / 100; }
const pnlOf = (t) => t.pnl ?? 0;

function bucketStats(trades) {
  const wins = trades.filter((t) => pnlOf(t) > 0);
  const losses = trades.filter((t) => pnlOf(t) < 0);
  const netPnl = r2(trades.reduce((s, t) => s + pnlOf(t), 0));
  const grossWin = r2(wins.reduce((s, t) => s + t.pnl, 0));
  const grossLoss = r2(Math.abs(losses.reduce((s, t) => s + t.pnl, 0)));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    netPnl,
    netPoints: r2(trades.reduce((s, t) => s + (t.points ?? 0), 0)),
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
    expectancy: trades.length ? r2(netPnl / trades.length) : null,
    avgHoldDays: trades.length ? r2(trades.reduce((s, t) => s + (t.holdDays || 0), 0) / trades.length) : null,
  };
}

function breakdown(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...bucketStats(list) }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

// Longest run of consecutive wins / losses (in exit order) and the run the
// period ends on. Streaks are the classic tilt / overconfidence tell.
function streaks(trades) {
  let maxWin = 0; let maxLoss = 0; let run = 0; let runType = null;
  for (const t of trades) {
    const type = pnlOf(t) > 0 ? 'win' : (pnlOf(t) < 0 ? 'loss' : null);
    if (!type) continue;
    if (type === runType) run += 1; else { runType = type; run = 1; }
    if (type === 'win') maxWin = Math.max(maxWin, run); else maxLoss = Math.max(maxLoss, run);
  }
  return { maxWinStreak: maxWin, maxLossStreak: maxLoss, currentStreak: runType ? { type: runType, n: run } : null };
}

// Cumulative realized P&L curve in exit order, plus max drawdown of it.
function equityCurve(trades) {
  let cum = 0; let peak = 0; let maxDrawdown = 0;
  const equity = trades.map((t) => {
    cum = r2(cum + pnlOf(t));
    if (cum > peak) peak = cum;
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum;
    return { date: t.exitDate, cum };
  });
  return { equity, maxDrawdown: r2(maxDrawdown) };
}

// Month-by-month table for a year: every month from January through
// `throughMonth` (empty months included, so gaps in activity are visible).
function monthTable(trades, year, throughMonth) {
  const rows = [];
  let cum = 0;
  for (let m = 1; m <= throughMonth; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const list = trades.filter((t) => t.exitDate.startsWith(key));
    const stats = bucketStats(list);
    cum = r2(cum + stats.netPnl);
    rows.push({ key, ...stats, cumPnl: cum });
  }
  return rows;
}

// period: 'YYYY-MM' (month) or 'YYYY' (year to date). `today` only matters
// for the YTD month table (how far the year has run).
function computePeriodReport({ closed, open, period, today }) {
  const kind = /^\d{4}$/.test(period) ? 'year' : 'month';
  const trades = closed
    .filter((t) => t.exitDate && t.exitDate.startsWith(period))
    .slice()
    .sort((a, b) => (a.exitDate < b.exitDate ? -1 : a.exitDate > b.exitDate ? 1 : 0));
  const wins = trades.filter((t) => pnlOf(t) > 0);
  const losses = trades.filter((t) => pnlOf(t) < 0);
  const core = bucketStats(trades);
  const avgWin = wins.length ? r2(core.grossWin / wins.length) : null;
  const avgLoss = losses.length ? r2(-core.grossLoss / losses.length) : null;
  const { equity, maxDrawdown } = equityCurve(trades);
  const largestWin = wins.length ? Math.max(...wins.map((t) => t.pnl)) : null;
  const largestLoss = losses.length ? Math.min(...losses.map((t) => t.pnl)) : null;
  const bySymbol = breakdown(trades, (t) => t.symbol);
  const avgHold = (list) => (list.length ? r2(list.reduce((s, t) => s + (t.holdDays || 0), 0) / list.length) : null);

  // Concentration: how much of the gross profit came from the single best
  // trade and from the single best market. High numbers mean the result
  // hinges on one outlier rather than a repeatable edge.
  const topMarket = bySymbol.find((b) => b.grossWin > 0) || null;
  const topMarketShare = (topMarket && core.grossWin > 0)
    ? r2((topMarket.grossWin / core.grossWin) * 100) : null;

  const report = {
    period,
    kind,
    month: period, // backwards compatibility with the monthly view/tests
    ...core,
    avgWin,
    avgLoss,
    payoff: (avgWin != null && avgLoss != null && avgLoss !== 0) ? r2(avgWin / Math.abs(avgLoss)) : null,
    largestWin,
    largestLoss,
    maxDrawdown,
    // Net profit per unit of drawdown suffered to earn it (>2 comfortable).
    recoveryFactor: maxDrawdown > 0 ? r2(core.netPnl / maxDrawdown) : null,
    // Hold-time split: holding losers longer than winners is the classic leak.
    avgHoldWinners: avgHold(wins),
    avgHoldLosers: avgHold(losses),
    // How many average wins one worst loss wipes out.
    largestLossInAvgWins: (largestLoss != null && avgWin) ? r2(Math.abs(largestLoss) / avgWin) : null,
    topTradeShare: (largestWin != null && core.grossWin > 0) ? r2((largestWin / core.grossWin) * 100) : null,
    topMarket: topMarket ? { key: topMarket.key, share: topMarketShare } : null,
    ...streaks(trades),
    equity,
    bySymbol,
    byType: breakdown(trades, (t) => t.type || 'Other'),
    bySide: breakdown(trades, (t) => t.side),
    closedTrades: trades,
    openAtEnd: open,
    openExposure: open.reduce((s, p) => s + (Number(p.qty) || 0), 0),
  };

  if (kind === 'year') {
    const now = (today || new Date().toISOString().slice(0, 10));
    const lastTradeMonth = trades.length ? Number(trades[trades.length - 1].exitDate.slice(5, 7)) : 1;
    const throughMonth = now.startsWith(period) ? Number(now.slice(5, 7))
      : (now < period ? lastTradeMonth : 12);
    const byMonth = monthTable(trades, period, throughMonth);
    const active = byMonth.filter((m) => m.trades > 0);
    const profitable = active.filter((m) => m.netPnl > 0);
    report.byMonth = byMonth;
    report.monthsActive = active.length;
    report.profitableMonths = profitable.length;
    report.profitableMonthRate = active.length ? r2((profitable.length / active.length) * 100) : null;
    report.bestMonth = active.length ? active.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null;
    report.worstMonth = active.length ? active.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null;
    report.avgMonthlyPnl = active.length ? r2(core.netPnl / active.length) : null;
    report.tradesPerMonth = active.length ? r2(trades.length / active.length) : null;
  }
  return report;
}

// Kept for callers/tests that think in months.
function computeMonthlyReport({ closed, open, month }) {
  return computePeriodReport({ closed, open, period: month });
}

const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'strengths', 'weaknesses', 'actions'],
};

const COACH_SYSTEM = `You are a trading performance coach for a commodity futures spread trader. You get one period's computed statistics (a month, or the year to date) from his trade journal. Write a frank, useful review.

Rules:
- Cite only the numbers provided; never invent trades or values.
- Focus on the per-setup breakdowns: which markets/structures/sides carried the period and which drained it (that is where the actionable insight lives).
- Judge quality by expectancy and profit factor, not by win rate alone; note if a good win rate hides a bad payoff ratio or vice versa.
- Comment on drawdown relative to net P&L (recovery factor), hold-time patterns (winners vs losers), streaks, and concentration risk (one trade or one market producing most of the profit).
- For a year-to-date review, judge consistency month by month: is the edge repeatable or did one month make the year?
- "actions" must be concrete and checkable in the next period (e.g. "halve size on HE shorts until expectancy is positive"), 2-4 items.
- This is analysis of past performance, not investment advice.`;

function reportPromptUser(report) {
  const line = (b) => `  ${b.key}: ${b.trades} trades, net ${b.netPnl}, win rate ${b.winRate}%, expectancy ${b.expectancy}/trade, avg hold ${b.avgHoldDays}d`;
  const label = report.kind === 'year' ? `Year to date: ${report.period}` : `Month: ${report.period}`;
  const monthBlock = report.kind === 'year' ? `
By month (cumulative P&L in brackets):
${report.byMonth.filter((m) => m.trades > 0).map((m) => `  ${m.key}: ${m.trades} trades, net ${m.netPnl} [${m.cumPnl}], win rate ${m.winRate}%`).join('\n')}
Profitable months: ${report.profitableMonths}/${report.monthsActive}. Best ${report.bestMonth?.key} (${report.bestMonth?.netPnl}), worst ${report.worstMonth?.key} (${report.worstMonth?.netPnl}). Avg monthly P&L ${report.avgMonthlyPnl}.
` : '';
  return `${label}
Closed trades: ${report.trades} (${report.wins}W / ${report.losses}L, win rate ${report.winRate}%)
Net P&L: ${report.netPnl} (gross +${report.grossWin} / -${report.grossLoss}), profit factor ${report.profitFactor}
Expectancy per trade: ${report.expectancy}. Avg win ${report.avgWin} vs avg loss ${report.avgLoss} (payoff ${report.payoff}).
Largest win ${report.largestWin} (${report.topTradeShare}% of gross profit), largest loss ${report.largestLoss} (= ${report.largestLossInAvgWins} average wins).
Max drawdown of realized P&L: ${report.maxDrawdown} (recovery factor ${report.recoveryFactor}).
Average hold: ${report.avgHoldDays} days (winners ${report.avgHoldWinners}d, losers ${report.avgHoldLosers}d).
Longest win streak ${report.maxWinStreak}, longest loss streak ${report.maxLossStreak}.
Top market ${report.topMarket ? `${report.topMarket.key} produced ${report.topMarket.share}% of gross profit` : 'n/a'}.
${monthBlock}
By market:
${report.bySymbol.map(line).join('\n')}

By structure:
${report.byType.map(line).join('\n')}

By side:
${report.bySide.map(line).join('\n')}

Open positions at period end: ${report.openAtEnd.length
  ? report.openAtEnd.map((p) => `${p.side} ${p.qty} ${p.key} @ ${p.avgPrice} (since ${p.since})`).join('; ')
  : 'none'}

Write the ${report.kind === 'year' ? 'year-to-date' : 'monthly'} review.`;
}

async function defaultCoachMessage({ system, user, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: COACH_SCHEMA }, effort: 'medium' },
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

// Returns coach notes, or null when unavailable (no key / API error).
async function coachNotes({ report, createMessage }) {
  if (!report.trades) return null;
  if (!createMessage) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    createMessage = defaultCoachMessage;
  }
  try {
    return await createMessage({
      system: COACH_SYSTEM,
      user: reportPromptUser(report),
      model: COACH_MODEL,
    });
  } catch (err) {
    return null;
  }
}

module.exports = { computePeriodReport, computeMonthlyReport, coachNotes, COACH_SCHEMA };
