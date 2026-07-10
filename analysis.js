// Claude expert-read module. Consumes the deterministic analog features from
// scoring.js (grounded numbers — Claude never invents a price) and returns a
// ranked recommendation. Degrades to a deterministic verdict when no API key
// is set, so the dashboard always has something to show. See docs/scarr* and
// the design spec §2.

const DEFAULT_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';
// Per-cycle setup evaluation runs ~50-100x per sync, so it defaults to a
// cheap model. Override with SETUP_MODEL (e.g. claude-sonnet-4-6 for sharper
// reads at higher cost). The one-off vision/coach paths use DEFAULT_MODEL.
const SETUP_MODEL = process.env.SETUP_MODEL || process.env.ANALYSIS_MODEL || 'claude-sonnet-4-6';

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    direction: { type: 'string', enum: ['long', 'short', 'none'] },
    probability: { type: 'integer' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    headline: { type: 'string' },
    rationale: { type: 'string' },
    analogYears: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { year: { type: 'string' }, note: { type: 'string' } },
        required: ['year', 'note'],
      },
    },
    targetWith: { type: 'string' },
    targetAgainst: { type: 'string' },
    risk: { type: 'string' },
    recommendation: { type: 'string', enum: ['take', 'watch', 'skip'] },
  },
  required: [
    'direction', 'probability', 'confidence', 'headline', 'rationale',
    'analogYears', 'targetWith', 'targetAgainst', 'risk', 'recommendation',
  ],
};

const SYSTEM = `You are a commodity futures spread seasonality analyst. You are given, for one spread strategy, this year's position, a year-by-year table of how each recent year's spread behaved at the same point in its season and what it did next, and a proposed trade with concrete levels already computed from those analog years. Your job is to judge whether the developing pattern is likely to repeat and explain the setup plainly.

Rules:
- Every price or level you cite must come from the numbers provided (the analog table and the proposed trade). Never invent a number.
- This is probabilistic analysis, NOT a buy/sell recommendation or investment advice.
- Weigh agreement (how many close analogs moved the same way), similarity (how alike the paths are), move size, and the adverse excursions. A lone outlier year is weak evidence.
- "probability" is your estimate (0-100) that the proposed move plays out over the window.
- In targetWith describe the entry and profit target; in targetAgainst describe the stop and what invalidates it. Reuse the proposed trade's numbers.
- Name the specific analog years driving the read and the year(s) that are the risk case.
- Be concise and concrete.`;

function fmt(n, d = 2) {
  return n == null ? '—' : Number(n).toFixed(d);
}

function buildPrompt(strategy, analog, trade) {
  const w = strategy.config && strategy.config.window;
  const window = w ? `${w.openMonth} ${w.openDate} → ${w.closeMonth} ${w.closeDate}` : 'unknown';
  const legs = (strategy.config && strategy.config.legs) || '?';
  const rows = analog.years.map((y) => (
    `  ${y.label}: similarity ${fmt(y.similarity)}, next move ${fmt(y.nextMove)} `
    + `(best ${fmt(y.maxFavorable)}, worst ${fmt(y.maxAdverse)}), `
    + `it was at ${fmt(y.levelThen)} here vs this year ${fmt(analog.entry)} `
    + `(gap ${fmt(y.levelGap)})`
  )).join('\n');

  const dir = analog.agreementDirection > 0 ? 'up' : analog.agreementDirection < 0 ? 'down' : 'split';
  const tradeBlock = trade
    ? `Proposed trade (levels computed from the agreeing analogs):
  Side: ${trade.side} the spread. Entry ~${fmt(trade.entry)}. Target ${fmt(trade.target)}. Stop ${fmt(trade.stop)}. Ideal exit ${trade.exitDate || '?'}. Reward:risk ≈ ${trade.rr}.`
    : 'No trade proposed.';

  const user = `Strategy: ${strategy.save_name}
Legs: ${legs}. Seasonal window: ${window}.
This year's spread level now: ${fmt(analog.entry)}.

Per-year analogs (most similar first):
${rows}

Aggregate: ${analog.analogCount} close analogs, agreement ${dir} (${analog.agreementCount} agreeing), mean next move ${fmt(analog.meanNextMove)}, opposite-side risk ${fmt(analog.oppositeRisk)}.

${tradeBlock}

Give your read on this setup for the upcoming window.`;

  return { system: SYSTEM, user };
}

// Deterministic verdict from the aggregate — used when Claude is unavailable.
function fallbackVerdict(analog, trade) {
  const dir = analog.agreementDirection;
  const direction = dir > 0 ? 'long' : dir < 0 ? 'short' : 'none';
  const probability = direction === 'none' ? 0
    : Math.max(50, Math.min(100, Math.round(50 + analog.score / 2)));
  const confidence = analog.score >= 70 ? 'high' : analog.score >= 45 ? 'medium' : 'low';
  const recommendation = direction === 'none' ? 'skip'
    : analog.score >= 65 ? 'take' : analog.score >= 40 ? 'watch' : 'skip';
  const analogYears = analog.years
    .filter((y) => y.similarity != null && y.nextMove != null)
    .slice(0, 5)
    .map((y) => ({ year: y.label, note: `sim ${fmt(y.similarity)}, next ${fmt(y.nextMove)}` }));
  const moveWord = direction === 'short' ? 'fell' : 'rose';
  return {
    direction,
    probability,
    confidence,
    headline: direction === 'none'
      ? 'Analog years disagree — no edge'
      : `${analog.agreementCount} of ${analog.analogCount} analogs ${moveWord} next`,
    rationale: direction === 'none'
      ? `Of ${analog.analogCount} close analog years, direction was split — no repeatable signal.`
      : `${analog.agreementCount} of ${analog.analogCount} close analog years ${moveWord} over this window (mean ${fmt(analog.meanNextMove)}); opposite-side risk ${fmt(analog.oppositeRisk)}.`,
    analogYears,
    targetWith: trade
      ? `Enter ~${fmt(trade.entry)}, target ${fmt(trade.target)} by ${trade.exitDate || '?'} (R:R ≈ ${trade.rr}).`
      : 'see analog next-move magnitudes above',
    targetAgainst: trade
      ? `Stop ${fmt(trade.stop)} — beyond the worst drawdown the analog years saw before the move worked.`
      : 'a reversal past this year’s current level flips the read',
    risk: `${analog.analogCount - analog.agreementCount} analog year(s) went the other way; sizing should respect the ${fmt(analog.oppositeRisk)} adverse risk.`,
    recommendation,
  };
}

async function defaultCreateMessage({ system, user, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA }, effort: 'medium' },
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

async function analyzeStrategy({ strategy, analog, trade, createMessage }) {
  if (!createMessage) {
    if (!process.env.ANTHROPIC_API_KEY) return { ...fallbackVerdict(analog, trade), source: 'fallback' };
    createMessage = defaultCreateMessage;
  }
  const { system, user } = buildPrompt(strategy, analog, trade);
  try {
    const verdict = await createMessage({ system, user, model: DEFAULT_MODEL });
    return { ...verdict, source: 'claude' };
  } catch (err) {
    return { ...fallbackVerdict(analog, trade), source: 'fallback', error: err.message };
  }
}

// ---- Per-cycle setup evaluation (hybrid: mechanical candidate + Claude judgment) ----

const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opportunity: { type: 'boolean' },
    side: { type: 'string', enum: ['long', 'short', 'none'] },
    entry: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    stop: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    target: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    exitDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    probability: { type: 'integer' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    headline: { type: 'string' },
    rationale: { type: 'string' },
    risk: { type: 'string' },
  },
  required: ['opportunity', 'side', 'entry', 'stop', 'target', 'exitDate',
    'probability', 'confidence', 'headline', 'rationale', 'risk'],
};

const SETUP_SYSTEM = `You are a commodity futures spread seasonality analyst deciding whether ONE contract cycle of a saved spread strategy offers a tradeable setup today. You get: this cycle's front contracts, this year's current level, a table of how each of the last 5 years behaved at the same aligned point and what each did next through the seasonal window, aggregates, and (sometimes) a mechanically computed candidate trade.

How to judge (standard seasonal-spread practice, MRCI-style):
- An opportunity needs directional agreement among the usable analog years — prefer 3+ of 5 moving the same way next, weighted by how similar their path-so-far is to this year. 4+ of 5 is strong.
- Entry quality: compare this year's level to where the agreeing years were at this point (the levelGap column). Entering cheaper than the analogs (for a long) improves the case; chasing far above them weakens it.
- Risk must be defined: the stop belongs beyond the worst adverse excursion the agreeing years saw before their move worked. If the implied risk exceeds the likely reward, it is not an opportunity.
- Thin data (few overlapping points, similarity null) means low confidence — flag an opportunity only if the level vs prior years is compelling on its own.
- Every number you output MUST be derivable from the table or the candidate (levels the analog years actually reached). Never invent a price.
- If the candidate trade looks right, adopt or refine it. If the analogs disagree or risk/reward is poor, set opportunity=false and say why in one line.
- This is probabilistic analysis, not investment advice.`;

function cyclePromptUser(strategy, cycle, todayDate) {
  const w = strategy.config && strategy.config.window;
  const window = w ? `${w.openMonth} ${w.openDate} → ${w.closeMonth} ${w.closeDate}` : 'unknown';
  const a = cycle.analog;
  const rows = a.years.map((y) => (
    `  ${y.label}: similarity ${fmt(y.similarity)}, next move ${fmt(y.nextMove)} `
    + `(best ${fmt(y.maxFavorable)}, worst ${fmt(y.maxAdverse)}), `
    + `level then ${fmt(y.levelThen)} vs now ${fmt(a.entry)} (gap ${fmt(y.levelGap)})`
  )).join('\n');
  const t = cycle.trade;
  const candidate = t
    ? `Candidate trade: ${t.side} at ~${fmt(t.entry)}, target ${fmt(t.target)}, stop ${fmt(t.stop)}, ideal exit ${t.exitDate || '?'}, R:R ≈ ${t.rr}, ${t.agreeCount} years agree.`
    : 'No mechanical candidate passed the filter.';
  return `Strategy: ${strategy.save_name}
Cycle: ${cycle.label} (front ${cycle.front}). Today: ${todayDate}. Seasonal window: ${window}.
This year's level now: ${fmt(a.entry)}.

Per-year analogs (most similar first):
${rows || '  (no usable prior-year data)'}

Aggregate: ${a.analogCount} usable analogs, ${a.agreementCount} agree ${a.agreementDirection > 0 ? 'up' : a.agreementDirection < 0 ? 'down' : '(split)'}, mean next move ${fmt(a.meanNextMove)}, opposite-side risk ${fmt(a.oppositeRisk)}.

${candidate}

Decide: is there a tradeable setup on this cycle?`;
}

// No API key / API failure: the mechanical candidate IS the decision.
function fallbackSetup(analog, trade) {
  if (!trade) {
    return {
      opportunity: false, side: 'none', entry: null, stop: null, target: null,
      exitDate: null, probability: 0, confidence: 'low',
      headline: 'No setup — analogs disagree or filters not met',
      rationale: `${analog.agreementCount || 0} of ${analog.analogCount || 0} usable analog years agree; below the bar.`,
      risk: '',
      source: 'fallback',
    };
  }
  const prob = Math.max(50, Math.min(100, Math.round(50 + analog.score / 2)));
  return {
    opportunity: true, side: trade.side, entry: trade.entry, stop: trade.stop,
    target: trade.target, exitDate: trade.exitDate, probability: prob,
    confidence: analog.score >= 60 ? 'high' : analog.score >= 45 ? 'medium' : 'low',
    headline: `${trade.agreeCount} of ${analog.analogCount} analog years moved ${trade.side === 'long' ? 'up' : 'down'} from here`,
    rationale: `Mean next move ${fmt(analog.meanNextMove)}; stop set beyond the analogs' worst drawdown (${fmt(analog.oppositeRisk)} opposite-side risk).`,
    risk: `${(analog.analogCount || 0) - (trade.agreeCount || 0)} analog year(s) went the other way.`,
    source: 'fallback',
  };
}

async function defaultSetupMessage({ system, user, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  // Bounded judgment over a small table — no extended thinking, low effort.
  // This is the high-volume path (one call per cycle per sync), so keep it cheap.
  const resp = await client.messages.create({
    model,
    max_tokens: 1000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: SETUP_SCHEMA }, effort: 'low' },
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

// Evaluate one contract cycle. cycle = { label, front, analog, trade }.
async function evaluateCycle({ strategy, cycle, todayDate, createMessage }) {
  if (!createMessage) {
    if (!process.env.ANTHROPIC_API_KEY) return fallbackSetup(cycle.analog, cycle.trade);
    createMessage = defaultSetupMessage;
  }
  try {
    const verdict = await createMessage({
      system: SETUP_SYSTEM,
      user: cyclePromptUser(strategy, cycle, todayDate),
      model: SETUP_MODEL,
    });
    return { ...verdict, source: 'claude' };
  } catch (err) {
    return { ...fallbackSetup(cycle.analog, cycle.trade), error: err.message };
  }
}

module.exports = {
  fallbackVerdict, buildPrompt, analyzeStrategy, VERDICT_SCHEMA, DEFAULT_MODEL,
  SETUP_SCHEMA, evaluateCycle, fallbackSetup, cyclePromptUser,
};
