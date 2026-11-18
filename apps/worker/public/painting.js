// One painting: canvas with playback, settings, reference, score chart,
// stroke log, and (for the creator's browser) connection details and controls.

import { LineChart } from "./chart.js";
import {
  anchorRefs,
  assignmentBadge,
  assignmentTitle,
  attribution,
  copyField,
  el,
  fail,
  fmtDate,
  fmtInt,
  fmtScore,
  fmtSeconds,
  getJson,
  idFromPath,
  loadJson,
  loadReferences,
  paintingKey,
  playback,
  poll,
  snapshotUrl,
  statusBadge,
  table,
} from "./common.js";
import { prefillQuery } from "./create-form.js";

const id = idFromPath();
const page = document.getElementById("page");
const api = `/api/paintings/${encodeURIComponent(id)}`;
const loadStrokes = () => getJson(`${api}/strokes`).catch(() => []);

const state = { painting: null, strokes: [], viewing: 0, stopPolling: null };
const ui = {};

async function init() {
  if (!id) return fail("No painting id in the address.", "/", "Back to the gallery");
  try {
    [state.painting, state.strokes] = await Promise.all([getJson(api), loadStrokes()]);
  } catch (e) {
    const message =
      e.status === 404 ? "This painting doesn't exist." : `Couldn't load the painting (${e.message}).`;
    return fail(message, "/", "Back to the gallery");
  }
  state.viewing = state.painting.strokeCount;
  build();
  update();
  page.removeAttribute("aria-busy");
  schedule();
}

function schedule() {
  state.stopPolling?.();
  state.stopPolling = state.painting.status === "active" ? poll(refresh, 5000) : null;
}

/** Reloads the summary, and the stroke log only when it is behind the summary's stroke count. */
async function refresh() {
  try {
    const painting = await getJson(api);
    const wasActive = state.painting.status === "active";
    const followingLatest = state.viewing === state.painting.strokeCount;
    const strokesChanged = painting.strokeCount !== state.strokes.length;
    if (strokesChanged) state.strokes = await loadStrokes();
    state.painting = painting;
    if (followingLatest && !ui.player.playing) state.viewing = painting.strokeCount;
    update(strokesChanged);
    if (wasActive && painting.status !== "active") {
      schedule();
      renderOwner();
    }
  } catch (e) {
    console.error("refresh failed", e);
  }
}

// ---------------------------------------------------------------- layout

function build() {
  const p = state.painting;
  document.title = `${p.prompt ?? "Open subject"} · AgentPaint`;

  // Canvas and (when set) the reference, side by side.
  ui.img = el("img", { className: "canvas-img", alt: "", width: p.width, height: p.height });
  ui.img.style.aspectRatio = `${p.width} / ${p.height}`;
  const canvasFigure = el("figure", { className: "canvas" }, [
    ui.img,
    el("figcaption", { className: "small muted", textContent: "Canvas" }),
  ]);
  const compare = el("div", { className: p.reference ? "compare two" : "compare" }, [canvasFigure]);
  if (p.reference) {
    ui.refCaption = el("figcaption", { className: "small muted", textContent: "Reference" });
    const refImg = el("img", {
      className: "canvas-img",
      src: `/api/paintings/${encodeURIComponent(p.id)}/reference`,
      alt: "Reference image",
      width: p.width,
      height: p.height,
    });
    refImg.style.aspectRatio = `${p.width} / ${p.height}`;
    compare.append(el("figure", { className: "canvas" }, [refImg, ui.refCaption]));
    loadReferences()
      .then((refs) => {
        const r = refs.find((x) => x.id === p.reference);
        if (!r) return;
        refImg.alt = `Reference: ${r.title}`;
        ui.refCaption.replaceChildren("Reference: ", attribution(r));
        ui.testLink.textContent = `Part of the ${r.title} test →`;
      })
      .catch(() => {});
  } else {
    // A lone canvas stays within the viewport height.
    canvasFigure.style.maxWidth = `min(100%, calc(72vh * ${p.width / p.height}))`;
  }

  // Playback.
  ui.player = playback({
    className: "play",
    frameUrl: (v) => snapshotUrl(p.id, v),
    current: () => state.viewing,
    last: () => state.painting.strokeCount,
    show,
    delay: (n) => Math.min(500, Math.max(40, 6000 / n)),
  });
  ui.slider = el("input", { type: "range", min: 0, step: 1, id: "history" });
  ui.slider.setAttribute("aria-label", "Stroke");
  ui.ticks = el("div", { className: "ticks" });
  ui.ticks.setAttribute("aria-hidden", "true");
  ui.version = el("span", { className: "version" });
  ui.slider.addEventListener("input", () => jump(Number(ui.slider.value)));
  const player = el("div", { className: "player" }, [
    ui.player.button,
    el("div", { className: "track" }, [ui.slider, ui.ticks]),
    ui.version,
  ]);

  ui.info = el("div", { className: "stroke-info" });
  ui.infoLine = el("div", { className: "stroke-meta" });
  ui.note = el("p", { className: "stroke-note" });
  ui.info.append(ui.infoLine, ui.note);
  ui.tickNote = el("p", {
    className: "small muted",
    textContent:
      "Ticks under the slider mark each assignment: the canvas the agent saw before its next batch of strokes.",
    hidden: true,
  });

  const stage = el("section", { className: "stage", ariaLabel: "Canvas and playback" }, [
    compare,
    player,
    ui.tickNote,
    ui.info,
  ]);

  // Sidebar: settings and owner controls. A reference painting links to its
  // test; any other painting links to the home form, prefilled.
  ui.title = el("h2", { className: "painting-title" });
  ui.badges = el("div", { className: "badges" });
  ui.settings = el("dl", { className: "settings" });
  ui.testLink = p.reference
    ? el("a", {
        href: `/tests/${encodeURIComponent(p.reference)}?condition=${encodeURIComponent(p.condition)}`,
        textContent: "Part of a reference test →",
      })
    : el("a", { href: `/${prefillQuery(p)}`, textContent: "New painting with these settings" });
  const settingsPanel = el("section", { className: "panel" }, [
    ui.title,
    ui.badges,
    ui.settings,
    el("p", { className: "small" }, [ui.testLink]),
  ]);
  ui.owner = el("section", { className: "panel owner" });
  ui.owner.setAttribute("aria-label", "Your painting");

  // Score chart.
  ui.chartPanel = null;
  if (p.reference) {
    ui.chart = new LineChart({
      label: "Score per stroke",
      xLabel: "stroke",
      xTitle: (x) => (x === 0 ? "Blank canvas" : `Stroke ${x}`),
      extra: (x) => tooltipExtra(x),
      onPick: jump,
    });
    ui.chartCaption = el("p", { className: "small muted" });
    ui.chartPanel = el("section", { className: "panel chart-panel" }, [
      el("h2", { textContent: "Score per stroke" }),
      el("p", {
        className: "small muted",
        textContent:
          "Similarity to the reference after each stroke: 0 is a blank canvas, 1 is identical. The upper dashed line is what a canvas painted one flat average color scores. Click the chart to jump to a stroke.",
      }),
      ui.chart.root,
      ui.chartCaption,
    ]);
  }

  // Stroke log.
  ui.logSummary = el("summary");
  ui.log = el("details", { className: "panel log" }, [ui.logSummary]);

  const mainCol = el("div", { className: "col main-col" }, [stage, ui.chartPanel, ui.log]);
  const sideCol = el("div", { className: "col side-col" }, [ui.owner, settingsPanel]);
  page.replaceChildren(el("div", { className: "painting-layout" }, [mainCol, sideCol]));

  renderOwner();
}

// ---------------------------------------------------------------- updates

function update(strokesChanged = true) {
  const p = state.painting;
  ui.slider.max = p.strokeCount;
  renderSettings();
  if (strokesChanged) {
    renderTicks();
    renderChart();
    renderLog();
  }
  show(state.viewing);
}

function renderSettings() {
  const p = state.painting;
  ui.title.textContent = p.prompt ?? "Open subject";
  ui.badges.replaceChildren(statusBadge(p.status), assignmentBadge(p));
  const rows = [
    ["Style", p.style],
    ["Prompt", p.prompt ?? "Open subject (none given)"],
    ["Size", `${p.size} · ${p.width}×${p.height}`],
    ["Strokes per assignment", assignmentTitle("span", p.strokesPerAssignment, p.maxStrokes)],
    ["Agent can end the painting early", p.allowFinish ? "yes" : "no"],
    ["Budget", `${p.strokeCount} of ${p.maxStrokes} strokes used`],
    ["Assignments", fmtInt(p.assignments)],
    ["Status", p.status],
    ["Models seen", p.models.length ? p.models.join(", ") : "not reported"],
    ["Mean think time", fmtSeconds(p.meanThinkMs)],
    ["Tokens in / out", `${fmtInt(p.tokensIn)} / ${fmtInt(p.tokensOut)}`],
  ];
  if (p.reference) rows.push(["Latest score", fmtScore(p.lastScore, p.blankScore)]);
  rows.push(["Created", fmtDate(p.createdAt)]);
  if (p.finishedAt) rows.push(["Finished", fmtDate(p.finishedAt)]);
  const nodes = [];
  // Values are strings (added as text) or elements.
  for (const [k, v] of rows) nodes.push(el("dt", { textContent: k }), el("dd", {}, [v]));
  ui.settings.replaceChildren(...nodes);
}

/** Canvas versions the agent saw at each new assignment: the stroke before the assignment's first stroke. */
function assignmentPositions() {
  const out = [];
  let prev = null;
  for (const s of state.strokes) {
    if (s.assignment !== prev) out.push(s.version - 1);
    prev = s.assignment;
  }
  return out;
}

function showAssignmentMarks() {
  const starts = assignmentPositions();
  return starts.length > 1 && starts.length < state.strokes.length && starts.length <= 400 ? starts : [];
}

function renderTicks() {
  const max = Math.max(1, state.painting.strokeCount);
  const marks = showAssignmentMarks();
  ui.ticks.replaceChildren(
    ...marks.map((v) => {
      const tick = el("span", { className: "tick" });
      tick.style.left = `${(v / max) * 100}%`;
      return tick;
    }),
  );
  ui.ticks.hidden = marks.length === 0;
  ui.tickNote.hidden = marks.length === 0 || Boolean(state.painting.reference);
}

function renderChart() {
  if (!ui.chart) return;
  const p = state.painting;
  const { refs, curve } = anchorRefs(p.blankScore, p.meanColorScore);
  const points = curve(state.strokes.filter((s) => s.score !== null).map((s) => [s.version, s.score]));
  const marks = showAssignmentMarks();
  ui.chart.setData({
    series: [{ id: p.id, label: "score", color: 1, points }],
    refs,
    boundaries: marks,
    xMax: Math.max(1, p.strokeCount),
    marker: state.viewing,
  });
  ui.chartCaption.textContent = marks.length
    ? "Vertical hairlines mark each assignment: the canvas the agent saw before its next batch of strokes."
    : "";
  ui.chartCaption.hidden = !marks.length;
}

function tooltipExtra(x) {
  if (x === 0) return null;
  const s = state.strokes[x - 1];
  if (!s) return null;
  const parts = [
    el("div", {
      className: "chart-tooltip-label",
      textContent: `Assignment ${s.assignment} · ${fmtSeconds(s.think_ms)}`,
    }),
  ];
  if (s.note) parts.push(el("div", { className: "chart-tooltip-note", textContent: s.note }));
  return el("div", {}, parts);
}

const LOG_HEAD = [
  ["Stroke", "num"],
  ["Assignment", "num"],
  ["Think", "num"],
  ["Score", "num"],
  ["Note", ""],
  ["Model", ""],
  ["Effort", ""],
  ["Tokens in", "num"],
  ["Tokens out", "num"],
];

function renderLog() {
  const n = state.strokes.length;
  ui.logSummary.textContent = `Stroke log (${n} ${n === 1 ? "stroke" : "strokes"})`;
  const rows = state.strokes.map((s) => {
    const button = el("button", { type: "button", className: "link-button", textContent: String(s.version) });
    button.setAttribute("aria-label", `Show stroke ${s.version}`);
    button.addEventListener("click", () => {
      jump(s.version);
      ui.img.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const tr = el("tr", {}, [
      el("td", { className: "num" }, [button]),
      el("td", { className: "num", textContent: String(s.assignment) }),
      el("td", { className: "num", textContent: fmtSeconds(s.think_ms) }),
      el("td", { className: "num", textContent: fmtScore(s.score, state.painting.blankScore) }),
      el("td", { className: "note", textContent: s.note ?? "" }),
      el("td", { textContent: s.model ?? "" }),
      el("td", { textContent: s.effort ?? "" }),
      el("td", { className: "num", textContent: s.input_tokens === null ? "" : fmtInt(s.input_tokens) }),
      el("td", { className: "num", textContent: s.output_tokens === null ? "" : fmtInt(s.output_tokens) }),
    ]);
    tr.dataset.version = s.version;
    return tr;
  });
  if (!rows.length) {
    rows.push(el("tr", {}, [el("td", { colSpan: 9, className: "muted", textContent: "No strokes yet." })]));
  }
  ui.log.replaceChildren(ui.logSummary, table("Stroke log", LOG_HEAD, rows));
  ui.currentRow = null;
}

// ---------------------------------------------------------------- playback

function show(v) {
  const p = state.painting;
  state.viewing = Math.max(0, Math.min(p.strokeCount, v));
  const url = snapshotUrl(p.id, state.viewing);
  if (ui.img.getAttribute("src") !== url) ui.img.src = url;
  ui.img.alt =
    state.viewing === 0 ? "Blank canvas" : `Canvas after stroke ${state.viewing} of ${p.strokeCount}`;
  ui.slider.value = state.viewing;
  ui.version.textContent = `${state.viewing} / ${p.strokeCount}`;
  ui.slider.setAttribute("aria-valuetext", `Stroke ${state.viewing} of ${p.strokeCount}`);
  ui.chart?.setMarker(state.viewing);

  const s = state.viewing > 0 ? state.strokes[state.viewing - 1] : null;
  const parts = [];
  if (state.viewing === 0) {
    parts.push(["Blank canvas", ""]);
    if (p.blankScore !== null) parts.push(["Score", fmtScore(p.blankScore, p.blankScore)]);
  } else if (s) {
    parts.push(["Stroke", `${s.version} of ${p.strokeCount}`]);
    parts.push(["Assignment", String(s.assignment)]);
    parts.push(["Think", fmtSeconds(s.think_ms)]);
    if (s.score !== null) parts.push(["Score", fmtScore(s.score, p.blankScore)]);
    if (s.model) parts.push(["Model", s.effort ? `${s.model} (${s.effort})` : s.model]);
  } else {
    parts.push(["Stroke", `${state.viewing} of ${p.strokeCount}`]);
  }
  ui.infoLine.replaceChildren(
    ...parts.map(([k, v]) =>
      el(
        "span",
        {},
        v
          ? [el("span", { className: "muted", textContent: `${k} ` }), el("strong", { textContent: v })]
          : [el("strong", { textContent: k })],
      ),
    ),
  );
  ui.note.textContent = s?.note ? `“${s.note}”` : state.viewing === 0 ? "" : "No note for this stroke.";
  ui.note.classList.toggle("muted", !s?.note);

  ui.currentRow?.classList.remove("current");
  ui.currentRow = ui.log.querySelector(`tr[data-version="${state.viewing}"]`);
  ui.currentRow?.classList.add("current");
}

/** Stops playback and shows stroke `v`. */
function jump(v) {
  ui.player.stop();
  show(v);
}

// ---------------------------------------------------------------- owner

function renderOwner() {
  const p = state.painting;
  const keys = loadJson(paintingKey(p.id));
  if (!keys?.mcp_url) {
    ui.owner.hidden = true;
    return;
  }
  ui.owner.hidden = false;
  const command = `claude mcp add --transport http agentpaint-${p.id} ${keys.mcp_url}`;
  const children = [
    el("h2", { textContent: "Connect an agent" }),
    el("p", {
      className: "small muted",
      textContent:
        "This browser created this painting. The MCP URL contains the agent key: anyone with it can paint here, so share it only with your agent.",
    }),
    copyField("MCP URL", keys.mcp_url),
    copyField("Claude Code command", command),
  ];
  if (p.status === "active") {
    const finish = el("button", {
      type: "button",
      className: "button danger",
      textContent: "Finish painting",
    });
    const error = el("p", { className: "error", hidden: true });
    error.setAttribute("role", "alert");
    finish.addEventListener("click", async () => {
      if (!window.confirm("Finish this painting? The agent won't be able to add more strokes.")) return;
      finish.disabled = true;
      error.hidden = true;
      try {
        await getJson(`/api/paintings/${encodeURIComponent(p.id)}/finish`, {
          method: "POST",
          headers: { Authorization: `Bearer ${keys.owner_key}` },
        });
        state.painting = { ...state.painting, status: "done" };
        update(false);
        schedule();
        renderOwner();
        setTimeout(refresh, 5500);
      } catch (e) {
        finish.disabled = false;
        error.textContent =
          e.status === 401
            ? "The stored owner key wasn't accepted."
            : `Couldn't finish the painting (${e.message}).`;
        error.hidden = false;
      }
    });
    children.push(el("div", { className: "button-row" }, [finish]), error);
  } else {
    children.push(el("p", { className: "small muted", textContent: `This painting is ${p.status}.` }));
  }
  ui.owner.replaceChildren(...children);
}

init();
