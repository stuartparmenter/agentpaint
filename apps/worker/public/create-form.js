// The "new painting" form, used on the home page and (prefilled, joining a
// series) on a painting's page.

import { attribution, el, getJson, loadReferences, paintingKey, saveJson, saveSeriesKey } from "./common.js";

const STYLES = [
  ["landscape", "Landscape"],
  ["figurative", "Figurative"],
  ["abstract", "Abstract"],
  ["minimalist", "Minimalist"],
];
const SIZES = [
  ["full", "Full", "1024 px on the long side."],
  ["study", "Study", "512 px on the long side, about a quarter of the strokes."],
];
const PHASES = [
  ["off", "Off"],
  ["guidance", "Guidance"],
  ["enforced", "Enforced"],
];
const PHASE_HELP = {
  off: "The agent gets no phase information.",
  guidance: "The agent is told the current phase (foundation → detail) and its guidance.",
  enforced: "Guidance, plus each phase's minimum brush size is enforced.",
};

let counter = 0;

function field(labelText, control, help) {
  const id = control.id || `f${++counter}`;
  control.id = id;
  const children = [el("label", { htmlFor: id, textContent: labelText }), control];
  if (help) {
    const helpEl = el("div", { className: "help", id: `${id}-help`, textContent: help });
    control.setAttribute("aria-describedby", helpEl.id);
    children.push(helpEl);
  }
  return el("div", { className: "field" }, children);
}

function radios(name, legendText, options, value) {
  const group = el(
    "div",
    { className: "segmented" },
    options.map(([v, text]) =>
      el("label", {}, [el("input", { type: "radio", name, value: v, checked: v === value }), text]),
    ),
  );
  return el("fieldset", { className: "field" }, [el("legend", { textContent: legendText }), group]);
}

/**
 * Builds the form.
 * @param {object} [options]
 * @param {object} [options.prefill] {style, prompt, reference, size, max_strokes, strokes_per_look, phases}
 * @param {{id: string, key: string}} [options.series] posts into this series when set
 * @param {string} [options.submitLabel]
 */
export function createForm({ prefill = {}, series = null, submitLabel = "Create painting" } = {}) {
  const name = `cf${++counter}`;
  const style = el(
    "select",
    { name: "style" },
    STYLES.map(([v, text]) => el("option", { value: v, textContent: text })),
  );
  style.value = STYLES.some(([v]) => v === prefill.style) ? prefill.style : "landscape";

  const prompt = el("textarea", {
    name: "prompt",
    rows: 2,
    maxLength: 500,
    placeholder: "Leave empty for an open subject",
    value: prefill.prompt ?? "",
  });

  const reference = el("select", { name: "reference" }, [el("option", { value: "", textContent: "None" })]);
  const preview = el("div", { className: "reference-preview", hidden: true });
  let references = [];
  loadReferences()
    .then((list) => {
      references = list;
      for (const r of list) reference.append(el("option", { value: r.id, textContent: r.title }));
      if (prefill.reference && list.some((r) => r.id === prefill.reference))
        reference.value = prefill.reference;
      updatePreview();
    })
    .catch(() => {
      reference.disabled = true;
      reference.title = "References could not be loaded";
    });
  function updatePreview() {
    const r = references.find((x) => x.id === reference.value);
    preview.hidden = !r;
    if (!r) return preview.replaceChildren();
    preview.replaceChildren(
      el("img", {
        src: r.url,
        alt: `Reference: ${r.title}`,
        width: 96,
        height: Math.round((96 * r.height) / r.width),
      }),
      el("div", {}, [
        el("div", { textContent: "The agent sees this image and each stroke is scored against it." }),
        attribution(r),
      ]),
    );
  }
  reference.addEventListener("change", updatePreview);

  const size = radios(`${name}-size`, "Size", SIZES, prefill.size === "study" ? "study" : "full");
  const sizeHelp = el("div", { className: "help" });
  size.append(sizeHelp);

  const maxStrokes = el("input", {
    type: "number",
    name: "max_strokes",
    min: 1,
    max: 2000,
    step: 1,
    inputMode: "numeric",
    placeholder: "Style default",
    value: prefill.max_strokes ?? "",
  });
  const perLook = el("input", {
    type: "number",
    name: "strokes_per_look",
    min: 1,
    max: 2000,
    step: 1,
    inputMode: "numeric",
    required: true,
    value: prefill.strokes_per_look ?? 1,
  });

  const phases = radios(
    `${name}-phases`,
    "Phases",
    PHASES,
    PHASES.some(([v]) => v === prefill.phases) ? prefill.phases : "off",
  );
  const phaseHelp = el("div", { className: "help" });
  phases.append(phaseHelp);

  // Each style's default stroke budget per size, from /api/styles.
  let budgets = null;
  fetch("/api/styles")
    .then((r) => (r.ok ? r.json() : null))
    .then((list) => {
      budgets = list;
      syncHelp();
    })
    .catch(() => {});

  function syncHelp() {
    const s = form.querySelector(`input[name="${name}-size"]:checked`)?.value ?? "full";
    sizeHelp.textContent = SIZES.find(([v]) => v === s)?.[2] ?? "";
    const budget = budgets?.find((b) => b.name === style.value)?.max_strokes?.[s];
    maxStrokes.placeholder = budget ? `Default: ${budget}` : "Style default";
    const ph = form.querySelector(`input[name="${name}-phases"]:checked`)?.value ?? "off";
    phaseHelp.textContent = PHASE_HELP[ph];
  }

  const error = el("div", { className: "error", hidden: true });
  error.setAttribute("role", "alert");
  const submit = el("button", { type: "submit", className: "button primary", textContent: submitLabel });

  const form = el("form", { className: "create-form", noValidate: true }, [
    series
      ? el("p", {
          className: "notice",
          textContent:
            "The new painting joins this painting's series, so their results are compared side by side.",
        })
      : null,
    field("Style", style),
    field("Prompt (optional)", prompt),
    field("Reference", reference, "With a reference, every stroke gets a similarity score."),
    preview,
    size,
    el("div", { className: "field-pair" }, [
      field("Max strokes (optional)", maxStrokes),
      field("Strokes per look", perLook),
    ]),
    el("div", {
      className: "help small muted",
      textContent:
        "Strokes per look: 1 = a look at the canvas before every stroke; larger = several strokes per look; equal to max strokes = one look for the whole painting. Max strokes defaults to the style's budget for the size.",
    }),
    phases,
    error,
    el("div", { className: "button-row" }, [submit]),
  ]);
  form.addEventListener("change", syncHelp);
  syncHelp();

  function showError(message, issues) {
    error.replaceChildren(el("div", { textContent: message }));
    if (issues?.length)
      error.append(
        el(
          "ul",
          {},
          issues.map((i) => el("li", { textContent: String(i) })),
        ),
      );
    error.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    const body = { style: style.value };
    const text = prompt.value.trim();
    body.prompt = text ? text : null;
    body.reference = reference.value || null;
    body.size = form.querySelector(`input[name="${name}-size"]:checked`)?.value ?? "full";
    body.phases = form.querySelector(`input[name="${name}-phases"]:checked`)?.value ?? "off";
    const max = maxStrokes.value.trim();
    if (max) {
      const n = Number(max);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        showError("Max strokes must be a whole number from 1 to 2000.");
        maxStrokes.focus();
        return;
      }
      body.max_strokes = n;
    }
    const spl = Number(perLook.value);
    if (!Number.isInteger(spl) || spl < 1) {
      showError("Strokes per look must be a whole number of at least 1.");
      perLook.focus();
      return;
    }
    if (body.max_strokes && spl > body.max_strokes) {
      showError("Strokes per look can't be more than max strokes.");
      perLook.focus();
      return;
    }
    body.strokes_per_look = spl;
    if (series) {
      body.series = series.id;
      body.series_key = series.key;
    }

    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const created = await getJson("/api/paintings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const seriesKeyValue = created.series_key ?? series?.key ?? null;
      saveJson(paintingKey(created.id), {
        agent_key: created.agent_key,
        owner_key: created.owner_key,
        mcp_url: created.mcp_url,
        series_id: created.series_id,
        series_key: seriesKeyValue,
      });
      if (created.series_key) saveSeriesKey(created.series_id, created.series_key);
      location.assign(`/p/${encodeURIComponent(created.id)}`);
    } catch (err) {
      const messages = {
        403: "This browser doesn't have the right key for that series.",
        404: "That series doesn't exist.",
        409: "There are too many paintings right now. Try again later.",
        429: "Too many paintings created from here. Wait a minute and try again.",
      };
      showError(
        messages[err.status] ?? `Couldn't create the painting: ${err.body?.error ?? err.message}`,
        err.body?.issues,
      );
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });

  return form;
}

/** Form settings for a painting, for prefilling a duplicate. */
export function prefillFrom(p) {
  return {
    style: p.style,
    prompt: p.prompt ?? "",
    reference: p.reference ?? "",
    size: p.size ?? "full",
    max_strokes: p.maxStrokes,
    strokes_per_look: p.strokesPerLook,
    phases: p.phases,
  };
}

/** Prefill from `?style=…&prompt=…` on the home page. */
export function prefillFromQuery(search) {
  const q = new URLSearchParams(search);
  const keys = ["style", "prompt", "reference", "size", "max_strokes", "strokes_per_look", "phases"];
  if (!keys.some((k) => q.has(k))) return null;
  const out = {};
  for (const k of keys) if (q.has(k)) out[k] = q.get(k);
  return out;
}

/** Query string that `prefillFromQuery` reads back. */
export function prefillQuery(p) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(prefillFrom(p)))
    if (v !== "" && v !== null && v !== undefined) q.set(k, v);
  return `?${q}`;
}
