function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// lines: [{ points:[{x,y}], cls }]. Optional markers: [{ x, y, text, cls }]
// drawn as a labeled dot (data coords, normalized with the lines). yAxis:true
// labels the value range on the left. This is what gives the chart current-day
// context — e.g. the front line's latest level and date.
function seasonChartSvg({ lines, markers = [], width = 640, height = 220, yAxis = false }) {
  const all = lines.flatMap((l) => l.points).concat(markers);
  const pad = 6;
  const rightPad = markers.length ? 78 : pad; // room for the value label
  const leftPad = yAxis ? 46 : pad;
  let body = '';
  if (all.length > 0) {
    const xs = all.map((p) => p.x); const ys = all.map((p) => p.y);
    const xmin = Math.min(...xs); const xmax = Math.max(...xs);
    const ymin = Math.min(...ys); const ymax = Math.max(...ys);
    const sx = (x) => (xmax === xmin ? (leftPad + (width - leftPad - rightPad) / 2)
      : leftPad + (x - xmin) / (xmax - xmin) * (width - leftPad - rightPad));
    const sy = (y) => (ymax === ymin ? height / 2
      : height - pad - (y - ymin) / (ymax - ymin) * (height - 2 * pad));

    for (const line of lines) {
      if (line.points.length === 0) continue;
      const pts = line.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
      body += `<polyline class="line ${line.cls}" fill="none" points="${pts}"/>`;
    }
    if (yAxis) {
      body += `<text x="4" y="${(sy(ymax) + 4).toFixed(1)}" class="axis" font-size="10" fill="#94a3b8">${ymax.toFixed(2)}</text>`;
      body += `<text x="4" y="${(sy(ymin)).toFixed(1)}" class="axis" font-size="10" fill="#94a3b8">${ymin.toFixed(2)}</text>`;
    }
    for (const m of markers) {
      const mx = sx(m.x); const my = sy(m.y);
      body += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="3.5" class="marker ${m.cls || ''}" fill="#38bdf8"/>`;
      if (m.text) {
        body += `<text x="${(mx + 6).toFixed(1)}" y="${(my + 3.5).toFixed(1)}" font-size="11" fill="#e2e8f0">${esc(m.text)}</text>`;
      }
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

module.exports = { seasonChartSvg };
