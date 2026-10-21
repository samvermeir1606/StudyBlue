'use strict';

/* =========================================================================
   Small SVG chart helpers + a shared hover tooltip.
   Charts are drawn at the container's real width (and redrawn on resize)
   so text never gets squashed on a phone.
   ========================================================================= */

const svgEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = d => new Date(d).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });

/* ---------------------------------------------------------------- tooltip */

const tooltip = (() => {
  const el = document.createElement('div');
  el.className = 'chart-tip';
  el.hidden = true;
  document.body.appendChild(el);

  function show(target) {
    el.textContent = target.dataset.tip;
    el.hidden = false;
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const x = Math.min(innerWidth - w / 2 - 8, Math.max(w / 2 + 8, r.left + r.width / 2));
    el.style.left = `${x}px`;
    el.style.top = `${r.top - 8}px`;
    el.classList.toggle('below', r.top < 70);
    if (r.top < 70) el.style.top = `${r.bottom + 8}px`;
  }
  const hide = () => { el.hidden = true; };

  document.addEventListener('pointerover', e => {
    const t = e.target.closest?.('[data-tip]');
    t ? show(t) : hide();
  });
  document.addEventListener('focusin', e => {
    const t = e.target.closest?.('[data-tip]');
    t ? show(t) : hide();
  });
  addEventListener('scroll', hide, { passive: true });
  return { hide };
})();

/* ---------------------------------------------------------------- mounting */

function mountChart(el, draw) {
  if (!el) return;
  let lastW = 0;
  const render = () => {
    const w = Math.round(el.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    el.innerHTML = draw(w);
  };
  render();
  if ('ResizeObserver' in window) new ResizeObserver(render).observe(el);
}

// Rounded top corners only, so bars stay anchored flat on the baseline.
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/* ---------------------------------------------------------------- score line */

// points: [{ t, pct, right, total }]
function scoreLineChart(points, width) {
  const H = 200, L = 40, R = 16, T = 18, B = 28;
  const iw = width - L - R, ih = H - T - B;
  const n = points.length;
  const x = i => L + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = v => T + ih - (v / 100) * ih;

  let s = `<svg class="chart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Score per ronde">`;
  s += `<defs><linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--chart-line)" stop-opacity=".22"/><stop offset="1" stop-color="var(--chart-line)" stop-opacity="0"/></linearGradient></defs>`;
  for (const g of [0, 50, 100]) {
    s += `<line class="grid" x1="${L}" x2="${width - R}" y1="${y(g)}" y2="${y(g)}"/>`;
    s += `<text class="axis" x="${L - 8}" y="${y(g) + 4}" text-anchor="end">${g}%</text>`;
  }
  // Star thresholds as faint guides
  s += `<line class="guide" x1="${L}" x2="${width - R}" y1="${y(90)}" y2="${y(90)}"/><text class="axis guide-label" x="${L + 4}" y="${y(90) - 4}">⭐⭐⭐</text>`;

  if (n > 1) {
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.pct)}`).join('');
    s += `<path d="${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="url(#scoreFill)"/>`;
    s += `<path class="line" d="${line}"/>`;
  }

  // x labels: at most ~6, always first and last
  const maxLabels = Math.max(2, Math.floor(iw / 70));
  const step = Math.max(1, Math.ceil(n / maxLabels));
  points.forEach((p, i) => {
    if (i % step === 0 || i === n - 1) {
      if (i !== n - 1 && n - 1 - i < step / 2) return; // avoid colliding with last label
      s += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${svgEsc(p.label || shortDate(p.t))}</text>`;
    }
  });

  points.forEach((p, i) => {
    const tip = `${p.label || shortDate(p.t)} · ${p.pct}%${p.total ? `\n${p.right} van ${p.total} juist` : ''}`;
    s += `<g class="pt" tabindex="0" data-tip="${svgEsc(tip)}"><circle class="hit" cx="${x(i)}" cy="${y(p.pct)}" r="14"/><circle class="dot" cx="${x(i)}" cy="${y(p.pct)}" r="5"/></g>`;
  });
  // Direct label on the latest score only
  const last = points[n - 1];
  s += `<text class="value" x="${x(n - 1)}" y="${y(last.pct) - 12}" text-anchor="${n === 1 ? 'middle' : 'end'}">${last.pct}%</text>`;
  return s + '</svg>';
}

/* ---------------------------------------------------------------- daily bars */

// days: [{ day: Date, r, w }]
function dailyBarsChart(days, width) {
  const H = 190, L = 34, R = 8, T = 14, B = 26;
  const iw = width - L - R, ih = H - T - B;
  const max = niceMax(Math.max(1, ...days.map(d => d.r + d.w)));
  const slot = iw / days.length;
  const bw = Math.min(26, slot * 0.62);
  const y = v => T + ih - (v / max) * ih;
  const today = dayString();

  let s = `<svg class="chart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Kaarten per dag">`;
  for (const g of [0, max / 2, max]) {
    s += `<line class="grid" x1="${L}" x2="${width - R}" y1="${y(g)}" y2="${y(g)}"/>`;
    s += `<text class="axis" x="${L - 8}" y="${y(g) + 4}" text-anchor="end">${Math.round(g)}</text>`;
  }
  days.forEach((d, i) => {
    const cx = L + slot * i + slot / 2;
    const x0 = cx - bw / 2;
    const total = d.r + d.w;
    const isToday = dayString(d.day) === today;
    const label = d.day.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' });
    if (total) {
      const hr = (d.r / max) * ih, hw = (d.w / max) * ih;
      const gap = d.r && d.w ? 2 : 0;
      // right answers sit on the baseline, wrong answers stacked on top
      if (d.r) s += `<path class="seg-right" d="${d.w ? `M${x0},${y(0)}V${y(0) - hr}H${x0 + bw}V${y(0)}Z` : barPath(x0, y(0) - hr, bw, hr, 4)}"/>`;
      if (d.w) s += `<path class="seg-wrong" d="${barPath(x0, y(0) - hr - gap - hw, bw, hw, 4)}"/>`;
    }
    s += `<rect class="hit" tabindex="0" x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}" data-tip="${svgEsc(`${label}\n✓ ${d.r} juist · ✗ ${d.w} fout`)}"/>`;
    s += `<text class="axis${isToday ? ' today' : ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${d.day.getDate()}</text>`;
  });
  return s + '</svg>';
}

/* ---------------------------------------------------------------- calendar heatmap */

// activity: { 'YYYY-MM-DD': { n, r } }
function heatmapChart(activity, width) {
  const gap = 3, labelW = 24, top = 18;
  // Show up to half a year; squares grow to fill wide screens, phones show fewer weeks
  const cell = Math.max(12, Math.min(24, Math.floor((width - labelW) / 26) - gap));
  const weeks = Math.max(6, Math.min(26, Math.floor((width - labelW + gap) / (cell + gap))));
  const H = top + 7 * (cell + gap);
  const level = n => (n === 0 ? 0 : n < 10 ? 1 : n < 25 ? 2 : n < 50 ? 3 : 4);

  // Last column ends with this week (weeks start on Monday)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - dow - (weeks - 1) * 7);

  let s = `<svg class="chart heatmap" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Dagen dat je geleerd hebt">`;
  ['ma', '', 'wo', '', 'vr', '', ''].forEach((d, i) => {
    if (d) s += `<text class="axis" x="0" y="${top + i * (cell + gap) + cell - 2}">${d}</text>`;
  });
  let lastMonth = -1, lastLabelX = -Infinity;
  for (let w = 0; w < weeks; w++) {
    const x = labelW + w * (cell + gap);
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) continue;
      if (d === 0 && date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        // skip a month label when it would bump into the previous one
        if (w < weeks - 1 && x - lastLabelX >= 34 && !(w === 0 && date.getDate() > 14)) {
          s += `<text class="axis" x="${x}" y="11">${svgEsc(date.toLocaleDateString('nl-BE', { month: 'short' }))}</text>`;
          lastLabelX = x;
        }
      }
      const a = activity[dayString(date)] || { n: 0, r: 0 };
      const tip = `${date.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' })}\n${a.n ? `${a.n} kaarten · ${a.r} juist` : 'Niet geleerd'}`;
      s += `<rect class="heat-${level(a.n)}${dayString(date) === dayString(today) ? ' today' : ''}" x="${x}" y="${top + d * (cell + gap)}" width="${cell}" height="${cell}" rx="3" data-tip="${svgEsc(tip)}"/>`;
    }
  }
  return s + '</svg>';
}

/* ---------------------------------------------------------------- small HTML pieces */

// Horizontal stacked bar: segments [{ value, cls, label }]
function stackBar(segments, { height = 14 } = {}) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  return `<div class="stack" style="height:${height}px">${segments.filter(s => s.value > 0).map(s =>
    `<span class="${s.cls}" style="flex:${s.value / total}" data-tip="${svgEsc(`${s.label}: ${s.value}`)}"></span>`).join('')}</div>`;
}

function legend(items) {
  return `<div class="legend">${items.map(i => `<span><i class="${i.cls}"></i>${i.label}</span>`).join('')}</div>`;
}
