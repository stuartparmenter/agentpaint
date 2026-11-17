// Reference tests. `/tests` lists one card per reference; `/tests/<reference>`
// compares the runs made against one reference under one condition: results
// table, score charts per strokes-per-assignment setting, final canvases, and a form
// to start a run.

import { LineChart, legend, seriesClass } from "./chart.js";
import {
  anchorRefs,
  assignmentLabel,
  assignmentTitle,
  attribution,
  el,
  fail,
  fmtInt,
  fmtNum,
  fmtScore,
  fmtSeconds,
  getJson,
  poll,
  snapshotUrl,
  table,
} from "./common.js";
import { createForm } from "./create-form.js";

const page = document.getElementById("page");
const referenceId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "");
// The results table's model label for runs whose painter reported no model.
const UNREPORTED = "(not reported)";

const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const backToTests = (message) => fail(message, "/tests", "All reference tests");
const isActive = (p) => p.status === "active";

// ---------------------------------------------------------------- index

async function showIndex() {
  let tests;
  try {
    tests = await getJson("/api/tests");
  } catch (e) {
    return backToTests(`Couldn't load the tests (${e.message}).`);
  }
  const cards = tests.map((t) => {
    const r = t.reference;
    const href = `/tests/${encodeURIComponent(r.id)}`;
    const img = el("img", { src: r.file, alt: r.title, width: r.width, height: r.height, loading: "lazy" });
    const imageLink = el("a", { href, tabIndex: -1 }, [img]);
    imageLink.setAttribute("aria-hidden", "true");
    return el("article", { className: "test-card" }, [
      imageLink,
      el("div", { className: "body" }, [
        el("h3", {}, [el("a", { href, textContent: r.title })]),
        el("p", {
          className: "muted",
          textContent: `${plural(t.runs, "run")} · ${plural(t.models.length, "model")}`,
        }),
        el("p", {
          textContent:
            t.best === null
              ? "No finished runs yet"
              : `Best finished score ${fmtScore(t.best.score, t.best.blankScore)}`,
        }),
        el("p", { className: "small muted" }, [attribution(r)]),
      ]),
    ]);
  });
  page.replaceChildren(
    el("div", { className: "tests-intro" }, [
      el("h2", { textContent: "Reference tests" }),
      el("p", {
        className: "small muted",
        textContent:
          "Each test gives agents a fixed image to paint toward and scores every stroke by its similarity to it, so models and strokes-per-assignment settings can be compared on the same target.",
      }),
    ]),
    el("div", { className: "test-grid" }, cards),
  );
  page.removeAttribute("aria-busy");
}

// ---------------------------------------------------------------- one test

const ui = { charts: new Map() };

function apiUrl() {
  const q = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  for (const k of ["condition", "series"]) if (q.get(k)) params.set(k, q.get(k));
  return `/api/tests/${encodeURIComponent(referenceId)}${params.size ? `?${params}` : ""}`;
}

/** Navigates to this test with one query parameter set (or removed with null). */
function goWith(key, value) {
  const q = new URLSearchParams(location.search);
  if (value === null) q.delete(key);
  else q.set(key, value);
  location.assign(`${location.pathname}${q.size ? `?${q}` : ""}`);
}

function conditionLabel(c) {
  return `${capitalize(c.style)} · ${c.size} ${c.width}×${c.height} · ${c.maxStrokes} strokes · ${plural(c.runs, "run")}`;
}

const selectedCondition = (data) => data.conditions.find((c) => c.key === data.condition) ?? null;

/** The table's model labels in a fixed order (alphabetical, "not reported" last), each with a categorical slot. */
function modelColors(table) {
  const named = [...new Set(table.map((c) => c.models))]
    .filter((m) => m !== UNREPORTED)
    .sort((a, b) => a.localeCompare(b));
  const colors = new Map(named.map((m, i) => [m, i < 8 ? i + 1 : 0]));
  if (table.some((c) => c.models === UNREPORTED)) colors.set(UNREPORTED, 0);
  return colors;
}

async function showTest() {
  let data;
  try {
    data = await getJson(apiUrl());
  } catch (e) {
    return backToTests(
      e.status === 404 ? "No such reference test." : `Couldn't load the test (${e.message}).`,
    );
  }
  document.title = `${data.reference.title} · Reference tests · AgentPaint`;
  const condition = selectedCondition(data);

  ui.lanesPanel = el("section", { className: "panel" });
  ui.lanes = el("div", { className: "lanes" });
  ui.tableSummary = el("summary", { textContent: "Table view" });
  ui.tableView = el("details", {}, [ui.tableSummary]);
  ui.lanesPanel.append(
    el("h2", { textContent: "Results by model" }),
    el("p", {
      className: "small muted",
      textContent:
        "One lane per model, one column per strokes-per-assignment setting. Each assignment shows the agent the canvas and allows a number of strokes; the settings differ in that number (hover a column title for details). Each run shows its final canvas (linked to its playback) and numbers; repeated runs sit together in their cell.",
    }),
    ui.lanes,
    ui.tableView,
  );
  ui.chartsPanel = el("section", { className: "panel" });
  page.replaceChildren(
    el("div", { className: "test-page" }, [
      header(data, condition),
      ui.lanesPanel,
      ui.chartsPanel,
      startPanel(data, condition),
    ]),
  );
  renderRuns(data, condition);
  page.removeAttribute("aria-busy");

  if (data.paintings.some(isActive)) {
    const stopPolling = poll(async () => {
      try {
        const next = await getJson(apiUrl());
        renderRuns(next, selectedCondition(next));
        if (!next.paintings.some(isActive)) stopPolling();
      } catch (e) {
        console.error("refresh failed", e);
      }
    }, 5000);
  }
}

/** Reference image, what the anchors mean, the condition selector and the series chip. */
function header(data, condition) {
  const r = data.reference;
  const { blank, meanColor } = data.anchors;
  const anchors =
    blank !== null && meanColor !== null
      ? `Every stroke is scored by its similarity to this image: 0 is a blank canvas, 1 is identical. For scale, a canvas painted one flat average color scores ${fmtScore(meanColor, blank)}.`
      : "Every stroke is scored by its similarity to this image: 0 is a blank canvas, 1 is identical.";
  const text = [
    el("h2", { textContent: r.title }),
    el("p", { className: "small muted", textContent: anchors }),
  ];

  if (data.conditions.length > 1) {
    const select = el(
      "select",
      { id: "condition" },
      data.conditions.map((c) => el("option", { value: c.key, textContent: conditionLabel(c) })),
    );
    select.value = data.condition;
    select.addEventListener("change", () => goWith("condition", select.value));
    text.push(
      el("div", { className: "field" }, [
        el("label", { htmlFor: "condition", textContent: "Condition" }),
        select,
      ]),
    );
  } else if (condition) {
    text.push(el("p", { className: "small", textContent: `Condition: ${conditionLabel(condition)}` }));
  } else {
    text.push(el("p", { className: "small", textContent: "No runs yet. Start one below." }));
  }
  if (data.series) {
    const clear = el("button", { type: "button", className: "chip-clear", textContent: "×" });
    clear.setAttribute("aria-label", "Show all runs");
    clear.addEventListener("click", () => goWith("series", null));
    text.push(
      el("p", { className: "chip" }, [
        el("span", { textContent: `Showing one batch of runs (series ${data.series})` }),
        clear,
      ]),
    );
  }

  const img = el("img", {
    className: "canvas-img",
    src: r.file,
    alt: `Reference: ${r.title}`,
    width: r.width,
    height: r.height,
  });
  return el("section", { className: "test-head" }, [
    el("figure", { className: "canvas" }, [
      img,
      el("figcaption", { className: "small muted" }, [attribution(r)]),
    ]),
    el("div", { className: "test-head-text" }, text),
  ]);
}

/** Model lanes, the table view and the score charts; rebuilt on refresh. */
function renderRuns(data, condition) {
  for (const section of [ui.lanesPanel, ui.chartsPanel]) section.hidden = data.paintings.length === 0;
  if (!data.paintings.length) return;
  const max = condition?.maxStrokes ?? 1;
  const byId = new Map(data.paintings.map((p) => [p.id, p]));
  // Each table cell's runs, best score first.
  const cells = data.table.map((cell) => ({
    ...cell,
    runs: cell.painting_ids
      .map((id) => byId.get(id))
      .sort((a, b) => (b.lastScore ?? -1) - (a.lastScore ?? -1)),
  }));
  const colors = modelColors(cells);
  const models = [...colors.keys()];
  const settings = [...new Set(cells.map((c) => c.strokes_per_assignment))].sort((a, b) => a - b);
  renderLanes(data, cells, colors, models, settings, max);
  renderTableView(data, cells, models, max);
  renderCharts(data, cells, colors, models, settings, max);
}

/** One lane per model: a cell per strokes-per-assignment setting holding that model's runs. */
function renderLanes(data, cells, colors, models, settings, max) {
  ui.lanes.replaceChildren(
    ...models.map((m) => {
      const row = el("div", { className: "lane-cells" });
      row.style.setProperty("--cols", String(settings.length));
      for (const spl of settings) {
        const cell = cells.find((c) => c.models === m && c.strokes_per_assignment === spl);
        const runs = cell?.runs ?? [];
        const children = [assignmentTitle("h4", spl, max)];
        if (!runs.length) children.push(el("p", { className: "small muted", textContent: "No run" }));
        if (runs.length > 1) {
          children.push(
            el("p", {
              className: "small",
              textContent: `Mean ${fmtScore(cell.final_score, data.anchors.blank)} over ${plural(runs.length, "run")}`,
            }),
          );
        }
        for (const p of runs) children.push(runItem(p, m, assignmentLabel(spl, max)));
        row.append(el("div", { className: "lane-cell" }, children));
      }
      const key = el("span", { className: "lane-key" });
      key.setAttribute("aria-hidden", "true");
      const lane = el("section", { className: "lane" }, [
        el("h3", { className: "lane-head" }, [key, m]),
        row,
      ]);
      lane.setAttribute("aria-label", m);
      // The lane's stripe and dot take the model's chart color; its name stays in text color.
      lane.style.setProperty("--lane", `var(--${seriesClass(colors.get(m))})`);
      return lane;
    }),
  );
}

function runItem(p, model, setting) {
  const thumb = el("img", {
    className: "thumb",
    src: snapshotUrl(p.id, p.strokeCount),
    alt: `${model}, ${setting}: canvas after ${p.strokeCount} strokes`,
    width: p.width,
    height: p.height,
    loading: "lazy",
  });
  return el("div", { className: "run" }, [
    el("a", { href: `/p/${encodeURIComponent(p.id)}` }, [thumb]),
    el("div", { className: "run-score" }, [
      el("strong", { textContent: fmtScore(p.lastScore, p.blankScore) }),
      isActive(p) ? el("span", { className: "badge active", textContent: "painting" }) : null,
    ]),
    el("div", {
      className: "small muted",
      textContent: `${p.strokeCount}/${p.maxStrokes} strokes · ${plural(p.assignments, "assignment")} · ${fmtSeconds(p.meanThinkMs)} think`,
    }),
    el("div", {
      className: "small muted",
      textContent: `${fmtInt(p.tokensIn)} in / ${fmtInt(p.tokensOut)} out tokens`,
    }),
  ]);
}

/** The lanes' numbers as one table (model, then strokes per assignment), for screen readers and copying. */
function renderTableView(data, cells, models, max) {
  const rows = [...cells]
    .sort(
      (a, b) =>
        models.indexOf(a.models) - models.indexOf(b.models) ||
        a.strokes_per_assignment - b.strokes_per_assignment,
    )
    .map((r) =>
      el("tr", {}, [
        el("td", { textContent: r.models }),
        el("td", { textContent: assignmentLabel(r.strokes_per_assignment, max) }),
        ...[
          fmtInt(r.paintings),
          fmtInt(r.finished),
          fmtScore(r.final_score, data.anchors.blank),
          fmtNum(r.strokes_used),
          fmtNum(r.assignments),
          fmtSeconds(r.mean_think_ms),
          fmtInt(r.tokens_in),
          fmtInt(r.tokens_out),
        ].map((v) => el("td", { className: "num", textContent: v })),
      ]),
    );
  ui.tableView.replaceChildren(
    ui.tableSummary,
    table(
      "Results by model and strokes per assignment; repeated runs averaged",
      [
        ["Model", ""],
        ["Strokes per assignment", ""],
        ["Runs", "num"],
        ["Finished", "num"],
        ["Final score", "num"],
        ["Strokes used", "num"],
        ["Assignments", "num"],
        ["Mean think", "num"],
        ["Tokens in", "num"],
        ["Tokens out", "num"],
      ],
      rows,
    ),
  );
}

/** One chart per strokes-per-assignment setting, one line per run colored by model, on one y-scale. */
function renderCharts(data, cells, colors, models, settings, max) {
  const { refs, curve } = anchorRefs(data.anchors.blank, data.anchors.meanColor);
  const points = (p) => curve(data.curves[p.id] ?? []);
  const ys = refs.map((r) => r.y);
  for (const cell of cells) for (const p of cell.runs) for (const pt of points(p)) ys.push(pt.y);
  const yDomain = [Math.min(...ys), Math.max(...ys)];
  const facets = settings.map((spl) => {
    const title = assignmentLabel(spl, max);
    let chart = ui.charts.get(spl);
    if (!chart) {
      chart = new LineChart({
        label: `Score per stroke, ${title}`,
        xLabel: "stroke",
        height: 200,
        xTitle: (x) => (x === 0 ? "Blank canvas" : `Stroke ${x}`),
      });
      ui.charts.set(spl, chart);
    }
    // Cells are in model order; a model's repeated runs are thin lines labeled by id.
    const series = cells
      .filter((c) => c.strokes_per_assignment === spl)
      .sort((a, b) => models.indexOf(a.models) - models.indexOf(b.models))
      .flatMap((c) =>
        c.runs.map((p) => ({
          id: p.id,
          label: c.runs.length > 1 ? `${c.models} · ${p.id}` : c.models,
          color: colors.get(c.models),
          thin: c.runs.length > 1,
          points: points(p),
        })),
      );
    chart.setData({ series, refs, xMax: max, yDomain });
    return el("div", { className: "facet" }, [assignmentTitle("h3", spl, max), chart.root]);
  });
  ui.chartsPanel.replaceChildren(
    el("h2", { textContent: "Score per stroke" }),
    el("p", {
      className: "small muted",
      textContent:
        "One chart per strokes-per-assignment setting, one line per run, colored by model; repeated runs of a model are thin lines in its color. Dashed lines are the blank-canvas and flat-color scores.",
    }),
    legend(models.map((m) => ({ color: colors.get(m), label: m }))),
    el("div", { className: "facets" }, facets),
  );
}

/** The test-mode create form, prefilled with the selected condition. */
function startPanel(data, condition) {
  const test = {
    reference: data.reference.id,
    style: condition?.style ?? "landscape",
    size: condition?.size ?? "study",
    max_strokes: condition?.maxStrokes,
  };
  return el("section", { className: "panel start-run" }, [
    el("h2", { textContent: "Start a run" }),
    el("p", {
      className: "small muted",
      textContent:
        "This creates the painting; an agent paints it. The painting's page gives its MCP URL and a command to connect Claude Code (any MCP client works). The run is listed under the model the agent reports when it submits strokes.",
    }),
    createForm({ test }),
  ]);
}

if (referenceId) showTest();
else showIndex();
