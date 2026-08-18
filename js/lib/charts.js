/**
 * Charts, hand-rolled in SVG.
 *
 * A charting library would be several hundred kilobytes to draw four shapes,
 * and would drag a build step into a project that deliberately has none. These
 * are plain SVG: they inherit the page's colours, scale with the container,
 * and carry a table-equivalent label for screen readers, which most charting
 * libraries do not.
 */

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function frame(width, height, label) {
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': label,
    preserveAspectRatio: 'xMidYMid meet',
    class: 'chart',
  });
  return svg;
}

const niceMax = (value) => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
};

/**
 * Vertical bars. The workhorse: books per month, pages per month.
 * @param {{label: string, value: number}[]} data
 */
export function barChart(data, { height = 190, label = 'Bar chart', format = (v) => v } = {}) {
  const width = 640;
  const padding = { top: 16, right: 8, bottom: 30, left: 34 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const slot = plotW / Math.max(data.length, 1);
  const barW = Math.min(slot * 0.62, 46);

  const svg = frame(width, height, `${label}. ${data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}`);

  // Two gridlines is enough to read a bar against without drawing a cage.
  for (const fraction of [0, 0.5, 1]) {
    const y = padding.top + plotH * (1 - fraction);
    svg.append(
      svgEl('line', {
        x1: padding.left, x2: width - padding.right, y1: y, y2: y, class: 'chart__grid',
      }),
      svgEl('text', {
        x: padding.left - 6, y: y + 4, class: 'chart__axis', 'text-anchor': 'end',
      }, format(Math.round(max * fraction)))
    );
  }

  data.forEach((point, index) => {
    const barH = max ? (point.value / max) * plotH : 0;
    const x = padding.left + slot * index + (slot - barW) / 2;
    const y = padding.top + plotH - barH;

    if (point.value > 0) {
      svg.append(svgEl('rect', {
        x, y, width: barW, height: Math.max(barH, 2), rx: 1, class: 'chart__bar',
      }, svgEl('title', {}, `${point.label}: ${format(point.value)}`)));
    }

    svg.append(svgEl('text', {
      x: x + barW / 2, y: height - 10, class: 'chart__label', 'text-anchor': 'middle',
    }, point.label));
  });

  return svg;
}

/**
 * A cumulative line — pages read over time. Area fill under it, because the
 * total is the point, not the individual readings.
 */
export function lineChart(data, { height = 190, label = 'Line chart', format = (v) => v } = {}) {
  const width = 640;
  const padding = { top: 16, right: 10, bottom: 30, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const svg = frame(width, height, `${label}. Ends at ${format(data.at(-1)?.value ?? 0)}.`);
  if (data.length < 2) return svg;

  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const x = (i) => padding.left + (plotW * i) / (data.length - 1);
  const y = (v) => padding.top + plotH - (max ? (v / max) * plotH : 0);

  for (const fraction of [0, 0.5, 1]) {
    const gy = padding.top + plotH * (1 - fraction);
    svg.append(
      svgEl('line', { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, class: 'chart__grid' }),
      svgEl('text', { x: padding.left - 6, y: gy + 4, class: 'chart__axis', 'text-anchor': 'end' },
        format(Math.round(max * fraction)))
    );
  }

  const points = data.map((point, i) => `${x(i)},${y(point.value)}`);
  svg.append(
    svgEl('polygon', {
      class: 'chart__area',
      points: `${padding.left},${padding.top + plotH} ${points.join(' ')} ${padding.left + plotW},${padding.top + plotH}`,
    }),
    svgEl('polyline', { class: 'chart__line', points: points.join(' ') })
  );

  // Only first, middle and last get labels; every tick would be unreadable.
  for (const index of [0, Math.floor((data.length - 1) / 2), data.length - 1]) {
    svg.append(svgEl('text', {
      x: x(index), y: height - 10, class: 'chart__label',
      'text-anchor': index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle',
    }, data[index].label));
  }

  return svg;
}

/**
 * Horizontal bars for categories — genres, authors. Horizontal because the
 * labels are words, and words don't fit under a vertical bar.
 */
export function rankChart(data, { label = 'Breakdown', format = (v) => v, max: cap = 8 } = {}) {
  const rows = data.slice(0, cap);
  const width = 640;
  const rowH = 26;
  const height = Math.max(rows.length * rowH + 8, 40);
  const labelW = 168;

  const svg = frame(width, height, `${label}. ${rows.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}`);
  const max = Math.max(...rows.map((d) => d.value), 1);

  rows.forEach((row, index) => {
    const y = index * rowH + 4;
    const barW = ((width - labelW - 60) * row.value) / max;

    svg.append(
      svgEl('text', { x: 0, y: y + 14, class: 'chart__row-label' },
        row.label.length > 24 ? `${row.label.slice(0, 23)}\u2026` : row.label),
      svgEl('rect', { x: labelW, y: y + 3, width: Math.max(barW, 2), height: 14, rx: 1, class: 'chart__bar' }),
      svgEl('text', { x: labelW + Math.max(barW, 2) + 8, y: y + 14, class: 'chart__axis' }, format(row.value))
    );
  });

  return svg;
}

/**
 * A year of days as a grid, one square per day, shaded by how much was read.
 * The clearest way to see the shape of a reading habit.
 */
export function heatGrid(days, { label = 'Reading days' } = {}) {
  const cols = Math.ceil(days.length / 7);
  const cell = 11;
  const gap = 2;
  const width = cols * (cell + gap);
  const height = 7 * (cell + gap);

  const svg = frame(width, height, `${label}. ${days.filter((d) => d.value > 0).length} days with reading logged.`);
  const max = Math.max(...days.map((d) => d.value), 1);

  days.forEach((day, index) => {
    const col = Math.floor(index / 7);
    const row = index % 7;
    // Four steps, not a continuous ramp: a smooth gradient is impossible to
    // read back into a number at this size.
    const level = day.value === 0 ? 0 : Math.min(4, Math.ceil((day.value / max) * 4));

    svg.append(
      svgEl('rect', {
        x: col * (cell + gap), y: row * (cell + gap),
        width: cell, height: cell, rx: 2,
        class: `chart__heat chart__heat--${level}`,
      }, svgEl('title', {}, `${day.label}: ${day.value ? `${day.value} minutes` : 'nothing logged'}`))
    );
  });

  return svg;
}
