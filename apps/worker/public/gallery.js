import { el, lookLabel, preload, snapshotUrl } from "./common.js";
import { createForm, prefillFromQuery } from "./create-form.js";

const state = new Map(); // id -> { strokeCount, viewing, playing, gen, els }
const container = document.getElementById("paintings");

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
  const play = el("button", { type: "button", textContent: "▶" });
  play.setAttribute("aria-label", "Play history");
  const slider = el("input", { type: "range", min: 0 });
  slider.setAttribute("aria-label", "Stroke history");
  const version = el("span", { className: "version" });
  const imageLink = el("a", { href, tabIndex: -1 }, [img]);
  imageLink.setAttribute("aria-hidden", "true");
  const card = el("article", { className: "card" }, [
    imageLink,
    el("div", { className: "body" }, [
      prompt,
      el("div", { className: "row" }, [style, badges]),
      el("div", { className: "controls" }, [play, slider, version]),
    ]),
  ]);
  // `gen` increments whenever playback starts or stops, so a superseded loop exits.
  const s = {
    strokeCount: p.strokeCount,
    viewing: p.strokeCount,
    playing: false,
    gen: 0,
    els: { img, prompt, style, badges, play, slider, version },
  };
  slider.addEventListener("input", () => {
    stop(s);
    show(p.id, s, Number(slider.value));
  });
  play.addEventListener("click", () => (s.playing ? stop(s) : start(p.id, s)));
  state.set(p.id, s);
  return card;
}

function updateCard(p, s) {
  const { prompt, style, badges, slider } = s.els;
  prompt.textContent = p.prompt ?? "Open subject";
  prompt.title = prompt.textContent;
  style.textContent = `${p.style} · ${p.strokeCount}/${p.maxStrokes} strokes`;
  // Status can change without a new stroke (done → archived), so badges always refresh.
  const status = el("span", { className: `badge ${p.status}`, textContent: p.status });
  if (p.kind === "created") {
    const look = el("span", {
      className: "badge look",
      textContent: lookLabel(p.strokesPerLook, p.maxStrokes),
    });
    look.title = "Look setting";
    badges.replaceChildren(look, status);
  } else {
    badges.replaceChildren(status);
  }
  const followingLatest = s.viewing === s.strokeCount;
  s.strokeCount = p.strokeCount;
  slider.max = p.strokeCount;
  if (followingLatest && !s.playing) show(p.id, s, p.strokeCount);
  else label(s);
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

function stop(s) {
  s.playing = false;
  s.gen += 1;
  s.els.play.textContent = "▶";
  s.els.play.setAttribute("aria-label", "Play history");
}

async function start(id, s) {
  const gen = ++s.gen;
  s.playing = true;
  s.els.play.textContent = "❚❚";
  s.els.play.setAttribute("aria-label", "Pause");
  let v = s.viewing >= s.strokeCount ? 0 : s.viewing;
  while (s.playing && gen === s.gen) {
    // Preload each frame before showing it, so playback never flashes blank.
    await preload(snapshotUrl(id, v));
    if (!s.playing || gen !== s.gen) break;
    show(id, s, v);
    await new Promise((r) => setTimeout(r, Math.max(40, 4000 / Math.max(1, s.strokeCount))));
    if (v >= s.strokeCount) {
      stop(s);
      break;
    }
    v += 1;
  }
}

async function refresh() {
  try {
    const res = await fetch("/api/paintings");
    if (!res.ok) throw new Error(res.status);
    const paintings = await res.json();
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
setInterval(refresh, 5000);
