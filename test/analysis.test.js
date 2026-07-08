const test = require('node:test');
const assert = require('node:assert/strict');
const { fallbackVerdict, buildPrompt, analyzeStrategy } = require('../analysis');

const STRATEGY = {
  save_name: 'Feeder cattle_A_ HJK',
  config: {
    legs: 3,
    window: { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 },
    form: { p: [1, -1, 1], mult: [1, 2, 1] },
  },
};

const ANALOG = {
  levelNow: 1.0,
  analogCount: 4,
  agreementDirection: 1,
  agreementCount: 3,
  meanNextMove: 1.8,
  oppositeRisk: 0.9,
  score: 71,
  years: [
    { label: 'FC2026', similarity: 0.97, nextMove: 2.1, maxFavorable: 2.4, maxAdverse: -0.3, levelThen: 1.2, levelGap: -0.2 },
    { label: 'FC2025', similarity: 0.95, nextMove: 1.7, maxFavorable: 1.9, maxAdverse: -0.4, levelThen: 1.4, levelGap: -0.4 },
    { label: 'FC2024', similarity: 0.91, nextMove: 1.6, maxFavorable: 1.8, maxAdverse: -0.2, levelThen: 1.1, levelGap: -0.1 },
    { label: 'FC2023', similarity: 0.90, nextMove: -1.2, maxFavorable: 0.3, maxAdverse: -1.5, levelThen: 0.9, levelGap: 0.1 },
  ],
};

test('fallbackVerdict derives a long verdict from a bullish aggregate', () => {
  const v = fallbackVerdict(ANALOG);
  assert.equal(v.direction, 'long');
  assert.ok(v.probability >= 50 && v.probability <= 100);
  assert.ok(['low', 'medium', 'high'].includes(v.confidence));
  assert.match(v.rationale, /3 of 4/);
  assert.ok(Array.isArray(v.analogYears));
});

test('fallbackVerdict returns direction none when analogs disagree evenly', () => {
  const v = fallbackVerdict({ ...ANALOG, agreementDirection: 0, agreementCount: 2, analogCount: 4, score: 0 });
  assert.equal(v.direction, 'none');
  assert.equal(v.recommendation, 'skip');
});

test('buildPrompt embeds the real analog numbers and framing', () => {
  const { system, user } = buildPrompt(STRATEGY, ANALOG);
  assert.match(system, /analysis, not.*advice/i);
  assert.match(user, /Feeder cattle_A_ HJK/);
  assert.match(user, /FC2026/);
  assert.match(user, /0\.97/);      // similarity rendered
  assert.match(user, /2\.1/);       // next move rendered
  assert.match(user, /January 1/);  // window
});

test('analyzeStrategy uses an injected createMessage and tags source claude', async () => {
  const fakeVerdict = {
    direction: 'long', probability: 68, confidence: 'medium',
    headline: 'Tracks 2024–2026', rationale: 'Three analogs rose.',
    analogYears: [{ year: 'FC2026', note: 'rose 2.1' }],
    targetWith: 'prior highs near +2.4', targetAgainst: 'below +0.6',
    risk: 'FC2023 fell', recommendation: 'watch',
  };
  let seen = null;
  const createMessage = async (args) => { seen = args; return fakeVerdict; };
  const out = await analyzeStrategy({ strategy: STRATEGY, analog: ANALOG, createMessage });
  assert.equal(out.source, 'claude');
  assert.equal(out.direction, 'long');
  assert.equal(out.recommendation, 'watch');
  assert.ok(seen.system && seen.user && seen.model);
});

test('analyzeStrategy falls back when createMessage throws', async () => {
  const createMessage = async () => { throw new Error('api down'); };
  const out = await analyzeStrategy({ strategy: STRATEGY, analog: ANALOG, createMessage });
  assert.equal(out.source, 'fallback');
  assert.equal(out.direction, 'long');
  assert.match(out.error, /api down/);
});

test('analyzeStrategy falls back to deterministic verdict without an API key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const out = await analyzeStrategy({ strategy: STRATEGY, analog: ANALOG });
    assert.equal(out.source, 'fallback');
    assert.equal(out.direction, 'long');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
