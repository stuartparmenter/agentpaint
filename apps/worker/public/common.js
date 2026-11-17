// Shared helpers for the paintings and reference test pages.

/** Creates an element, assigns its properties and appends children (nodes or strings). */
export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

export const snapshotUrl = (id, v) => `/api/paintings/${id}/v/${v}`;

/** Fetches JSON; throws an Error carrying `status` and the parsed body on a non-2xx response. */
export async function getJson(url, init) {
  const res = await fetch(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const error = new Error(body?.error ?? `request failed (${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

/** The last non-empty path segment, e.g. the id in `/p/<id>`. */
export function idFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

// localStorage can be missing, full or blocked; every access tolerates that.
export function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const paintingKey = (id) => `agentpaint:painting:${id}`;

/**
 * Runs `fn` every `ms` while the tab is visible, and once each time it becomes
 * visible again. Returns a function that stops it.
 */
export function poll(fn, ms) {
  const tick = () => {
    if (document.visibilityState === "visible") fn();
  };
  const timer = setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
  };
}

/** Replaces the page with an error message and a link away. */
export function fail(message, href, linkText) {
  const page = document.getElementById("page");
  page.removeAttribute("aria-busy");
  page.replaceChildren(
    el("p", { className: "error", textContent: message }),
    el("a", { href, textContent: linkText }),
  );
}

/** Milliseconds as seconds: "0.08 s", "2.4 s", "73 s". */
export function fmtSeconds(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

/**
 * A stored score on the scale the pages show: 0 is a blank canvas, 1 is identical
 * to the reference. The API keeps the raw score (1 - mean OKLab distance).
 */
function similarity(raw, blank) {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  if (blank === null || blank === undefined) return null;
  return (raw - blank) / (1 - blank);
}

export function fmtScore(raw, blank) {
  const s = similarity(raw, blank);
  return s === null ? "–" : s.toFixed(2);
}

export function fmtInt(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
}

/** A number with at most one decimal (for averages such as strokes used). */
export function fmtNum(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1);
}

export function fmtDate(ms) {
  if (!ms) return "–";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A look setting: "1 stroke per look", "5 strokes per look", or "One look" for the whole budget. */
export function lookLabel(strokesPerLook, maxStrokes) {
  if (maxStrokes && strokesPerLook >= maxStrokes) return "One look";
  return strokesPerLook === 1 ? "1 stroke per look" : `${strokesPerLook} strokes per look`;
}

/** A painting's look setting as a badge. */
export function lookBadge(p) {
  return el("span", {
    className: "badge look",
    title: "Look setting",
    textContent: lookLabel(p.strokesPerLook, p.maxStrokes),
  });
}

/**
 * The chart anchors for a reference: dashed lines at the blank canvas (0) and at
 * a canvas painted one flat average color, and `curve`, which turns [stroke, raw
 * score] pairs into chart points starting from the blank canvas at stroke 0.
 * Without a blank score there are no lines and every curve is empty.
 */
export function anchorRefs(blank, meanColor) {
  if (blank === null || blank === undefined) return { refs: [], curve: () => [] };
  const refs = [{ y: 0, label: "blank canvas" }];
  const flat = similarity(meanColor, blank);
  if (flat !== null) refs.push({ y: flat, label: "flat average color" });
  const curve = (pairs) => [{ x: 0, y: 0 }, ...pairs.map(([x, raw]) => ({ x, y: similarity(raw, blank) }))];
  return { refs, curve };
}

/** A data table with a hidden caption; `head` is [text, class] pairs. */
export function table(caption, head, rows) {
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

/** A status pill; the class picks its color. */
export function statusBadge(status) {
  return el("span", { className: `badge ${status}`, textContent: status });
}

/** Copies text to the clipboard and flashes the button's label. */
async function copyText(button, text) {
  const label = button.textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = false;
  }
  button.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
}

/** A read-only value with a copy button. */
export function copyField(labelText, value) {
  const id = `copy-${Math.random().toString(36).slice(2, 9)}`;
  // A long value (such as a command) wraps in a text area instead of scrolling in one line.
  const long = value.length > 90;
  const input = el(long ? "textarea" : "input", {
    id,
    readOnly: true,
    value,
    className: "mono",
    spellcheck: false,
    ...(long ? { rows: 3 } : { type: "text" }),
  });
  input.addEventListener("focus", () => input.select());
  const button = el("button", { type: "button", className: "button small", textContent: "Copy" });
  button.setAttribute("aria-label", `Copy ${labelText}`);
  button.addEventListener("click", () => copyText(button, value));
  return el("div", { className: "copy-field" }, [
    el("label", { htmlFor: id, textContent: labelText }),
    el("div", { className: "copy-row" }, [input, button]),
  ]);
}

/** Loads the built-in references once per page. */
let referencesPromise = null;
export function loadReferences() {
  referencesPromise ??= getJson("/api/references").catch((e) => {
    referencesPromise = null;
    throw e;
  });
  return referencesPromise;
}

/** "Title" by Artist, License (linked), Source (linked). */
export function attribution(ref) {
  return el("span", { className: "attribution" }, [
    el("cite", { textContent: ref.title }),
    " by ",
    ref.artist,
    ", ",
    el("a", { href: ref.licenseUrl, textContent: ref.license, rel: "license noreferrer", target: "_blank" }),
    " · ",
    el("a", { href: ref.sourceUrl, textContent: "source", rel: "noreferrer", target: "_blank" }),
  ]);
}

/** Preloads an image URL; resolves once decoded (or failed). */
function preload(url) {
  const img = new Image();
  img.src = url;
  return img.decode().catch(() => {});
}

/**
 * Play/pause for a painting's stroke history. Returns the play button and a
 * `stop()`; `playing` is true while it runs. Playback starts from `current()`
 * (or from 0 at the last stroke), preloads each frame before `show(v)` so it
 * never flashes blank, waits `delay(strokes)` ms per frame, and stops at `last()`.
 */
export function playback({ className = "", frameUrl, current, last, show, delay }) {
  const button = el("button", { type: "button", className });
  // `gen` increments whenever playback starts or stops, so a superseded loop exits.
  let gen = 0;
  const control = {
    button,
    playing: false,
    stop() {
      control.playing = false;
      gen += 1;
      button.textContent = "▶";
      button.setAttribute("aria-label", "Play history");
    },
  };
  async function play() {
    const mine = ++gen;
    control.playing = true;
    button.textContent = "❚❚";
    button.setAttribute("aria-label", "Pause");
    let v = current() >= last() ? 0 : current();
    while (mine === gen) {
      await preload(frameUrl(v));
      if (mine !== gen) return;
      show(v);
      await new Promise((r) => setTimeout(r, delay(Math.max(1, last()))));
      if (mine !== gen) return;
      if (v >= last()) return control.stop();
      v += 1;
    }
  }
  button.addEventListener("click", () => (control.playing ? control.stop() : play()));
  control.stop();
  return control;
}
