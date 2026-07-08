// Claude expert-read module. Consumes the deterministic analog features from
// scoring.js (grounded numbers — Claude never invents a price) and returns a
// ranked recommendation. Degrades to a deterministic verdict when no API key
// is set, so the dashboard always has something to show. See docs/scarr* and
// the design spec §2.

const DEFAULT_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';

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

const SYSTEM = `You are a commodity futures spread seasonality analyst. You are given, for one spread strategy, this year's position plus a year-by-year table of how each recent year's spread behaved at the same point in its season and what it did next. Your job is analog matching: identify which prior years this year most resembles, judge whether the developing pattern is likely to repeat, and always state the opposite-side risk if it breaks the other way.

Rules:
- Every price or level you cite must come from the numbers provided. Never invent a number.
- This is probabilistic analysis, NOT a buy/sell recommendation or investment advice.
- Weigh agreement (how many close analogs moved the same way), similarity (how alike the paths are), move size, and the adverse excursions. A lone outlier year is weak evidence.
- "probability" is your estimate (0-100) that the expected directional move plays out over the strategy's window.
- Targets: cite the specific levels the analog years reached (with the trade) and the level that would signal it is failing (against the trade).
- Be concise and concrete.`;

function fmt(n, d = 2) {
  return n == null ? '—' : Number(n).toFixed(d);
}

function buildPrompt(strategy, analog) {
  const w = strategy.config && strategy.config.window;
  const window = w ? `${w.openMonth} ${w.openDate} → ${w.closeMonth} ${w.closeDate}` : 'unknown';
  const legs = (strategy.config && strategy.config.legs) || '?';
  const rows = analog.years.map((y) => (
    `  ${y.label}: similarity ${fmt(y.similarity)}, next move ${fmt(y.nextMove)} `
    + `(best ${fmt(y.maxFavorable)}, worst ${fmt(y.maxAdverse)}), `
    + `it was at ${fmt(y.levelThen)} here vs this year ${fmt(analog.levelNow)} `
    + `(gap ${fmt(y.levelGap)})`
  )).join('\n');

  const dir = analog.agreementDirection > 0 ? 'up' : analog.agreementDirection < 0 ? 'down' : 'split';
  const user = `Strategy: ${strategy.save_name}
Legs: ${legs}. Seasonal window: ${window}.
This year's spread level now: ${fmt(analog.levelNow)}.

Per-year analogs (most similar first):
${rows}

Aggregate: ${analog.analogCount} close analogs, agreement ${dir} (${analog.agreementCount} agreeing), mean next move ${fmt(analog.meanNextMove)}, opposite-side risk ${fmt(analog.oppositeRisk)}, raw score ${analog.score}/100.

Give your analog-matched read for the upcoming window.`;

  return { system: SYSTEM, user };
}

// Deterministic verdict from the aggregate — used when Claude is unavailable.
function fallbackVerdict(analog) {
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
    targetWith: 'see analog next-move magnitudes above',
    targetAgainst: 'a reversal past this year’s current level flips the read',
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

async function analyzeStrategy({ strategy, analog, createMessage }) {
  if (!createMessage) {
    if (!process.env.ANTHROPIC_API_KEY) return { ...fallbackVerdict(analog), source: 'fallback' };
    createMessage = defaultCreateMessage;
  }
  const { system, user } = buildPrompt(strategy, analog);
  try {
    const verdict = await createMessage({ system, user, model: DEFAULT_MODEL });
    return { ...verdict, source: 'claude' };
  } catch (err) {
    return { ...fallbackVerdict(analog), source: 'fallback', error: err.message };
  }
}

module.exports = { fallbackVerdict, buildPrompt, analyzeStrategy, VERDICT_SCHEMA, DEFAULT_MODEL };
