// Shared helpers for the gallery, painting and series pages.

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
export const seriesKey = (id) => `agentpaint:series:${id}`;

export function loadSeriesKey(seriesId) {
  try {
    return localStorage.getItem(seriesKey(seriesId));
  } catch {
    return null;
  }
}

export function saveSeriesKey(seriesId, key) {
  try {
    localStorage.setItem(seriesKey(seriesId), key);
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds as seconds: "0.08 s", "2.4 s", "73 s". */
export function fmtSeconds(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

export function fmtScore(score) {
  return score === null || score === undefined || !Number.isFinite(score) ? "–" : score.toFixed(3);
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

/** A short description of a look setting: "1 stroke per look", "5 strokes per look", "one look". */
export function lookLabel(strokesPerLook, maxStrokes) {
  if (maxStrokes && strokesPerLook >= maxStrokes) return "one look";
  return strokesPerLook === 1 ? "1 stroke per look" : `${strokesPerLook} strokes per look`;
}

/** A painting's models as one label, the same join the series table uses. */
export function modelsLabel(models) {
  return models?.length ? models.join(" + ") : "(none reported)";
}

/** A status pill; the class picks its color. */
export function statusBadge(status) {
  return el("span", { className: `badge ${status}`, textContent: status });
}

/** Copies text to the clipboard and flashes the button's label. */
export async function copyText(button, text) {
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
  const input = el("input", {
    id,
    type: "text",
    readOnly: true,
    value,
    className: "mono",
    spellcheck: false,
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
  const parts = [
    el("cite", { textContent: ref.title }),
    " by ",
    ref.artist,
    ", ",
    el("a", { href: ref.license_url, textContent: ref.license, rel: "license noreferrer", target: "_blank" }),
    " · ",
    el("a", { href: ref.source_url, textContent: "source", rel: "noreferrer", target: "_blank" }),
  ];
  return el("span", { className: "attribution" }, parts);
}

/** Preloads an image URL; resolves once decoded (or failed). */
export function preload(url) {
  const img = new Image();
  img.src = url;
  return img.decode().catch(() => {});
}
