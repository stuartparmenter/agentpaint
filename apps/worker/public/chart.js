// Inline-SVG line chart: hairline grid, one y-axis, labeled reference lines,
// optional vertical boundaries and a position marker, and a crosshair tooltip
// that lists every series at the hovered x. Colors come from CSS classes
// (`series-1` … `series-8`, `series-other`) so light and dark themes swap in CSS.

import { el } from "./common.js";

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Round tick values covering [lo, hi], about `count` of them. */
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step)
    ticks.push(Number(t.toFixed(10)));
  return ticks;
}

const decimalsFor = (ticks) => {
  if (ticks.length < 2) return 2;
  const step = Math.abs(ticks[1] - ticks[0]);
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
};

/** Last point of a sorted series at or before x (a stroke's score holds until the next stroke). */
function valueAt(points, x) {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || points[0].x > x) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].x <= x) lo = mid;
    else hi = mid - 1;
  }
  return points[lo];
}

export class LineChart {
  /**
   * @param {object} options
   * @param {string} options.label accessible name of the plot
   * @param {string} options.xLabel axis caption
   * @param {(v: number) => string} [options.yFormat]
   * @param {(x: number) => string} [options.xTitle] tooltip heading for an x value
   * @param {(x: number) => void} [options.onPick] click or Enter on an x
   * @param {number} [options.height] plot height in px
   */
  constructor(options) {
    this.options = { height: 220, yFormat: (v) => v.toFixed(2), xTitle: (x) => `Stroke ${x}`, ...options };
    this.data = { series: [], refs: [], boundaries: [], marker: null, xMax: 1 };
    this.hoverX = null;
    this.svg = svg("svg", { class: "chart-svg", tabindex: 0, role: "img" });
    this.svg.setAttribute(
      "aria-label",
      `${options.label}. Use the left and right arrow keys to read values.`,
    );
    this.tooltip = el("div", { className: "chart-tooltip", hidden: true });
    this.tooltip.setAttribute("role", "status");
    this.root = el("div", { className: "chart" }, [this.svg, this.tooltip]);
    this.width = 0;

    new ResizeObserver(() => {
      const w = Math.round(this.root.clientWidth);
      if (w && w !== this.width) {
        this.width = w;
        this.render();
      }
    }).observe(this.root);

    this.svg.addEventListener("pointermove", (e) => this.hover(this.xFromEvent(e)));
    this.svg.addEventListener("pointerleave", () => {
      if (document.activeElement !== this.svg) this.hover(null);
    });
    this.svg.addEventListener("click", (e) => {
      const x = this.xFromEvent(e);
      if (x !== null) this.options.onPick?.(x);
    });
    this.svg.addEventListener("blur", () => this.hover(null));
    this.svg.addEventListener("focus", () => {
      if (this.hoverX === null) this.hover(this.data.marker ?? this.data.xMax);
    });
    this.svg.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const x = this.hoverX ?? this.data.marker ?? this.data.xMax;
      let next = null;
      if (e.key === "ArrowLeft") next = x - step;
      else if (e.key === "ArrowRight") next = x + step;
      else if (e.key === "Home") next = this.xMin();
      else if (e.key === "End") next = this.data.xMax;
      else if ((e.key === "Enter" || e.key === " ") && this.hoverX !== null) {
        e.preventDefault();
        this.options.onPick?.(this.hoverX);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      this.hover(Math.max(this.xMin(), Math.min(this.data.xMax, next)));
    });
  }

  /** Replaces the plotted data and redraws. */
  setData(data) {
    this.data = { ...this.data, ...data };
    this.render();
  }

  /** Moves the position marker without changing the data. */
  setMarker(x) {
    this.data.marker = x;
    if (!this.layout) return;
    const { sx, top, bottom } = this.layout;
    if (x === null || x === undefined) {
      this.markerLine.setAttribute("visibility", "hidden");
    } else {
      this.markerLine.setAttribute("visibility", "visible");
      this.markerLine.setAttribute("x1", sx(x));
      this.markerLine.setAttribute("x2", sx(x));
      this.markerLine.setAttribute("y1", top);
      this.markerLine.setAttribute("y2", bottom);
    }
  }

  xMin() {
    let min = Infinity;
    for (const s of this.data.series) if (s.points.length) min = Math.min(min, s.points[0].x);
    return Number.isFinite(min) ? min : 0;
  }

  xFromEvent(e) {
    if (!this.layout) return null;
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { left, right, sxInv } = this.layout;
    if (px < left - 8 || px > right + 8) return null;
    const x = Math.round(sxInv(Math.max(left, Math.min(right, px))));
    return Math.max(this.xMin(), Math.min(this.data.xMax, x));
  }

  render() {
    const width = this.width || Math.round(this.root.clientWidth) || 600;
    const { series, refs, boundaries, xMax } = this.data;
    const { height } = this.options;
    const margin = { top: 14, right: 14, bottom: 34, left: 48 };
    const total = height + margin.top + margin.bottom;
    this.svg.replaceChildren();
    this.svg.setAttribute("viewBox", `0 0 ${width} ${total}`);
    this.svg.setAttribute("width", width);
    this.svg.setAttribute("height", total);

    const ys = [];
    for (const s of series) for (const p of s.points) ys.push(p.y);
    for (const r of refs) ys.push(r.y);
    // A shared domain keeps small multiples on one scale.
    if (this.data.yDomain) ys.push(...this.data.yDomain);
    if (!series.some((s) => s.points.length)) {
      this.layout = null;
      const t = svg("text", { x: width / 2, y: total / 2, "text-anchor": "middle", class: "chart-empty" });
      t.textContent = "No scores yet";
      this.svg.append(t);
      return;
    }
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    const pad = Math.max((hi - lo) * 0.08, 0.005);
    lo -= pad;
    hi += pad;
    const yTicks = niceTicks(lo, hi, Math.max(3, Math.round(height / 50)));
    lo = Math.min(lo, yTicks[0]);
    hi = Math.max(hi, yTicks[yTicks.length - 1]);
    const decimals = decimalsFor(yTicks);

    const left = margin.left;
    const right = width - margin.right;
    const top = margin.top;
    const bottom = margin.top + height;
    const x0 = Math.min(0, this.xMin());
    const x1 = Math.max(xMax, x0 + 1);
    const sx = (x) => left + ((x - x0) / (x1 - x0)) * (right - left);
    const sxInv = (px) => x0 + ((px - left) / (right - left)) * (x1 - x0);
    const sy = (y) => bottom - ((y - lo) / (hi - lo)) * (bottom - top);
    this.layout = { left, right, top, bottom, sx, sxInv, sy };

    const grid = svg("g", { class: "chart-grid" });
    const labels = svg("g", { class: "chart-axis" });
    for (const t of yTicks) {
      const y = sy(t);
      if (y < top - 0.5 || y > bottom + 0.5) continue;
      grid.append(svg("line", { x1: left, x2: right, y1: y, y2: y }));
      const text = svg("text", { x: left - 8, y: y + 4, "text-anchor": "end" });
      text.textContent = t.toFixed(decimals);
      labels.append(text);
    }
    const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor((right - left) / 70))).filter(
      (t) => Number.isInteger(t) && t >= x0 && t <= x1,
    );
    for (const t of xTicks) {
      const text = svg("text", { x: sx(t), y: bottom + 18, "text-anchor": "middle" });
      text.textContent = String(t);
      labels.append(text);
    }
    const caption = svg("text", { x: right, y: bottom + 32, "text-anchor": "end", class: "chart-caption" });
    caption.textContent = this.options.xLabel;
    labels.append(caption);
    this.svg.append(grid);

    if (boundaries?.length) {
      const g = svg("g", { class: "chart-boundaries" });
      for (const b of boundaries) {
        const x = sx(b);
        g.append(svg("line", { x1: x, x2: x, y1: top, y2: bottom }));
      }
      this.svg.append(g);
    }

    this.svg.append(svg("line", { class: "chart-baseline", x1: left, x2: right, y1: bottom, y2: bottom }));
    this.svg.append(labels);

    // Reference lines, each labeled directly at its right end, above the line. Curves
    // start at the blank-canvas score, so the left end is where they crowd the anchors.
    const refGroup = svg("g", { class: "chart-refs" });
    const placed = [];
    for (const r of [...refs].sort((a, b) => b.y - a.y)) {
      const y = sy(r.y);
      refGroup.append(svg("line", { x1: left, x2: right, y1: y, y2: y }));
      let ly = y - 5;
      // Keep two close reference labels from overlapping.
      for (const p of placed) if (Math.abs(p - ly) < 13) ly = p + 13;
      placed.push(ly);
      const text = svg("text", { x: right - 6, y: ly, "text-anchor": "end", class: "chart-ref-label" });
      text.textContent = `${r.label} ${this.options.yFormat(r.y)}`;
      refGroup.append(text);
    }
    this.svg.append(refGroup);

    const lines = svg("g", { class: "chart-lines" });
    for (const s of series) {
      if (!s.points.length) continue;
      const d = s.points
        .map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
        .join("");
      lines.append(svg("path", { d, class: `chart-line ${seriesClass(s.color)}${s.thin ? " thin" : ""}` }));
      if (s.points.length === 1) {
        const p = s.points[0];
        lines.append(
          svg("circle", { cx: sx(p.x), cy: sy(p.y), r: 3, class: `chart-dot ${seriesClass(s.color)}` }),
        );
      }
    }
    this.svg.append(lines);

    this.markerLine = svg("line", { class: "chart-marker", visibility: "hidden" });
    this.svg.append(this.markerLine);
    this.setMarker(this.data.marker);

    this.cross = svg("g", { class: "chart-cross", visibility: "hidden" });
    this.crossLine = svg("line", { y1: top, y2: bottom });
    this.cross.append(this.crossLine);
    this.crossDots = series.map((s) => {
      const dot = svg("circle", { r: 4, class: `chart-hover-dot ${seriesClass(s.color)}` });
      this.cross.append(dot);
      return dot;
    });
    this.svg.append(this.cross);
    if (this.hoverX !== null) this.hover(this.hoverX);
  }

  hover(x) {
    this.hoverX = x;
    if (x === null || !this.layout) {
      this.cross?.setAttribute("visibility", "hidden");
      this.tooltip.hidden = true;
      return;
    }
    const { sx, sy, top, right, left } = this.layout;
    const { series } = this.data;
    const cx = sx(x);
    this.cross.setAttribute("visibility", "visible");
    this.crossLine.setAttribute("x1", cx);
    this.crossLine.setAttribute("x2", cx);

    const rows = [];
    series.forEach((s, i) => {
      const p = valueAt(s.points, x);
      const exact = p && p.x === x;
      const dot = this.crossDots[i];
      // A series that hasn't reached x shows its last value; one that ended earlier keeps its final value.
      if (p) {
        dot.setAttribute("visibility", "visible");
        dot.setAttribute("cx", exact ? cx : sx(p.x));
        dot.setAttribute("cy", sy(p.y));
      } else {
        dot.setAttribute("visibility", "hidden");
      }
      rows.push({ s, p, exact });
    });

    const body = [el("div", { className: "chart-tooltip-title", textContent: this.options.xTitle(x) })];
    const shown = rows.filter((r) => r.p).sort((a, b) => b.p.y - a.p.y);
    for (const { s, p, exact } of shown) {
      const key = el("span", { className: `chart-key ${seriesClass(s.color)}` });
      key.setAttribute("aria-hidden", "true");
      body.push(
        el("div", { className: "chart-tooltip-row" }, [
          key,
          el("strong", { textContent: this.options.yFormat(p.y) }),
          el("span", {
            className: "chart-tooltip-label",
            textContent: `${s.label ?? ""}${exact ? "" : ` (at ${p.x})`}`,
          }),
        ]),
      );
    }
    if (!shown.length) body.push(el("div", { className: "chart-tooltip-label", textContent: "No score" }));
    if (this.options.extra) {
      const extra = this.options.extra(x);
      if (extra) body.push(extra);
    }
    this.tooltip.replaceChildren(...body);
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const flip = cx + 14 + tw > right && cx - 14 - tw >= 0;
    const leftPx = flip ? cx - 14 - tw : Math.min(cx + 14, Math.max(left, this.width - tw));
    this.tooltip.style.left = `${Math.max(0, leftPx)}px`;
    this.tooltip.style.top = `${top}px`;
  }
}

export function seriesClass(color) {
  return color >= 1 && color <= 8 ? `series-${color}` : "series-other";
}

/** A legend of line keys; text stays in text colors, the key carries the hue. */
export function legend(items) {
  const list = el("ul", { className: "chart-legend" });
  for (const item of items) {
    const key = el("span", { className: `chart-key ${seriesClass(item.color)}` });
    key.setAttribute("aria-hidden", "true");
    list.append(el("li", {}, [key, el("span", { textContent: item.label })]));
  }
  return list;
}
