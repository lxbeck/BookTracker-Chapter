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

/* --- Shared hover read-out ------------------------------------------------- */

let readout = null;

function ensureReadout() {
  if (readout && document.body.contains(readout)) return readout;
  readout = document.createElement('div');
  readout.className = 'chart-readout';
  readout.hidden = true;
  document.body.append(readout);
  return readout;
}

/**
 * Make one mark readable on hover, focus and tap.
 *
 * @param {SVGElement} mark
 * @param {{label: string, value: string, note?: string}} content
 */
function attachReadout(mark, content) {
  const show = () => {
    const node = ensureReadout();
    node.replaceChildren();

    const label = document.createElement('strong');
    label.textContent = content.label;
    const value = document.createElement('span');
    value.textContent = content.value;
    node.append(label, value);

    if (content.note) {
      const note = document.createElement('em');
      note.textContent = content.note;
      node.append(note);
    }

    node.hidden = false;

    // Positioned against the mark rather than the pointer, so it doesn't
    // jitter and behaves identically from the keyboard.
    const box = mark.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      box.left + box.width / 2 - own.width / 2,
      window.innerWidth - own.width - 8
    ));
    const above = box.top - own.height - 10;
    node.style.left = `${Math.round(left + window.scrollX)}px`;
    node.style.top = `${Math.round((above > 8 ? above : box.bottom + 10) + window.scrollY)}px`;
  };

  const hide = () => {
    if (readout) readout.hidden = true;
  };

  mark.addEventListener('mouseenter', show);
  mark.addEventListener('mouseleave', hide);
  mark.addEventListener('focus', show);
  mark.addEventListener('blur', hide);
  mark.addEventListener('click', show);

  mark.setAttribute('tabindex', '0');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', `${content.label}: ${content.value}${content.note ? `, ${content.note}` : ''}`);
  mark.classList.add('chart__mark');

  return mark;
}

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

/** Roughly the width of one character at the 10px axis size. */
const LABEL_CHAR_W = 5.6;

/**
 * A label under a bar, nudged inside the frame at the ends.
 *
 * A centred label on the first or last bar hangs half its width off the side
 * of the chart, where the panel clips it.
 */
function axisLabel(text, centre, y, width) {
  const half = (String(text).length * LABEL_CHAR_W) / 2;
  const anchor = centre - half < 2 ? 'start' : centre + half > width - 2 ? 'end' : 'middle';
  const x = anchor === 'start' ? 2 : anchor === 'end' ? width - 2 : centre;

  return svgEl('text', { x, y, class: 'chart__label', 'text-anchor': anchor }, text);
}

/**
 * Vertical bars. The workhorse: books per month, pages per month.
 * @param {{label: string, value: number}[]} data
 */
export function barChart(
  data,
  {
    height = 190,
    label = 'Bar chart',
    format = (v) => v,
    // As with the line chart: the readout can afford "4 books", the axis
    // cannot. A right-anchored label at a fixed 34px inset ran straight off
    // the left edge of the panel.
    axisFormat = (v) => v.toLocaleString(),
  } = {}
) {
  const width = 640;

  const max = niceMax(Math.max(...data.map((d) => d.value), 0));

  const axisLabels = [0, 0.5, 1].map((fraction) => axisFormat(Math.round(max * fraction)));
  const gutter = Math.max(...axisLabels.map((text) => text.length)) * 6.2 + 12;

  const padding = { top: 16, right: 8, bottom: 30, left: Math.max(34, Math.ceil(gutter)) };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const slot = plotW / Math.max(data.length, 1);
  const barW = Math.min(slot * 0.62, 46);

  // How often a bar can afford to carry its own label.
  //
  // Twelve months fit twelve labels; ninety days do not, and the chart drew
  // all ninety anyway — "2 3 4 5 6" ran together into a grey smear along the
  // bottom that read as damage rather than as dates. Labels are dropped rather
  // than shrunk, because there is no font size at which ninety dates are
  // legible in 600 pixels, and the readout still gives the exact day for any
  // bar you point at.
  const widest = Math.max(...data.map((d) => String(d.label).length), 1) * LABEL_CHAR_W;
  const every = Math.max(1, Math.ceil((widest + 8) / slot));

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
      }, axisFormat(Math.round(max * fraction)))
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

    // A full-height hit area. A two-pixel bar for a quiet month is effectively
    // impossible to hover, and that is exactly the month worth inspecting.
    const hit = svgEl('rect', {
      x: padding.left + slot * index, y: padding.top,
      width: slot, height: plotH, class: 'chart__hit',
    });
    attachReadout(hit, {
      label: point.fullLabel ?? point.label,
      value: format(point.value),
      note: point.note,
    });
    svg.append(hit);

    // Counted back from the last bar, so the most recent day is always named:
    // a run of dates ending on an unlabelled one leaves you counting forwards
    // from a label to work out where "today" is.
    if ((data.length - 1 - index) % every === 0) {
      svg.append(axisLabel(point.label, x + barW / 2, height - 10, width));
    }
  });

  return svg;
}

/**
 * A cumulative line — pages read over time. Area fill under it, because the
 * total is the point, not the individual readings.
 */
export function lineChart(
  data,
  {
    height = 190,
    label = 'Line chart',
    format = (v) => v,
    // The axis gets its own formatter, and a bare number by default.
    // The hover readout says "1,000 pages" because it has room to; the axis
    // was using the same string, and a right-anchored "1,000 pages" at a
    // fixed 40px inset simply ran off the left edge of the chart.
    axisFormat = (v) => v.toLocaleString(),
  } = {}
) {
  const width = 640;

  const svg = frame(width, height, `${label}. Ends at ${format(data.at(-1)?.value ?? 0)}.`);
  if (data.length < 2) return svg;

  const max = niceMax(Math.max(...data.map((d) => d.value)));

  // Measured from the widest label rather than assumed, so the gutter grows
  // with the numbers instead of clipping them. ~6.2px per character at the
  // axis size, which is monospaced.
  const axisLabels = [0, 0.5, 1].map((fraction) => axisFormat(Math.round(max * fraction)));
  const gutter = Math.max(...axisLabels.map((text) => text.length)) * 6.2 + 12;

  const padding = { top: 16, right: 10, bottom: 30, left: Math.max(40, Math.ceil(gutter)) };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const x = (i) => padding.left + (plotW * i) / (data.length - 1);
  const y = (v) => padding.top + plotH - (max ? (v / max) * plotH : 0);

  for (const fraction of [0, 0.5, 1]) {
    const gy = padding.top + plotH * (1 - fraction);
    svg.append(
      svgEl('line', { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, class: 'chart__grid' }),
      svgEl('text', { x: padding.left - 6, y: gy + 4, class: 'chart__axis', 'text-anchor': 'end' },
        axisFormat(Math.round(max * fraction)))
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

  // Only first, middle and last get axis labels; every tick would be
  // unreadable — which is exactly why every point is hoverable for its full
  // date. "07-04" on an axis is not a date anyone can read at a glance.
  for (const index of [0, Math.floor((data.length - 1) / 2), data.length - 1]) {
    svg.append(svgEl('text', {
      x: x(index), y: height - 10, class: 'chart__label',
      'text-anchor': index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle',
    }, data[index].label));
  }

  const columnW = plotW / (data.length - 1);

  data.forEach((point, index) => {
    const dot = svgEl('circle', { cx: x(index), cy: y(point.value), r: 3, class: 'chart__dot' });

    const hit = svgEl('rect', {
      x: x(index) - columnW / 2, y: padding.top,
      width: columnW, height: plotH, class: 'chart__hit',
    });
    attachReadout(hit, {
      label: point.fullLabel ?? point.label,
      value: format(point.value),
      note: point.note,
    });

    for (const [event, method] of [['mouseenter', 'add'], ['mouseleave', 'remove'], ['focus', 'add'], ['blur', 'remove']]) {
      hit.addEventListener(event, () => dot.classList[method]('is-on'));
    }

    svg.append(hit, dot);
  });

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
    const barW = Math.max(((width - labelW - 60) * row.value) / max, 2);

    // Every bar the same solid colour says only "which of these is biggest",
    // which you can already see from the order. Shading the finished portion
    // answers the question actually being asked of a shelf or a kind: how much
    // of this have I read?
    const done = Math.min(row.done ?? 0, row.value);
    const doneW = row.value ? (barW * done) / row.value : 0;

    const bar = svgEl('rect', {
      x: labelW, y: y + 3, width: barW, height: 14, rx: 1,
      class: done ? 'chart__bar chart__bar--part' : 'chart__bar',
    });

    const readout = row.done == null
      ? { label: row.label, value: format(row.value) }
      : { label: row.label, value: `${format(row.value)} \u00b7 ${done} finished` };

    attachReadout(bar, readout);

    const finished = doneW > 0
      ? svgEl('rect', {
          x: labelW, y: y + 3, width: Math.max(doneW, 2), height: 14, rx: 1,
          class: 'chart__bar chart__bar--done',
        })
      : null;
    if (finished) attachReadout(finished, readout);

    svg.append(
      svgEl('text', { x: 0, y: y + 14, class: 'chart__row-label' },
        row.label.length > 24 ? `${row.label.slice(0, 23)}\u2026` : row.label),
      bar,
      ...(finished ? [finished] : []),
      svgEl('text', { x: labelW + barW + 8, y: y + 14, class: 'chart__axis' },
        row.done ? `${format(row.value)} (${done})` : format(row.value))
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

    const value = day.value ? `${day.value} minutes` : 'nothing logged';
    const square = svgEl('rect', {
      x: col * (cell + gap), y: row * (cell + gap),
      width: cell, height: cell, rx: 2,
      class: `chart__heat chart__heat--${level}`,
    }, svgEl('title', {}, `${day.fullLabel ?? day.label}: ${value}`));

    attachReadout(square, { label: day.fullLabel ?? day.label, value, note: day.note });
    svg.append(square);
  });

  return svg;
}
