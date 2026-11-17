// The create form. On the home page it asks for a style and prompt, with the
// stroke budget and strokes per assignment under "More options". On a reference test
// page it fixes the reference and prefills the test's condition.

import { el, getJson, paintingKey, saveJson } from "./common.js";

const PHASES = ["off", "guidance", "enforced"];
const ASSIGNMENT_HELP =
  "Each assignment shows the agent the canvas and allows this many strokes; it sees the result at the next assignment. 1 = it sees the canvas before every stroke; equal to max strokes = it sees the canvas once, at the start.";

let counter = 0;

/** Styles from the API ({name, max_strokes: {full, study}}), in its order, loaded once. */
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

const option = (v) => el("option", { value: v, textContent: v[0].toUpperCase() + v.slice(1) });

function select(name, options, value) {
  const s = el("select", { name }, options.map(option));
  s.value = options.includes(value) ? value : options[0];
  return s;
}

function numberInput(name, value, placeholder) {
  return el("input", {
    type: "number",
    name,
    min: 1,
    step: 1,
    inputMode: "numeric",
    value: value ?? "",
    placeholder: placeholder ?? "",
  });
}

/**
 * Builds the form.
 * @param {object} [options]
 * @param {object} [options.prefill] {style, prompt, max_strokes, strokes_per_assignment}
 * @param {object} [options.test] {reference, style, size, max_strokes, phases}: test mode
 */
export function createForm({ prefill = {}, test = null } = {}) {
  // The style options arrive with the styles; the first is the default.
  const style = el("select", { name: "style" });
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
  const perAssignment = numberInput("strokes_per_assignment", prefill.strokes_per_assignment ?? 1);
  perAssignment.required = true;

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
  loadStyles().then((styles) => {
    const names = styles.map((s) => s.name);
    style.append(...names.map(option));
    const wanted = test?.style ?? prefill.style;
    if (names.includes(wanted)) style.value = wanted;
    syncBudget();
  });

  const assignmentField = field("Strokes per assignment", perAssignment, ASSIGNMENT_HELP);
  const moreOpen = Boolean(prefill.max_strokes || Number(prefill.strokes_per_assignment) > 1);
  const fields = test
    ? [
        assignmentField,
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
          el("div", { className: "more-body" }, [field("Max strokes", maxStrokes), assignmentField]),
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
    if (maxStrokes.value) body.max_strokes = Number(maxStrokes.value);
    const spl = Number(perAssignment.value);
    const budget = body.max_strokes ?? (await syncBudget());
    if (!Number.isInteger(spl) || spl < 1) {
      showError("Strokes per assignment must be a whole number of at least 1.");
      return perAssignment.focus();
    }
    if (budget && spl > budget) {
      showError(`Strokes per assignment can't be more than max strokes (${budget}).`);
      return perAssignment.focus();
    }
    body.strokes_per_assignment = spl;

    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const created = await getJson("/api/paintings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      saveJson(paintingKey(created.id), { mcp_url: created.mcp_url, owner_key: created.owner_key });
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

const QUERY_KEYS = ["style", "prompt", "max_strokes", "strokes_per_assignment"];

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
    strokes_per_assignment: p.strokesPerAssignment,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== "") q.set(k, v);
  return `?${q}`;
}
