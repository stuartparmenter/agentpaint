// Reference tests. `/tests` lists one card per reference; `/tests/<reference>`
// compares the runs made against one reference under one condition: results
// table, score charts per look setting, final canvases, and a form to start a run.

import { LineChart, legend, seriesClass } from "./chart.js";
import {
  attribution,
  copyField,
  el,
  fmtInt,
  fmtNum,
  fmtScore,
  fmtSeconds,
  getJson,
  modelsLabel,
  snapshotUrl,
} from "./common.js";
import { createForm } from "./create-form.js";

const page = document.getElementById("page");
const referenceId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "");
const UNREPORTED = modelsLabel([]);

const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

function fail(message) {
  page.removeAttribute("aria-busy");
  page.replaceChildren(
    el("p", { className: "error", textContent: message }),
    el("a", { href: "/tests", textContent: "All reference tests" }),
  );
}

// ---------------------------------------------------------------- index

async function showIndex() {
  let tests;
  try {
    tests = await getJson("/api/tests");
  } catch (e) {
    return fail(`Couldn't load the tests (${e.message}).`);
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
            t.bestScore === null ? "No finished runs yet" : `Best finished score ${fmtScore(t.bestScore)}`,
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
          "Each test gives agents a fixed image to paint toward and scores every stroke by its similarity to it, so models and look settings can be compared on the same target.",
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
  return `${capitalize(c.style)} · ${c.size ?? "custom"} ${c.width}×${c.height} · ${c.maxStrokes} strokes · phases ${c.phases} · ${plural(c.runs, "run")}`;
}

function lookTitle(spl, max) {
  if (spl === 1) return "Every stroke (1)";
  if (spl >= max) return `One look (${max})`;
  return `Every ${spl} strokes`;
}

/** Model labels in a fixed order (alphabetical, "not reported" last), each with a categorical slot. */
function modelColors(paintings) {
  const named = [...new Set(paintings.map((p) => modelsLabel(p.models)))]
    .filter((m) => m !== UNREPORTED)
    .sort((a, b) => a.localeCompare(b));
  const colors = new Map(named.map((m, i) => [m, i < 8 ? i + 1 : 0]));
  if (paintings.some((p) => !p.models.length)) colors.set(UNREPORTED, 0);
  return colors;
}

async function showTest() {
  let data;
  try {
    data = await getJson(apiUrl());
  } catch (e) {
    return fail(e.status === 404 ? "No such reference test." : `Couldn't load the test (${e.message}).`);
  }
  document.title = `${data.reference.title} · Reference tests · AgentPaint`;
  const condition = data.conditions.find((c) => c.key === data.condition) ?? null;

  ui.lanesPanel = el("section", { className: "panel" });
  ui.lanes = el("div", { className: "lanes" });
  ui.tableView = el("details", { className: "table-view" }, [el("summary", { textContent: "Table view" })]);
  ui.lanesPanel.append(
    el("h2", { textContent: "Results by model" }),
    el("p", {
      className: "small muted",
      textContent:
        "One lane per model, one column per look setting. Each run shows its final canvas (linked to its playback) and numbers; repeated runs sit together in their cell.",
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

  if (data.paintings.some((p) => p.status === "active")) {
    const timer = setInterval(async () => {
      try {
        const next = await getJson(apiUrl());
        renderRuns(next, next.conditions.find((c) => c.key === next.condition) ?? null);
        if (!next.paintings.some((p) => p.status === "active")) clearInterval(timer);
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
      ? `Every stroke is scored by similarity to this image (higher is closer). For scale: a blank canvas scores ${fmtScore(blank)} and a canvas painted one flat average color scores ${fmtScore(meanColor)}.`
      : "Every stroke is scored by similarity to this image (higher is closer).";
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
  const paintings = data.paintings;
  const max = condition?.maxStrokes ?? 1;
  const colors = modelColors(paintings);
  const models = [...colors.keys()];
  const settings = [...new Set(paintings.map((p) => p.strokesPerLook))].sort((a, b) => a - b);
  for (const section of [ui.lanesPanel, ui.chartsPanel]) section.hidden = paintings.length === 0;
  if (!paintings.length) return;
  renderLanes(data, paintings, colors, models, settings, max);
  renderTableView(data, models, max);
  renderCharts(data, paintings, colors, models, settings, max);
}

/** One lane per model: a cell per look setting holding that model's runs, best score first. */
function renderLanes(data, paintings, colors, models, settings, max) {
  const cell = (m, spl) => data.table.find((r) => r.models === m && r.strokes_per_look === spl) ?? null;
  ui.lanes.replaceChildren(
    ...models.map((m) => {
      const cells = el("div", { className: "lane-cells" });
      cells.style.setProperty("--cols", String(settings.length));
      for (const spl of settings) {
        const runs = paintings
          .filter((p) => p.strokesPerLook === spl && modelsLabel(p.models) === m)
          .sort((a, b) => (b.lastScore ?? -1) - (a.lastScore ?? -1));
        const summary = cell(m, spl);
        const children = [el("h4", { textContent: lookTitle(spl, max) })];
        if (!runs.length) children.push(el("p", { className: "small muted", textContent: "No run" }));
        if (runs.length > 1 && summary) {
          children.push(
            el("p", {
              className: "small",
              textContent: `Mean ${fmtScore(summary.final_score)} over ${plural(runs.length, "run")}`,
            }),
          );
        }
        for (const p of runs) children.push(runItem(p, m, spl, max));
        cells.append(el("div", { className: "lane-cell" }, children));
      }
      const key = el("span", { className: "lane-key" });
      key.setAttribute("aria-hidden", "true");
      const lane = el("section", { className: "lane" }, [
        el("h3", { className: "lane-head" }, [key, m]),
        cells,
      ]);
      lane.setAttribute("aria-label", m);
      // The lane's stripe and dot take the model's chart color; its name stays in text color.
      lane.style.setProperty("--lane", `var(--${seriesClass(colors.get(m))})`);
      return lane;
    }),
  );
}

function runItem(p, model, spl, max) {
  const href = `/p/${encodeURIComponent(p.id)}`;
  const thumb = el("img", {
    className: "thumb",
    src: snapshotUrl(p.id, p.strokeCount),
    alt: `${model}, ${lookTitle(spl, max)}: canvas after ${p.strokeCount} strokes`,
    width: p.width,
    height: p.height,
    loading: "lazy",
  });
  return el("div", { className: "run" }, [
    el("a", { href }, [thumb]),
    el("div", { className: "run-score" }, [
      el("strong", { textContent: fmtScore(p.lastScore) }),
      p.status === "active" ? el("span", { className: "badge active", textContent: "painting" }) : null,
    ]),
    el("div", {
      className: "small muted",
      textContent: `${p.strokeCount}/${p.maxStrokes} strokes · ${plural(p.looks, "look")} · ${fmtSeconds(p.meanThinkMs)} think`,
    }),
    el("div", {
      className: "small muted",
      textContent: `${fmtInt(p.tokensIn)} in / ${fmtInt(p.tokensOut)} out tokens`,
    }),
  ]);
}

/** The lanes' numbers as one table (model, then look setting), for screen readers and copying. */
function renderTableView(data, models, max) {
  const rows = [...data.table]
    .sort(
      (a, b) =>
        models.indexOf(a.models) - models.indexOf(b.models) || a.strokes_per_look - b.strokes_per_look,
    )
    .map((r) =>
      el("tr", {}, [
        el("td", { textContent: r.models }),
        el("td", { textContent: lookTitle(r.strokes_per_look, max) }),
        ...[
          fmtInt(r.paintings),
          fmtInt(r.finished),
          fmtScore(r.final_score),
          fmtNum(r.strokes_used),
          fmtNum(r.looks),
          fmtSeconds(r.mean_think_ms),
          fmtInt(r.tokens_in),
          fmtInt(r.tokens_out),
        ].map((v) => el("td", { className: "num", textContent: v })),
      ]),
    );
  ui.tableView.querySelector(".table-wrap")?.remove();
  ui.tableView.append(
    table(
      "Results by model and look setting; repeated runs averaged",
      [
        ["Model", ""],
        ["Look setting", ""],
        ["Runs", "num"],
        ["Finished", "num"],
        ["Final score", "num"],
        ["Strokes used", "num"],
        ["Looks", "num"],
        ["Mean think", "num"],
        ["Tokens in", "num"],
        ["Tokens out", "num"],
      ],
      rows,
    ),
  );
}

/** One chart per look setting, one line per run colored by model, on one y-scale. */
function renderCharts(data, paintings, colors, models, settings, max) {
  const { blank, meanColor } = data.anchors;
  const refs = [];
  if (blank !== null) refs.push({ y: blank, label: "blank canvas" });
  if (meanColor !== null) refs.push({ y: meanColor, label: "flat average color" });
  const curve = (p) => [
    ...(blank !== null ? [{ x: 0, y: blank }] : []),
    ...(data.curves[p.id] ?? []).map(([x, y]) => ({ x, y })),
  ];
  const ys = refs.map((r) => r.y);
  for (const p of paintings) for (const pt of curve(p)) ys.push(pt.y);
  const yDomain = [Math.min(...ys), Math.max(...ys)];
  const facets = settings.map((spl) => {
    const title = lookTitle(spl, max);
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
    const runs = paintings.filter((p) => p.strokesPerLook === spl);
    const runsOf = (m) => runs.filter((p) => modelsLabel(p.models) === m).length;
    const series = runs
      .map((p) => {
        const model = modelsLabel(p.models);
        const repeated = runsOf(model) > 1;
        return {
          id: p.id,
          label: repeated ? `${model} · ${p.id}` : model,
          color: colors.get(model),
          thin: repeated,
          points: curve(p),
          rank: models.indexOf(model),
        };
      })
      .sort((a, b) => a.rank - b.rank);
    chart.setData({ series, refs, xMax: max, yDomain });
    return el("div", { className: "facet" }, [el("h3", { textContent: title }), chart.root]);
  });
  ui.chartsPanel.replaceChildren(
    el("h2", { textContent: "Score per stroke" }),
    el("p", {
      className: "small muted",
      textContent:
        "One chart per look setting, one line per run, colored by model; repeated runs of a model are thin lines in its color. Dashed lines are the blank-canvas and flat-color scores.",
    }),
    legend(models.map((m) => ({ color: colors.get(m), label: m }))),
    el("div", { className: "facets" }, facets),
  );
}

function table(caption, head, rows) {
  return el("div", { className: "table-wrap" }, [
    el("table", { className: "data" }, [
      el("caption", { className: "visually-hidden", textContent: caption }),
      el("thead", {}, [
        el(
          "tr",
          {},
          head.map(([t, c]) => el("th", { scope: "col", className: c, textContent: t })),
        ),
      ]),
      el("tbody", {}, rows),
    ]),
  ]);
}

/** The test-mode create form and the matrix command for the selected condition. */
function startPanel(data, condition) {
  const style = condition?.style ?? "landscape";
  const size = condition?.size ?? "study";
  const test = {
    reference: data.reference.id,
    style,
    size,
    max_strokes: condition?.maxStrokes,
    phases: condition?.phases ?? "off",
  };
  const models = [...new Set(data.paintings.flatMap((p) => p.models))].filter((m) => m !== "random").sort();
  const max = condition?.maxStrokes;
  const settings = [...new Set(data.paintings.map((p) => p.strokesPerLook))].sort((a, b) => a - b);
  const looks = settings.length ? settings.map((s) => (max && s >= max ? "all" : s)).join(",") : "1,20,all";
  const command = [
    "bun run matrix --",
    `--url ${location.origin}`,
    `--models ${models.length ? models.join(",") : "<model-ids>"}`,
    `--looks ${looks}`,
    `--style ${style}`,
    `--reference ${data.reference.id}`,
    `--size ${size}`,
    ...(max ? [`--max-strokes ${max}`] : []),
    `--phases ${test.phases}`,
  ].join(" ");

  return el("section", { className: "panel start-run" }, [
    el("h2", { textContent: "Start a run" }),
    el("p", {
      className: "small muted",
      textContent:
        "This creates the painting only. An agent does the painting (the bundled painter or any MCP client, connected with the MCP URL shown on the painting's page), and its model is whatever it reports when it submits strokes.",
    }),
    createForm({ test }),
    el("h3", { textContent: "Or paint a whole matrix" }),
    el("p", {
      className: "small muted",
      textContent:
        "From the repository root, the bundled painter creates one batch with a run per model and look setting, then paints them.",
    }),
    copyField("Matrix command", command),
  ]);
}

if (referenceId) showTest();
else showIndex();
