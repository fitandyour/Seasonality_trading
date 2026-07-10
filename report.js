// Monthly trading report. Metrics follow the standard journal framework
// (expectancy, profit factor, win rate + payoff, max drawdown, per-setup
// breakdown — Edgewonk/JournalPlus style): the per-bucket expectancy is what
// reveals which setups carry the account and which drain it.

const COACH_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';

function r2(n) { return Math.round(n * 100) / 100; }

function bucketStats(trades) {
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0);
  const netPnl = r2(trades.reduce((s, t) => s + (t.pnl ?? 0), 0));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    netPnl,
    netPoints: r2(trades.reduce((s, t) => s + (t.points ?? 0), 0)),
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

function computeMonthlyReport({ closed, open, month }) {
  const trades = closed.filter((t) => t.exitDate && t.exitDate.startsWith(month));
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0);
  const grossWin = r2(wins.reduce((s, t) => s + t.pnl, 0));
  const grossLoss = r2(Math.abs(losses.reduce((s, t) => s + t.pnl, 0)));
  const netPnl = r2(trades.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const avgWin = wins.length ? r2(grossWin / wins.length) : null;
  const avgLoss = losses.length ? r2(-grossLoss / losses.length) : null;

  // Max drawdown of the cumulative realized P&L curve, in exit order.
  let cum = 0; let peak = 0; let maxDrawdown = 0;
  for (const t of trades) {
    cum += t.pnl ?? 0;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum;
  }

  return {
    month,
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
    avgWin,
    avgLoss,
    payoff: (avgWin != null && avgLoss != null && avgLoss !== 0) ? r2(avgWin / Math.abs(avgLoss)) : null,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : null,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : null,
    maxDrawdown: r2(maxDrawdown),
    avgHoldDays: trades.length ? r2(trades.reduce((s, t) => s + (t.holdDays || 0), 0) / trades.length) : null,
    bySymbol: breakdown(trades, (t) => t.symbol),
    byType: breakdown(trades, (t) => t.type || 'Other'),
    bySide: breakdown(trades, (t) => t.side),
    closedTrades: trades,
    openAtEnd: open,
  };
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

const COACH_SYSTEM = `You are a trading performance coach for a commodity futures spread trader. You get one month's computed statistics from his trade journal. Write a frank, useful review.

Rules:
- Cite only the numbers provided; never invent trades or values.
- Focus on the per-setup breakdowns: which markets/structures/sides carried the month and which drained it (that is where the actionable insight lives).
- Judge quality by expectancy and profit factor, not by win rate alone; note if a good win rate hides a bad payoff ratio or vice versa.
- Comment on drawdown relative to net P&L, hold-time patterns, and concentration risk (too much in one market).
- "actions" must be concrete and checkable next month (e.g. "halve size on HE shorts until expectancy is positive"), 2-4 items.
- This is analysis of past performance, not investment advice.`;

function reportPromptUser(report) {
  const line = (b) => `  ${b.key}: ${b.trades} trades, net ${b.netPnl}, win rate ${b.winRate}%, expectancy ${b.expectancy}/trade, avg hold ${b.avgHoldDays}d`;
  return `Month: ${report.month}
Closed trades: ${report.trades} (${report.wins}W / ${report.losses}L, win rate ${report.winRate}%)
Net P&L: ${report.netPnl} (gross +${report.grossWin} / -${report.grossLoss}), profit factor ${report.profitFactor}
Expectancy per trade: ${report.expectancy}. Avg win ${report.avgWin} vs avg loss ${report.avgLoss} (payoff ${report.payoff}).
Largest win ${report.largestWin}, largest loss ${report.largestLoss}. Max drawdown of realized P&L: ${report.maxDrawdown}.
Average hold: ${report.avgHoldDays} days.

By market:
${report.bySymbol.map(line).join('\n')}

By structure:
${report.byType.map(line).join('\n')}

By side:
${report.bySide.map(line).join('\n')}

Open positions at month end: ${report.openAtEnd.length
  ? report.openAtEnd.map((p) => `${p.side} ${p.qty} ${p.key} @ ${p.avgPrice} (since ${p.since})`).join('; ')
  : 'none'}

Write the monthly review.`;
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

module.exports = { computeMonthlyReport, coachNotes, COACH_SCHEMA };
