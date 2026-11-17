// The create form. On the home page it asks for a style and prompt, with the
// stroke budget and look setting under "More options". On a reference test
// page it fixes the reference and prefills the test's condition.

import { el, getJson, paintingKey, saveJson, saveSeriesKey } from "./common.js";

const STYLES = ["landscape", "figurative", "abstract", "minimalist"];
const PHASES = ["off", "guidance", "enforced"];
const LOOK_HELP =
  "1 = a look at the canvas before every stroke; larger = several strokes per look; equal to max strokes = one look for the whole painting.";

let counter = 0;

/** Style budgets from the API ({name, max_strokes: {full, study}}), loaded once. */
let stylesPromise = null;
function loadStyles() {
  stylesPromise ??= getJson("/api/styles").catch(() => []);
  return stylesPromise;
}

function field(labelText, control, help) {
  control.id ||= `f${++counter}`;
  const children = [el("label", { htmlFor: control.id, textContent: labelText }), control];
  if (help) {
    const helpEl = el("div", { className: "help", id: `${control.id}-help`, textContent: help });
    control.setAttribute("aria-describedby", helpEl.id);
    children.push(helpEl);
  }
  return el("div", { className: "field" }, children);
}

function select(name, options, value) {
  const s = el(
    "select",
    { name },
    options.map((v) => el("option", { value: v, textContent: v[0].toUpperCase() + v.slice(1) })),
  );
  s.value = options.includes(value) ? value : options[0];
  return s;
}

function numberInput(name, value, placeholder) {
  return el("input", {
    type: "number",
    name,
    min: 1,
    max: 2000,
    step: 1,
    inputMode: "numeric",
    value: value ?? "",
    placeholder: placeholder ?? "",
  });
}

/**
 * Builds the form.
 * @param {object} [options]
 * @param {object} [options.prefill] {style, prompt, max_strokes, strokes_per_look}
 * @param {object} [options.test] {reference, style, size, max_strokes, phases}: test mode
 */
export function createForm({ prefill = {}, test = null } = {}) {
  const style = select("style", STYLES, test?.style ?? prefill.style);
  const prompt = el("textarea", {
    name: "prompt",
    rows: 2,
    maxLength: 500,
    placeholder: "Leave empty for an open subject",
    value: prefill.prompt ?? "",
  });
  const size = select("size", ["study", "full"], test?.size);
  const phases = select("phases", PHASES, test?.phases);
  const maxStrokes = numberInput("max_strokes", test?.max_strokes ?? prefill.max_strokes, "Style default");
  const perLook = numberInput("strokes_per_look", prefill.strokes_per_look ?? 1);
  perLook.required = true;

  // The max strokes placeholder shows the budget the API applies when it's empty.
  async function syncBudget() {
    const styles = await loadStyles();
    const budget = styles.find((s) => s.name === style.value)?.max_strokes;
    const sizeName = test ? size.value : "full";
    maxStrokes.placeholder = budget ? `Default ${budget[sizeName]}` : "Style default";
    return budget?.[sizeName] ?? null;
  }
  style.addEventListener("change", syncBudget);
  size.addEventListener("change", syncBudget);
  syncBudget();

  const lookField = field("Strokes per look", perLook, LOOK_HELP);
  const moreOpen = Boolean(prefill.max_strokes || Number(prefill.strokes_per_look) > 1);
  const fields = test
    ? [
        lookField,
        el("details", { className: "more" }, [
          el("summary", { textContent: "Change settings" }),
          el("div", { className: "more-body" }, [
            field("Style", style),
            el("div", { className: "field-pair" }, [field("Size", size), field("Phases", phases)]),
            field("Max strokes", maxStrokes),
          ]),
        ]),
      ]
    : [
        field("Style", style),
        field("Prompt (optional)", prompt),
        el("details", { className: "more", open: moreOpen }, [
          el("summary", { textContent: "More options" }),
          el("div", { className: "more-body" }, [field("Max strokes", maxStrokes), lookField]),
        ]),
      ];

  const error = el("div", { className: "error", hidden: true });
  error.setAttribute("role", "alert");
  const submitLabel = test ? "Create the run" : "Create painting";
  const submit = el("button", { type: "submit", className: "button primary", textContent: submitLabel });
  const form = el("form", { className: "create-form", noValidate: true }, [
    ...fields,
    error,
    el("div", { className: "button-row" }, [submit]),
  ]);

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
    if (test) Object.assign(body, { reference: test.reference, size: size.value, phases: phases.value });
    else body.prompt = prompt.value.trim() || null;
    const max = maxStrokes.value.trim();
    if (max) {
      const n = Number(max);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        showError("Max strokes must be a whole number from 1 to 2000.");
        return maxStrokes.focus();
      }
      body.max_strokes = n;
    }
    const spl = Number(perLook.value);
    const budget = body.max_strokes ?? (await syncBudget());
    if (!Number.isInteger(spl) || spl < 1) {
      showError("Strokes per look must be a whole number of at least 1.");
      return perLook.focus();
    }
    if (budget && spl > budget) {
      showError(`Strokes per look can't be more than max strokes (${budget}).`);
      return perLook.focus();
    }
    body.strokes_per_look = spl;

    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const created = await getJson("/api/paintings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      saveJson(paintingKey(created.id), {
        agent_key: created.agent_key,
        owner_key: created.owner_key,
        mcp_url: created.mcp_url,
        series_id: created.series_id,
        series_key: created.series_key,
      });
      if (created.series_key) saveSeriesKey(created.series_id, created.series_key);
      location.assign(`/p/${encodeURIComponent(created.id)}`);
    } catch (err) {
      const messages = {
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

const QUERY_KEYS = ["style", "prompt", "max_strokes", "strokes_per_look"];

/** Prefill from `?style=…&prompt=…` on the home page, or null without one. */
export function prefillFromQuery(search) {
  const q = new URLSearchParams(search);
  if (!QUERY_KEYS.some((k) => q.has(k))) return null;
  const out = {};
  for (const k of QUERY_KEYS) if (q.has(k)) out[k] = q.get(k);
  return out;
}

/** The home page query that `prefillFromQuery` reads back, for a painting's settings. */
export function prefillQuery(p) {
  const values = {
    style: p.style,
    prompt: p.prompt,
    max_strokes: p.maxStrokes,
    strokes_per_look: p.strokesPerLook,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== "") q.set(k, v);
  return `?${q}`;
}
