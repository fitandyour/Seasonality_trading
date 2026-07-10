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

test('seasonChartSvg renders a marker with its value label', () => {
  const svg = seasonChartSvg({
    lines: [{ points: [{ x: 0, y: 10 }, { x: 5, y: 12 }], cls: 'current' }],
    markers: [{ x: 5, y: 12, text: '-0.53 · 07-09' }],
    yAxis: true,
  });
  assert.match(svg, /<circle/);
  assert.match(svg, /-0\.53 · 07-09/);
  assert.match(svg, /12\.00/); // y-axis max label
  assert.doesNotMatch(svg, /NaN/);
});

test('seasonChartSvg escapes marker text', () => {
  const svg = seasonChartSvg({ lines: [{ points: [{ x: 0, y: 1 }], cls: 'current' }], markers: [{ x: 0, y: 1, text: '<b>' }] });
  assert.match(svg, /&lt;b&gt;/);
});
