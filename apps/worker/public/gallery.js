const state = new Map(); // id -> { strokeCount, viewing, playing, els }
const container = document.getElementById("paintings");

const snapshotUrl = (id, v) => `/api/paintings/${id}/v/${v}`;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

function createCard(p) {
  const img = el("img", { alt: `Painting ${p.id}`, loading: "lazy", decoding: "async" });
  const prompt = el("div", { className: "prompt" });
  const style = el("span");
  const badge = el("span", { className: "badge" });
  const play = el("button", { type: "button", textContent: "▶", ariaLabel: "Play history" });
  const slider = el("input", { type: "range", min: 0, ariaLabel: "Stroke history" });
  const version = el("span", { className: "version" });
  const card = el("article", { className: "card" }, [
    img,
    el("div", { className: "body" }, [
      prompt,
      el("div", { className: "row" }, [style, badge]),
      el("div", { className: "controls" }, [play, slider, version]),
    ]),
  ]);
  // `gen` increments whenever playback starts or stops, so a superseded loop exits.
  const s = {
    strokeCount: p.strokeCount,
    viewing: p.strokeCount,
    playing: false,
    gen: 0,
    els: { img, prompt, style, badge, play, slider, version },
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
  const { prompt, style, badge, slider } = s.els;
  prompt.textContent = p.prompt ?? "Open subject";
  prompt.title = prompt.textContent;
  style.textContent = `${p.style} · ${p.medium} · ${p.strokeCount}/${p.maxStrokes} strokes`;
  // Status can change without a new stroke (done → archived), so always refresh it.
  badge.className = `badge ${p.status}`;
  badge.textContent = p.status;
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
}

async function start(id, s) {
  const gen = ++s.gen;
  s.playing = true;
  s.els.play.textContent = "❚❚";
  let v = s.viewing >= s.strokeCount ? 0 : s.viewing;
  while (s.playing && gen === s.gen) {
    // Preload each frame before showing it, so playback never flashes blank.
    const frame = new Image();
    frame.src = snapshotUrl(id, v);
    await frame.decode().catch(() => {});
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
        el("p", { className: "empty", textContent: "No paintings yet. Connect an agent to start painting." }),
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
