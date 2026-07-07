const test = require('node:test');
const assert = require('node:assert/strict');
const { seasonChartSvg } = require('../chartsvg');

test('seasonChartSvg renders one polyline per line, normalized to viewBox', () => {
  const svg = seasonChartSvg({
    lines: [
      { points: [{ x: 0, y: 10 }, { x: 50, y: 20 }], cls: 'current' },
      { points: [{ x: 0, y: 12 }, { x: 50, y: 18 }], cls: 'avg' },
    ],
    width: 100, height: 50,
  });
  assert.match(svg, /^<svg[^>]*viewBox="0 0 100 50"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, /class="line current"/);
  assert.match(svg, /class="line avg"/);
  assert.doesNotMatch(svg, /NaN/);
});

test('seasonChartSvg survives empty lines', () => {
  const svg = seasonChartSvg({ lines: [{ points: [], cls: 'current' }] });
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /NaN/);
});
