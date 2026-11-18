// The create form. On the home page it asks for a style and prompt, with the
// stroke budget, strokes per assignment and whether the agent can end the painting
// early under "More options". On a reference test page it fixes the reference and
// prefills the test's condition.

import { el, getJson, paintingKey, saveJson } from "./common.js";

const ASSIGNMENT_HELP =
  "Each assignment shows the agent the canvas and allows this many strokes; it sees the result at the next assignment. 1 = it sees the canvas before every stroke; equal to max strokes = it sees the canvas once, at the start.";

const FINISH_HELP =
  "Unchecked, submit_stroke has no finished option and the painting ends when its stroke budget is used.";

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

function checkboxField(labelText, control, help) {
  control.id ||= `f${++counter}`;
  const helpEl = el("div", { className: "help", id: `${control.id}-help`, textContent: help });
  control.setAttribute("aria-describedby", helpEl.id);
  return el("div", { className: "field" }, [
    el("div", { className: "check" }, [
      control,
      el("label", { htmlFor: control.id, textContent: labelText }),
    ]),
    helpEl,
  ]);
}

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
 * @param {object} [options.prefill] {style, prompt, max_strokes, strokes_per_assignment, allow_finish}
 * @param {object} [options.test] {reference, style, size, max_strokes, allow_finish}: test mode
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
  const maxStrokes = numberInput("max_strokes", test?.max_strokes ?? prefill.max_strokes, "Style default");
  const perAssignment = numberInput("strokes_per_assignment", prefill.strokes_per_assignment ?? 1);
  perAssignment.required = true;
  const allowFinish = el("input", {
    type: "checkbox",
    name: "allow_finish",
    checked: (test?.allow_finish ?? prefill.allow_finish) !== false,
  });

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
  const finishField = checkboxField("Agent can end the painting early", allowFinish, FINISH_HELP);
  const moreOpen = Boolean(
    prefill.max_strokes || Number(prefill.strokes_per_assignment) > 1 || prefill.allow_finish === false,
  );
  const fields = test
    ? [
        assignmentField,
        el("details", { className: "more" }, [
          el("summary", { textContent: "Change settings" }),
          el("div", { className: "more-body" }, [
            field("Style", style),
            field("Size", size),
            field("Max strokes", maxStrokes),
            finishField,
          ]),
        ]),
      ]
    : [
        field("Style", style),
        field("Prompt (optional)", prompt),
        el("details", { className: "more", open: moreOpen }, [
          el("summary", { textContent: "More options" }),
          el("div", { className: "more-body" }, [
            field("Max strokes", maxStrokes),
            assignmentField,
            finishField,
          ]),
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
    if (test) Object.assign(body, { reference: test.reference, size: size.value });
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
    body.allow_finish = allowFinish.checked;

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

const QUERY_KEYS = ["style", "prompt", "max_strokes", "strokes_per_assignment", "allow_finish"];

/** Prefill from `?style=…&prompt=…` on the home page, or null without one. */
export function prefillFromQuery(search) {
  const q = new URLSearchParams(search);
  if (!QUERY_KEYS.some((k) => q.has(k))) return null;
  const out = {};
  for (const k of QUERY_KEYS) if (q.has(k)) out[k] = q.get(k);
  if ("allow_finish" in out) out.allow_finish = out.allow_finish !== "false";
  return out;
}

/** The home page query that `prefillFromQuery` reads back, for a painting's settings. */
export function prefillQuery(p) {
  const values = {
    style: p.style,
    prompt: p.prompt,
    max_strokes: p.maxStrokes,
    strokes_per_assignment: p.strokesPerAssignment,
    allow_finish: p.allowFinish ? null : "false",
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== "") q.set(k, v);
  return `?${q}`;
}
