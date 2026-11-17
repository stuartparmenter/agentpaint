// A series: its paintings side by side, score curves faceted by model and
// colored by look setting, and the results table.

import { LineChart, legend, seriesClass } from "./chart.js";
import {
  attribution,
  el,
  fmtDate,
  fmtInt,
  fmtNum,
  fmtScore,
  fmtSeconds,
  getJson,
  idFromPath,
  loadReferences,
  loadSeriesKey,
  lookLabel,
  modelsLabel,
  snapshotUrl,
  statusBadge,
} from "./common.js";

const id = idFromPath();
const page = document.getElementById("page");
const crumbs = document.getElementById("crumbs");

const state = { series: null, strokes: new Map(), timer: null };
const ui = { facets: new Map() };

async function loadStrokes(paintings, onlyActive) {
  await Promise.all(
    paintings
      .filter((p) => !onlyActive || p.status === "active" || !state.strokes.has(p.id))
      .map(async (p) => {
        try {
          state.strokes.set(p.id, await getJson(`/api/paintings/${encodeURIComponent(p.id)}/strokes`));
        } catch {
          state.strokes.set(p.id, []);
        }
      }),
  );
}

async function init() {
  if (!id) return fail("No series id in the address.");
  try {
    state.series = await getJson(`/api/series/${encodeURIComponent(id)}`);
  } catch (e) {
    return fail(e.status === 404 ? "This series doesn't exist." : `Couldn't load the series (${e.message}).`);
  }
  await loadStrokes(state.series.paintings, false);
  crumbs.append(" / ", el("span", { textContent: `Series ${state.series.id}` }));
  build();
  render();
  page.removeAttribute("aria-busy");
  if (state.series.paintings.some((p) => p.status === "active")) state.timer = setInterval(refresh, 5000);
}

function fail(message) {
  page.removeAttribute("aria-busy");
  page.replaceChildren(
    el("p", { className: "error", textContent: message }),
    el("a", { href: "/", textContent: "Back to the gallery" }),
  );
}

async function refresh() {
  try {
    state.series = await getJson(`/api/series/${encodeURIComponent(id)}`);
    await loadStrokes(state.series.paintings, true);
    render();
    if (!state.series.paintings.some((p) => p.status === "active")) clearInterval(state.timer);
  } catch (e) {
    console.error("refresh failed", e);
  }
}

function build() {
  const s = state.series;
  ui.head = el("div", { className: "series-head" });
  ui.cards = el("div", { className: "series-grid" });
  ui.chartPanel = el("section", { className: "panel" });
  ui.chartIntro = el("p", { className: "small muted" });
  ui.legend = el("div");
  ui.facetsEl = el("div", { className: "facets" });
  ui.refNote = el("p", { className: "small muted" });
  ui.curveDetails = el("details", {}, [el("summary", { textContent: "Curve data as a table" })]);
  ui.curveDetails.addEventListener("toggle", () => {
    if (ui.curveDetails.open) renderCurveTable();
  });
  ui.chartPanel.append(
    el("h2", { textContent: "Score per stroke" }),
    ui.chartIntro,
    ui.legend,
    ui.facetsEl,
    ui.refNote,
    ui.curveDetails,
  );
  ui.tableBody = el("tbody");
  const resultsPanel = el("section", { className: "panel" }, [
    el("h2", { textContent: "Results" }),
    el("p", {
      className: "small muted",
      textContent:
        "One row per model and look setting; repeats are averaged. Final score is the last stroke's similarity to the reference.",
    }),
    el("div", { className: "table-wrap" }, [
      el("table", { className: "data" }, [
        el("caption", { className: "visually-hidden", textContent: "Series results" }),
        el("thead", {}, [
          el(
            "tr",
            {},
            [
              ["Models", ""],
              ["Strokes per look", "num"],
              ["Paintings", "num"],
              ["Finished", "num"],
              ["Final score", "num"],
              ["Strokes used", "num"],
              ["Looks", "num"],
              ["Mean think", "num"],
              ["Tokens in", "num"],
              ["Tokens out", "num"],
            ].map(([t, c]) => el("th", { scope: "col", className: c, textContent: t })),
          ),
        ]),
        ui.tableBody,
      ]),
    ]),
  ]);
  const cardsPanel = el("section", { className: "series-paintings" }, [
    el("h2", { className: "visually-hidden", textContent: "Paintings" }),
    ui.cards,
  ]);
  page.replaceChildren(
    el("div", { className: "series-page" }, [ui.head, cardsPanel, ui.chartPanel, resultsPanel]),
  );
  document.title = `Series ${s.id} · AgentPaint`;
}

/** Look settings in ascending order, each with a fixed categorical slot (past eight: "other"). */
function colorsBySetting(paintings) {
  const settings = [...new Set(paintings.map((p) => p.strokesPerLook))].sort((a, b) => a - b);
  return new Map(settings.map((spl, i) => [spl, i < 8 ? i + 1 : 0]));
}

function settingLabel(spl, paintings) {
  const same = paintings.filter((p) => p.strokesPerLook === spl);
  const oneLook = same.length > 0 && same.every((p) => spl >= p.maxStrokes);
  return `${spl} ${spl === 1 ? "stroke" : "strokes"} per look${oneLook ? " (one look)" : ""}`;
}

function render() {
  const s = state.series;
  const paintings = s.paintings;
  const colors = colorsBySetting(paintings);
  const key = loadSeriesKey(s.id);

  ui.head.replaceChildren(
    el("h2", { textContent: `Series ${s.id}` }),
    el("span", {
      className: "small muted",
      textContent: `${paintings.length} ${paintings.length === 1 ? "painting" : "paintings"} · started ${fmtDate(s.createdAt)}`,
    }),
    el("span", {
      className: "small muted",
      textContent: key
        ? "This browser can add paintings: use “Duplicate” on any painting's page."
        : "Only the browser that created this series can add paintings to it.",
    }),
  );

  // Cards.
  ui.cards.replaceChildren(
    ...paintings.map((p) => {
      const href = `/p/${encodeURIComponent(p.id)}`;
      const img = el("img", {
        src: snapshotUrl(p.id, p.strokeCount),
        alt: `${p.prompt ?? "Open subject"}, after ${p.strokeCount} strokes`,
        loading: "lazy",
        width: p.width,
        height: p.height,
      });
      img.style.aspectRatio = `${p.width} / ${p.height}`;
      const swatch = el("span", { className: `chart-key ${seriesClass(colors.get(p.strokesPerLook))}` });
      swatch.setAttribute("aria-hidden", "true");
      return el("article", { className: "series-card" }, [
        el("a", { href, tabIndex: -1, ariaHidden: "true" }, [img]),
        el("div", { className: "body" }, [
          el("div", { className: "title" }, [
            swatch,
            el("a", { href, textContent: p.prompt ?? "Open subject" }),
          ]),
          el("div", { className: "meta", textContent: `${modelsLabel(p.models)}` }),
          el("div", {
            className: "meta",
            textContent: `${lookLabel(p.strokesPerLook, p.maxStrokes)} · phases ${p.phases} · ${p.size ?? "pool"}`,
          }),
          el("div", {
            className: "meta",
            textContent: `${p.strokeCount}/${p.maxStrokes} strokes · ${fmtInt(p.looks)} ${p.looks === 1 ? "look" : "looks"}${p.reference ? ` · score ${fmtScore(p.lastScore)}` : ""}`,
          }),
          el("div", {}, [statusBadge(p.status)]),
        ]),
      ]);
    }),
  );

  renderCharts(paintings, colors);
  renderTable();
  if (ui.curveDetails.open) renderCurveTable();
}

function renderCharts(paintings, colors) {
  const scored = paintings.filter((p) => p.reference);
  ui.chartPanel.hidden = scored.length === 0;
  if (!scored.length) return;

  // Anchors are drawn only when every painting shares them (same reference and canvas).
  const first = scored[0];
  const shared =
    scored.length === paintings.length &&
    scored.every(
      (p) =>
        p.reference === first.reference &&
        p.blankScore === first.blankScore &&
        p.meanColorScore === first.meanColorScore,
    );
  const refs = [];
  if (shared && first.blankScore !== null) refs.push({ y: first.blankScore, label: "blank canvas" });
  if (shared && first.meanColorScore !== null)
    refs.push({ y: first.meanColorScore, label: "flat average color" });

  ui.chartIntro.textContent =
    "Similarity to the reference after each stroke, one chart per model, one line per painting colored by its look setting. Repeats share their setting's color.";
  ui.refNote.replaceChildren();
  if (shared) {
    ui.refNote.append("Dashed lines: the scores of a blank canvas and of one flat average color. ");
    loadReferences()
      .then((list) => {
        const r = list.find((x) => x.id === first.reference);
        if (r) ui.refNote.append("Reference: ", attribution(r));
      })
      .catch(() => {});
  } else {
    ui.refNote.append(
      "These paintings don't share one reference and canvas size, so no anchor lines are drawn.",
    );
  }

  const settings = [...colors.keys()].filter((spl) => scored.some((p) => p.strokesPerLook === spl));
  ui.legend.replaceChildren(
    settings.length > 1
      ? legend(settings.map((spl) => ({ color: colors.get(spl), label: settingLabel(spl, scored) })))
      : el("p", { className: "small muted", textContent: settingLabel(settings[0], scored) }),
  );

  const lines = new Map();
  for (const p of scored) {
    const points = [];
    if (p.blankScore !== null) points.push({ x: 0, y: p.blankScore });
    for (const st of state.strokes.get(p.id) ?? [])
      if (st.score !== null) points.push({ x: st.version, y: st.score });
    const model = modelsLabel(p.models);
    if (!lines.has(model)) lines.set(model, []);
    lines.get(model).push({
      id: p.id,
      label: `${settingLabel(p.strokesPerLook, scored)} · ${p.id}`,
      color: colors.get(p.strokesPerLook),
      points,
    });
  }
  const ys = [];
  for (const group of lines.values()) for (const l of group) for (const pt of l.points) ys.push(pt.y);
  for (const r of refs) ys.push(r.y);
  const yDomain = ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
  const xMax = Math.max(1, ...scored.map((p) => p.strokeCount));

  // Named models first, alphabetically; paintings that reported none come last.
  const unnamed = modelsLabel([]);
  const models = [...lines.keys()].sort(
    (a, b) => Number(a === unnamed) - Number(b === unnamed) || a.localeCompare(b),
  );
  for (const [model, facet] of ui.facets) {
    if (!lines.has(model)) {
      facet.root.remove();
      ui.facets.delete(model);
    }
  }
  const ordered = [];
  for (const model of models) {
    let facet = ui.facets.get(model);
    if (!facet) {
      const chart = new LineChart({
        label: `Score per stroke for ${model}`,
        xLabel: "stroke",
        height: 200,
        xTitle: (x) => (x === 0 ? "Blank canvas" : `Stroke ${x}`),
      });
      facet = {
        chart,
        root: el("div", { className: "facet" }, [el("h3", { textContent: model }), chart.root]),
      };
      ui.facets.set(model, facet);
    }
    const group = lines.get(model).sort((a, b) => a.color - b.color);
    facet.chart.setData({ series: group, refs, xMax, yDomain });
    ordered.push(facet.root);
  }
  ui.facetsEl.replaceChildren(...ordered);
}

function renderTable() {
  const rows = state.series.table.map((r) =>
    el("tr", {}, [
      el("td", { textContent: r.models }),
      el("td", { className: "num", textContent: String(r.strokes_per_look) }),
      el("td", { className: "num", textContent: fmtInt(r.paintings) }),
      el("td", { className: "num", textContent: fmtInt(r.finished) }),
      el("td", { className: "num", textContent: fmtScore(r.final_score) }),
      el("td", { className: "num", textContent: fmtNum(r.strokes_used) }),
      el("td", { className: "num", textContent: fmtNum(r.looks) }),
      el("td", { className: "num", textContent: fmtSeconds(r.mean_think_ms) }),
      el("td", { className: "num", textContent: fmtInt(r.tokens_in) }),
      el("td", { className: "num", textContent: fmtInt(r.tokens_out) }),
    ]),
  );
  if (!rows.length)
    rows.push(el("tr", {}, [el("td", { colSpan: 10, className: "muted", textContent: "No results yet." })]));
  ui.tableBody.replaceChildren(...rows);
}

/** The chart's table twin: one row per stroke, one column per painting. */
function renderCurveTable() {
  const scored = state.series.paintings.filter((p) => p.reference);
  const byPainting = scored.map((p) => {
    const m = new Map();
    if (p.blankScore !== null) m.set(0, p.blankScore);
    for (const st of state.strokes.get(p.id) ?? []) if (st.score !== null) m.set(st.version, st.score);
    return m;
  });
  const xMax = Math.max(0, ...scored.map((p) => p.strokeCount));
  const head = el("tr", {}, [
    el("th", { scope: "col", className: "num", textContent: "Stroke" }),
    ...scored.map((p) =>
      el("th", {
        scope: "col",
        className: "num wrap",
        textContent: `${modelsLabel(p.models)} · ${p.strokesPerLook}/look · ${p.id}`,
      }),
    ),
  ]);
  const body = [];
  for (let x = 0; x <= xMax; x++) {
    body.push(
      el("tr", {}, [
        el("th", { scope: "row", className: "num", textContent: String(x) }),
        ...byPainting.map((m) =>
          el("td", { className: "num", textContent: m.has(x) ? fmtScore(m.get(x)) : "" }),
        ),
      ]),
    );
  }
  const table = el("table", { className: "data" }, [
    el("caption", { className: "visually-hidden", textContent: "Score per stroke, by painting" }),
    el("thead", {}, [head]),
    el("tbody", {}, body),
  ]);
  const wrap = el("div", { className: "table-wrap" }, [table]);
  ui.curveDetails.querySelector(".table-wrap")?.remove();
  ui.curveDetails.append(wrap);
}

init();
