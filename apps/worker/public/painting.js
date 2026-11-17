// One painting: canvas with playback, settings, reference, score chart,
// stroke log, and (for the creator's browser) connection details and controls.

import { LineChart } from "./chart.js";
import {
  attribution,
  copyField,
  el,
  fmtDate,
  fmtInt,
  fmtScore,
  fmtSeconds,
  getJson,
  idFromPath,
  loadJson,
  loadReferences,
  loadSeriesKey,
  lookLabel,
  paintingKey,
  preload,
  snapshotUrl,
  statusBadge,
} from "./common.js";
import { createForm, prefillFrom, prefillQuery } from "./create-form.js";

const id = idFromPath();
const page = document.getElementById("page");
const crumbs = document.getElementById("crumbs");

const state = {
  painting: null,
  strokes: [],
  viewing: 0,
  playing: false,
  gen: 0,
  timer: null,
};
const ui = {};

async function load() {
  const [painting, strokes] = await Promise.all([
    getJson(`/api/paintings/${encodeURIComponent(id)}`),
    getJson(`/api/paintings/${encodeURIComponent(id)}/strokes`).catch(() => []),
  ]);
  return { painting, strokes: Array.isArray(strokes) ? strokes : [] };
}

async function init() {
  if (!id) return fail("No painting id in the address.");
  let data;
  try {
    data = await load();
  } catch (e) {
    return fail(
      e.status === 404 ? "This painting doesn't exist." : `Couldn't load the painting (${e.message}).`,
    );
  }
  state.painting = data.painting;
  state.strokes = data.strokes;
  state.viewing = data.painting.strokeCount;
  build();
  update();
  page.removeAttribute("aria-busy");
  schedule();
}

function fail(message) {
  page.removeAttribute("aria-busy");
  page.replaceChildren(
    el("p", { className: "error", textContent: message }),
    el("a", { href: "/", textContent: "Back to the gallery" }),
  );
}

function schedule() {
  clearInterval(state.timer);
  if (state.painting.status === "active") state.timer = setInterval(refresh, 5000);
}

async function refresh() {
  try {
    const data = await load();
    const wasActive = state.painting.status === "active";
    const followingLatest = state.viewing === state.painting.strokeCount;
    const strokesChanged = data.strokes.length !== state.strokes.length;
    state.painting = data.painting;
    state.strokes = data.strokes;
    if (followingLatest && !state.playing) state.viewing = data.painting.strokeCount;
    update(strokesChanged);
    if (wasActive && data.painting.status !== "active") {
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
  if (p.seriesId) {
    crumbs.append(
      " / ",
      el("a", { href: `/s/${encodeURIComponent(p.seriesId)}`, textContent: "Series" }),
      " / ",
      el("span", { textContent: `Painting ${p.id}` }),
    );
  } else {
    crumbs.append(" / ", el("span", { textContent: `Painting ${p.id}` }));
  }

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
      })
      .catch(() => {});
  } else {
    // A lone canvas stays within the viewport height.
    canvasFigure.style.maxWidth = `min(100%, calc(72vh * ${p.width / p.height}))`;
  }

  // Playback.
  ui.play = el("button", { type: "button", className: "play", textContent: "▶" });
  ui.play.setAttribute("aria-label", "Play history");
  ui.slider = el("input", { type: "range", min: 0, step: 1, id: "history" });
  ui.slider.setAttribute("aria-label", "Stroke");
  ui.ticks = el("div", { className: "ticks" });
  ui.ticks.setAttribute("aria-hidden", "true");
  ui.version = el("span", { className: "version" });
  ui.play.addEventListener("click", () => (state.playing ? stop() : start()));
  ui.slider.addEventListener("input", () => {
    stop();
    show(Number(ui.slider.value));
  });
  const player = el("div", { className: "player" }, [
    ui.play,
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
      "Ticks under the slider mark each look: the canvas the agent saw before its next batch of strokes.",
    hidden: true,
  });

  const stage = el("section", { className: "stage", ariaLabel: "Canvas and playback" }, [
    compare,
    player,
    ui.tickNote,
    ui.info,
  ]);

  // Sidebar: settings, owner controls, duplicate.
  ui.title = el("h2", { className: "painting-title" });
  ui.badges = el("div", { className: "badges" });
  ui.settings = el("dl", { className: "settings" });
  const settingsPanel = el("section", { className: "panel" }, [ui.title, ui.badges, ui.settings]);
  ui.owner = el("section", { className: "panel owner" });
  ui.owner.setAttribute("aria-label", "Your painting");
  ui.duplicate = el("section", { className: "panel" });
  ui.duplicate.setAttribute("aria-label", "Duplicate");

  // Score chart.
  ui.chartPanel = null;
  if (p.reference) {
    ui.chart = new LineChart({
      label: "Score per stroke",
      xLabel: "stroke",
      yFormat: (v) => v.toFixed(3),
      xTitle: (x) => (x === 0 ? "Blank canvas" : `Stroke ${x}`),
      extra: (x) => tooltipExtra(x),
      onPick: (x) => {
        stop();
        show(x);
      },
    });
    ui.chartCaption = el("p", { className: "small muted" });
    ui.chartPanel = el("section", { className: "panel chart-panel" }, [
      el("h2", { textContent: "Score per stroke" }),
      el("p", {
        className: "small muted",
        textContent:
          "Similarity to the reference after each stroke (higher is closer). The dashed lines are what a blank canvas and a canvas painted one flat average color score. Click the chart to jump to a stroke.",
      }),
      ui.chart.root,
      ui.chartCaption,
    ]);
  }

  // Stroke log.
  ui.logBody = el("tbody");
  ui.logSummary = el("summary");
  const logTable = el("table", { className: "data" }, [
    el("caption", { className: "visually-hidden", textContent: "Stroke log" }),
    el("thead", {}, [
      el(
        "tr",
        {},
        [
          ["Stroke", "num"],
          ["Look", "num"],
          ["Think", "num"],
          ["Score", "num"],
          ["Note", ""],
          ["Model", ""],
          ["Effort", ""],
          ["Tokens in", "num"],
          ["Tokens out", "num"],
        ].map(([t, c]) => el("th", { scope: "col", className: c, textContent: t })),
      ),
    ]),
    ui.logBody,
  ]);
  const log = el("details", { className: "panel log" }, [
    ui.logSummary,
    el("div", { className: "table-wrap" }, [logTable]),
  ]);

  const mainCol = el("div", { className: "col main-col" }, [stage, ui.chartPanel, log]);
  const sideCol = el("div", { className: "col side-col" }, [ui.owner, settingsPanel, ui.duplicate]);
  page.replaceChildren(el("div", { className: "painting-layout" }, [mainCol, sideCol]));

  renderOwner();
  renderDuplicate();
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
  const look = el("span", {
    className: "badge look",
    textContent: lookLabel(p.strokesPerLook, p.maxStrokes),
  });
  ui.badges.replaceChildren(statusBadge(p.status), look);
  const rows = [
    ["Style", `${p.style} · ${p.medium}`],
    ["Prompt", p.prompt ?? "Open subject (none given)"],
    ["Size", `${p.size ?? "pool"} · ${p.width}×${p.height}`],
    [
      "Strokes per look",
      p.strokesPerLook >= p.maxStrokes ? `${p.strokesPerLook} (one look)` : String(p.strokesPerLook),
    ],
    ["Phases", p.phases],
    ["Budget", `${p.strokeCount} of ${p.maxStrokes} strokes used`],
    ["Looks", fmtInt(p.looks)],
    ["Status", p.status],
    ["Models seen", p.models.length ? p.models.join(", ") : "none reported"],
    ["Mean think time", fmtSeconds(p.meanThinkMs)],
    ["Tokens in / out", `${fmtInt(p.tokensIn)} / ${fmtInt(p.tokensOut)}`],
  ];
  if (p.reference) rows.push(["Latest score", fmtScore(p.lastScore)]);
  rows.push(["Created", fmtDate(p.createdAt)]);
  if (p.finishedAt) rows.push(["Finished", fmtDate(p.finishedAt)]);
  const nodes = [];
  for (const [k, v] of rows) nodes.push(el("dt", { textContent: k }), el("dd", { textContent: v }));
  if (p.seriesId) {
    nodes.push(
      el("dt", { textContent: "Series" }),
      el("dd", {}, [
        el("a", { href: `/s/${encodeURIComponent(p.seriesId)}`, textContent: "Compare the series" }),
      ]),
    );
  }
  ui.settings.replaceChildren(...nodes);
}

/** Canvas versions the agent looked at before each new look: the stroke before the look's first stroke. */
function lookPositions() {
  const out = [];
  let prev = null;
  for (const s of state.strokes) {
    if (s.look !== prev) out.push(s.version - 1);
    prev = s.look;
  }
  return out;
}

function showLookMarks() {
  const looks = lookPositions();
  return looks.length > 1 && looks.length < state.strokes.length && looks.length <= 400 ? looks : [];
}

function renderTicks() {
  const max = Math.max(1, state.painting.strokeCount);
  const marks = showLookMarks();
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
  const points = [];
  if (p.blankScore !== null) points.push({ x: 0, y: p.blankScore });
  for (const s of state.strokes) if (s.score !== null) points.push({ x: s.version, y: s.score });
  const refs = [];
  if (p.blankScore !== null) refs.push({ y: p.blankScore, label: "blank canvas" });
  if (p.meanColorScore !== null) refs.push({ y: p.meanColorScore, label: "flat average color" });
  const marks = showLookMarks();
  ui.chart.setData({
    series: [{ id: p.id, label: "score", color: 1, points }],
    refs,
    boundaries: marks,
    xMax: Math.max(1, p.strokeCount),
    marker: state.viewing,
  });
  ui.chartCaption.textContent = marks.length
    ? "Vertical hairlines mark each look: the canvas the agent saw before its next batch of strokes."
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
      textContent: `Look ${s.look} · ${fmtSeconds(s.think_ms)}`,
    }),
  ];
  if (s.note) parts.push(el("div", { className: "chart-tooltip-note", textContent: s.note }));
  return el("div", {}, parts);
}

function renderLog() {
  const n = state.strokes.length;
  ui.logSummary.textContent = `Stroke log (${n} ${n === 1 ? "stroke" : "strokes"})`;
  const rows = state.strokes.map((s) => {
    const jump = el("button", { type: "button", className: "link-button", textContent: String(s.version) });
    jump.setAttribute("aria-label", `Show stroke ${s.version}`);
    jump.addEventListener("click", () => {
      stop();
      show(s.version);
      ui.img.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const tr = el("tr", {}, [
      el("td", { className: "num" }, [jump]),
      el("td", { className: "num", textContent: String(s.look) }),
      el("td", { className: "num", textContent: fmtSeconds(s.think_ms) }),
      el("td", { className: "num", textContent: fmtScore(s.score) }),
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
  ui.logBody.replaceChildren(...rows);
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
    if (p.blankScore !== null) parts.push(["Score", fmtScore(p.blankScore)]);
  } else if (s) {
    parts.push(["Stroke", `${s.version} of ${p.strokeCount}`]);
    parts.push(["Look", String(s.look)]);
    parts.push(["Think", fmtSeconds(s.think_ms)]);
    if (s.score !== null) parts.push(["Score", fmtScore(s.score)]);
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
  ui.currentRow = ui.logBody.querySelector(`tr[data-version="${state.viewing}"]`);
  ui.currentRow?.classList.add("current");
}

function stop() {
  state.playing = false;
  state.gen += 1;
  ui.play.textContent = "▶";
  ui.play.setAttribute("aria-label", "Play history");
}

async function start() {
  const gen = ++state.gen;
  state.playing = true;
  ui.play.textContent = "❚❚";
  ui.play.setAttribute("aria-label", "Pause");
  let v = state.viewing >= state.painting.strokeCount ? 0 : state.viewing;
  while (state.playing && gen === state.gen) {
    // Preload each frame before showing it, so playback never flashes blank.
    await preload(snapshotUrl(state.painting.id, v));
    if (!state.playing || gen !== state.gen) break;
    show(v);
    const n = Math.max(1, state.painting.strokeCount);
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(40, 6000 / n))));
    if (v >= state.painting.strokeCount) {
      stop();
      break;
    }
    v += 1;
  }
}

// ---------------------------------------------------------------- owner and duplicate

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
        setTimeout(refresh, 4500);
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

function renderDuplicate() {
  const p = state.painting;
  const stored = loadJson(paintingKey(p.id));
  const key = p.seriesId ? (stored?.series_key ?? loadSeriesKey(p.seriesId)) : null;
  const toggle = el("button", {
    type: "button",
    className: "button",
    textContent: "Duplicate with different settings",
  });
  toggle.setAttribute("aria-expanded", "false");
  const body = el("div", { className: "duplicate-body", hidden: true });
  body.id = "duplicate-body";
  toggle.setAttribute("aria-controls", body.id);
  toggle.addEventListener("click", () => {
    const open = body.hidden;
    if (open && !body.childElementCount) {
      if (key) {
        body.append(
          createForm({
            prefill: prefillFrom(p),
            series: { id: p.seriesId, key },
            submitLabel: "Create in this series",
          }),
        );
      } else {
        body.append(
          el("p", {
            className: "notice",
            textContent: p.seriesId
              ? "Only the browser that created this series can add paintings to it. You can still start a new painting (in a new series) with these settings."
              : "Pool paintings don't belong to a series. You can start a new painting with these settings.",
          }),
          createForm({ prefill: prefillFrom(p) }),
        );
      }
    }
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) body.querySelector("select")?.focus();
  });
  const intro = key
    ? "Start another painting in this series with these settings as a starting point."
    : "Start another painting with these settings as a starting point.";
  ui.duplicate.replaceChildren(
    el("h2", { textContent: "Duplicate" }),
    el("p", { className: "small muted" }, [
      intro,
      " ",
      el("a", { href: `/${prefillQuery(p)}`, textContent: "Open in the gallery form" }),
    ]),
    el("div", { className: "button-row" }, [toggle]),
    body,
  );
}

init();
