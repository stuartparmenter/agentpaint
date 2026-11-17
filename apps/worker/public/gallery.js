import {
  el,
  getJson,
  loadReferences,
  lookBadge,
  playback,
  poll,
  snapshotUrl,
  statusBadge,
} from "./common.js";
import { createForm, prefillFromQuery } from "./create-form.js";

const state = new Map(); // id -> { strokeCount, viewing, player, els }
const container = document.getElementById("paintings");
// Reference titles for the test badges, keyed by id; badges use the id until these load.
const referenceTitles = new Map();
loadReferences()
  .then((refs) => {
    for (const r of refs) referenceTitles.set(r.id, r.title);
  })
  .catch(() => {});

// The create form: open on wide screens or when prefilled from the URL, collapsed on narrow ones.
const prefill = prefillFromQuery(location.search);
document.getElementById("create-form").append(createForm({ prefill: prefill ?? {} }));
const createPanel = document.getElementById("create");
if (!prefill && window.matchMedia("(max-width: 899px)").matches) createPanel.open = false;
if (prefill) createPanel.querySelector("select")?.focus();

function createCard(p) {
  const href = `/p/${encodeURIComponent(p.id)}`;
  const img = el("img", { alt: `Painting ${p.id}`, loading: "lazy", decoding: "async" });
  const prompt = el("a", { className: "prompt", href });
  const style = el("span");
  const badges = el("span", { className: "badges" });
  const slider = el("input", { type: "range", min: 0 });
  slider.setAttribute("aria-label", "Stroke history");
  const version = el("span", { className: "version" });
  const s = {
    strokeCount: p.strokeCount,
    viewing: p.strokeCount,
    els: { img, prompt, style, badges, slider, version },
  };
  s.player = playback({
    frameUrl: (v) => snapshotUrl(p.id, v),
    current: () => s.viewing,
    last: () => s.strokeCount,
    show: (v) => show(p.id, s, v),
    delay: (n) => Math.max(40, 4000 / n),
  });
  slider.addEventListener("input", () => {
    s.player.stop();
    show(p.id, s, Number(slider.value));
  });
  const imageLink = el("a", { href, tabIndex: -1 }, [img]);
  imageLink.setAttribute("aria-hidden", "true");
  state.set(p.id, s);
  return el("article", { className: "card" }, [
    imageLink,
    el("div", { className: "body" }, [
      prompt,
      el("div", { className: "row" }, [style, badges]),
      el("div", { className: "controls" }, [s.player.button, slider, version]),
    ]),
  ]);
}

function updateCard(p, s) {
  const { prompt, style, badges, slider } = s.els;
  prompt.textContent = p.prompt ?? "Open subject";
  prompt.title = prompt.textContent;
  style.textContent = `${p.style} · ${p.strokeCount}/${p.maxStrokes} strokes`;
  // Status can change without a new stroke (done → archived), so badges always refresh.
  badges.replaceChildren(
    ...(p.reference ? [testBadge(p.reference)] : []),
    ...(p.kind === "created" ? [lookBadge(p)] : []),
    statusBadge(p.status),
  );
  const followingLatest = s.viewing === s.strokeCount;
  s.strokeCount = p.strokeCount;
  slider.max = p.strokeCount;
  if (followingLatest && !s.player.playing) show(p.id, s, p.strokeCount);
  else label(s);
}

/** "Test: Sunset" linking to the reference's test page; the short title is the text before the first comma. */
function testBadge(reference) {
  const title = referenceTitles.get(reference) ?? reference;
  return el("a", {
    className: "badge look",
    href: `/tests/${encodeURIComponent(reference)}`,
    textContent: `Test: ${title.split(",")[0]}`,
    title: `Reference test: ${title}`,
  });
}

function label(s) {
  s.els.version.textContent = `${s.viewing} / ${s.strokeCount}`;
  s.els.slider.value = s.viewing;
}

function show(id, s, v) {
  s.viewing = v;
  label(s);
  const url = snapshotUrl(id, v);
  if (s.els.img.getAttribute("src") !== url) s.els.img.src = url;
}

async function refresh() {
  try {
    const paintings = await getJson("/api/paintings");
    if (paintings.length === 0 && !container.children.length) {
      container.append(
        el("p", {
          className: "empty",
          textContent: "No paintings yet. Create one, or connect an agent to start painting.",
        }),
      );
      return;
    }
    container.querySelector(".empty")?.remove();
    for (const p of paintings) {
      if (!state.has(p.id)) container.append(createCard(p));
      updateCard(p, state.get(p.id));
    }
  } catch (e) {
    console.error("refresh failed", e);
  }
}

refresh();
poll(refresh, 5000);
