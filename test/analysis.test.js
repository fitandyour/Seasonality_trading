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

const TRADE = { side: 'long', entry: 1.0, target: 2.8, stop: 0.4, exitDate: '2027-02-10', rr: 3.0, agreeCount: 3 };

const ANALOG = {
  entry: 1.0,
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

test('fallbackVerdict derives a long verdict and echoes the trade levels', () => {
  const v = fallbackVerdict(ANALOG, TRADE);
  assert.equal(v.direction, 'long');
  assert.ok(v.probability >= 50 && v.probability <= 100);
  assert.ok(['low', 'medium', 'high'].includes(v.confidence));
  assert.match(v.rationale, /3 of 4/);
  assert.match(v.targetWith, /2\.8/);   // target level echoed
  assert.match(v.targetAgainst, /0\.4/); // stop echoed
});

test('fallbackVerdict returns direction none when analogs disagree evenly', () => {
  const v = fallbackVerdict({ ...ANALOG, agreementDirection: 0, agreementCount: 2, analogCount: 4, score: 0 }, null);
  assert.equal(v.direction, 'none');
  assert.equal(v.recommendation, 'skip');
});

test('buildPrompt embeds the analog numbers, framing, and the proposed trade', () => {
  const { system, user } = buildPrompt(STRATEGY, ANALOG, TRADE);
  assert.match(system, /analysis, not.*advice/i);
  assert.match(user, /Feeder cattle_A_ HJK/);
  assert.match(user, /FC2026/);
  assert.match(user, /0\.97/);       // similarity rendered
  assert.match(user, /2\.1/);        // next move rendered
  assert.match(user, /January 1/);   // window
  assert.match(user, /Proposed trade/);
  assert.match(user, /Stop 0\.40/);  // trade stop rendered
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

const { evaluateCycle, fallbackSetup } = require('../analysis');

test('fallbackSetup converts a candidate trade into an opportunity verdict', () => {
  const analog = { agreementCount: 3, analogCount: 4, score: 55, meanNextMove: 1.8, oppositeRisk: 0.9 };
  const trade = { side: 'long', entry: 1.0, target: 2.8, stop: 0.4, exitDate: '2027-02-10', rr: 3, agreeCount: 3 };
  const v = fallbackSetup(analog, trade);
  assert.equal(v.opportunity, true);
  assert.equal(v.side, 'long');
  assert.equal(v.entry, 1.0);
  assert.ok(v.probability >= 50);
});

test('fallbackSetup without a candidate is a clear no', () => {
  const v = fallbackSetup({ agreementCount: 2, analogCount: 5, score: 20 }, null);
  assert.equal(v.opportunity, false);
  assert.equal(v.side, 'none');
});

test('evaluateCycle uses injected createMessage and tags source claude', async () => {
  const cycle = {
    label: 'current', front: 'LH2026Q/LH2026V',
    analog: { entry: 14.2, years: [], analogCount: 4, agreementCount: 3, agreementDirection: 1, meanNextMove: 2, oppositeRisk: 1, score: 50 },
    trade: null,
  };
  const fake = { opportunity: true, side: 'long', entry: 14.2, stop: 11.0, target: 17.7, exitDate: '2026-08-01', probability: 62, confidence: 'medium', headline: 'h', rationale: 'r', risk: 'k' };
  let seen = null;
  const v = await evaluateCycle({ strategy: STRATEGY, cycle, todayDate: '2026-07-10', createMessage: async (a) => { seen = a; return fake; } });
  assert.equal(v.source, 'claude');
  assert.equal(v.opportunity, true);
  assert.match(seen.user, /LH2026Q/);
  assert.match(seen.user, /current/);
});

test('evaluateCycle falls back when the API call fails', async () => {
  const cycle = {
    label: 'next', front: 'LH2027Q/LH2027V',
    analog: { entry: 15, years: [], analogCount: 0, agreementCount: 0, agreementDirection: 0, score: 0 },
    trade: null,
  };
  const v = await evaluateCycle({ strategy: STRATEGY, cycle, todayDate: '2026-07-10', createMessage: async () => { throw new Error('down'); } });
  assert.equal(v.opportunity, false);
  assert.match(v.error, /down/);
});
