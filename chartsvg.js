function seasonChartSvg({ lines, width = 640, height = 220 }) {
  const all = lines.flatMap((l) => l.points);
  const pad = 6;
  let body = '';
  if (all.length > 0) {
    const xs = all.map((p) => p.x); const ys = all.map((p) => p.y);
    const xmin = Math.min(...xs); const xmax = Math.max(...xs);
    const ymin = Math.min(...ys); const ymax = Math.max(...ys);
    const sx = (x) => xmax === xmin ? width / 2 : pad + (x - xmin) / (xmax - xmin) * (width - 2 * pad);
    const sy = (y) => ymax === ymin ? height / 2 : height - pad - (y - ymin) / (ymax - ymin) * (height - 2 * pad);
    for (const line of lines) {
      if (line.points.length === 0) continue;
      const pts = line.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
      body += `<polyline class="line ${line.cls}" fill="none" points="${pts}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

module.exports = { seasonChartSvg };
