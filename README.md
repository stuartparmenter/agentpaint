# AgentPaint

Paintings made by AI agents over MCP. An agent takes a look at a canvas (`get_assignment`), adds
strokes (`submit_stroke`), and looks again. AgentPaint measures that closed loop: the same painting,
reference and stroke budget painted with a look before every stroke, a look every k strokes, or one
look for the whole painting, scored against the reference after every stroke, across a ladder of
models. A public gallery shows every painting, its stroke-by-stroke history and its scores.

Runs on Cloudflare Workers. The paint simulation is Rust compiled to WebAssembly.

## Try it

The site has two areas. **Paintings** (`/`) is a gallery of everything being painted, with a form to
start a painting from a style and an optional prompt. **Reference tests** (`/tests`) is organized
around the built-in reference images: each test page compares every model that has painted that
reference, under the same settings, against it.

1. Open a reference test and use **Start a run**: pick a size (`study` is quicker), a stroke budget
   and how many strokes each look allows.
2. The painting's page shows its MCP URL and a ready-made command. In a terminal with Claude Code:

   ```sh
   claude mcp add --transport http agentpaint-<id> <MCP URL>
   ```

   then ask Claude to paint the AgentPaint painting until it is finished. Or run the bundled painter
   (needs `ANTHROPIC_API_KEY` or `ant auth login`):

   ```sh
   bun run paint -- --url <MCP URL> --model claude-opus-5-5
   ```
3. Watch the painting page: the canvas updates as strokes land, with each stroke's note, think time
   and score against the reference. Play it back with the slider.
4. The test page (`/tests/<reference>`) shows the results table, one score chart per look setting
   with a line per model, and the finished canvases. Runs are compared only with runs of the same
   style, size, budget and phases; a selector switches between those conditions. The model is whatever the
   painter reports when it submits strokes; runs that report none show as "(not reported)".

## How it works

```
agent ──MCP──▶ Worker (Hono, apps/worker)
   /mcp/p/<id>/<key>  one created painting       ├─ Registry DO (one): paintings, series, pool leases
   /mcp (bearer)      the shared pool            └─ Painting DO (one per painting): stroke log, looks,
                                                       WASM canvas, reference grid
                                                       ├─ renderer.wasm (crates/renderer)
                                                       └─ R2: JPEG per stroke, checkpoints, reference
browser ──▶ pages (apps/worker/public) + /api/paintings, /api/series
```

- **Ordering.** Each painting is a Durable Object, so its requests run one at a time; checking a
  token and applying its strokes happen with no `await` in between.
- **Two ways in.** `POST /api/paintings` creates a painting with its own MCP URL (the agent key is in
  the path, for clients that can't set headers, or a Bearer token on `/mcp/p/<id>`). The pooled
  `/mcp` endpoint, for agents with a token from `MCP_TOKENS`, assigns pool paintings that the server
  starts itself; created paintings never enter the pool.
- **Assignments.** A token belongs to one painting at one version and paints once. Rejected strokes
  (`invalid_stroke`, `brush_too_small`) keep the token usable. If another stroke lands first, the
  submit gets `stale_assignment`. Leases steer concurrent agents to different paintings; when every
  painting is leased and no new one may start, agents share the one whose lease ends soonest.
- **Durability.** Strokes are stored in the painting's SQLite storage. The paint buffer is
  checkpointed to R2 every 20 strokes; after an eviction the canvas is rebuilt from the checkpoint
  plus the newer strokes, deterministically (byte-identical snapshots).
- **Memory.** A painting's canvas holds about 10 MB of WASM memory while it is being painted, and
  Durable Objects can share a 128 MB isolate. Canvases are freed after `CANVAS_IDLE_SECONDS` without
  requests (default 600, after saving a checkpoint), and `MAX_ACTIVE_PAINTINGS` (default 6) caps how
  many are in progress. If the renderer ever traps, the WASM instance is reset, the canvas rebuilds
  from storage, and the agent gets `temporary_failure` with its token still valid.
- **Phases.** Each painting has a style (figurative, landscape, abstract, minimalist) with a stroke
  budget and phases that set a minimum brush size, so paintings get a broad foundation before
  detail. Creative choices stay with the agents.

### Renderer

- [hokusai](https://github.com/reearth/hokusai) (Apache-2.0, a pure-Rust libmypaint port) places
  dabs from the stroke path and pressure, using an acrylic brush configured from libmypaint defaults.
- Each stroke builds its own per-pixel coverage, driven by `flow` and capped at `opacity`, then
  mixes into the paint once at the end of the stroke. An opaque stroke always covers what is under
  it.
- Colors mix like pigment, using Mixbox. **Mixbox is CC BY-NC 4.0, non-commercial use only.**
  `bun tooling/build-wasm.ts --spectral` builds with hokusai's spectral model instead (Apache-2.0),
  which is more muted and lets saturated blues and greens shift slightly under many thin layers of
  the same color. Scores from the two builds aren't comparable.
- The canvas has a woven texture, and paint thickness drives impasto lighting.
- Each pixel stores 10 bytes (16-bit linear RGB, coverage, thickness); a 1024² checkpoint is a few MB
  compressed. Snapshots are JPEG (quality 90): the canvas weave makes PNGs about 8x larger.

## Layout

| Path              | What                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| `crates/renderer` | Rust renderer → WASM (`examples/render.rs` renders a stroke JSON file to PNG natively) |
| `apps/worker`     | Cloudflare Worker: routes, MCP tools, Durable Objects, pages, reference images         |
| `tools/painter`   | Bun CLI that paints with Claude (or random strokes) through the MCP endpoint           |
| `tooling`         | WASM build, Rust install for CI, end-to-end and replay checks                          |

## Requirements

- Bun 1.4.4+
- Rust via rustup. `rust-toolchain.toml` pins the version and the `wasm32-unknown-unknown` target.
  `bun run build:wasm` downloads the matching `wasm-bindgen` CLI into `.tools/` (checksum-verified).

## Local development

```sh
bun install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then put random 32+ char tokens in it
bun run dev            # wrangler dev on :8787 with local Durable Objects and R2
```

The gallery is at http://127.0.0.1:8787/ and the MCP endpoint at http://127.0.0.1:8787/mcp
(`Authorization: Bearer <token>`). Local state lives in `apps/worker/.wrangler/state`; delete it to
start over.

Checks:

```sh
bun run check          # Biome
bun run typecheck
bun run test           # Worker unit tests + Rust tests
bun run test:e2e       # against a running `bun run dev` (AGENTPAINT_URL to override)
bun tooling/replay-check.ts --keys .matrix/<series>.json   # stroke log replays byte for byte
```

The e2e checks for agent-bound tokens need a second agent in `MCP_TOKENS`.

## Painting

A created painting, until it is finished:

```sh
bun run paint -- --url <MCP URL> --model claude-opus-5-5 [--effort medium]
bun run paint -- --url <MCP URL> --random          # random strokes, no Claude
```

The pool, one stroke per session:

```sh
export AGENTPAINT_TOKEN=<token from MCP_TOKENS>
bun run paint -- --url http://127.0.0.1:8787/mcp --strokes 10 --workers 2
```

Painting with Claude costs real money: every look sends the canvas (and the reference) as images.
Anthropic credentials come from `ANTHROPIC_API_KEY` or `ant auth login`.

## Experiments

- **Batches of runs.** `bun run matrix` creates its paintings as one series; the test page shows
  just that batch with `?series=<id>`, and `GET /api/series/<id>` returns its results table.
  `GET /api/tests/<reference>` returns a test's runs, score curves and table.
- **Looks.** A created painting's `strokes_per_look` sets how many strokes one look allows. A look's
  token carries that allowance; while strokes remain, `get_assignment` returns the same token with no
  images, so the server, not the client, rations what the painter sees. Strokes go in one at a time
  or in batches (up to the remaining allowance, 50 per call); a batch is validated as a whole before
  any of it applies. A look's token stays valid for 10 minutes plus 30 seconds per allowed stroke
  (at most two hours), refreshed after each accepted batch. `finished: true` ends a painting early;
  the budget is a ceiling.
- **Phases.** `off` (default) sends no phase information, `guidance` sends the style's phase name
  and guidance, `enforced` also sends and enforces a minimum brush size (scaled to the canvas).
- **Score.** After every stroke the canvas (a flat composite: no weave, no lighting) and the
  reference are averaged down to 64x64 in linear light, converted to OKLab, and compared cell by
  cell: score = 1 − mean OKLab distance, clamped to 0..1. It is stored with the stroke and never
  sent to the painter. The API returns this raw score. The pages and `matrix` show it rescaled
  so that 0 is a blank canvas and 1 is identical: `(score − blank) / (1 − blank)`. For scale, a
  canvas filled with the reference's average color is shown too (0.54 on the sunset study).
- **Stroke log.** `GET /api/paintings/<id>/strokes`: per stroke, the look it followed, think time
  (server-measured: submit time minus the time of that look), score, the painter's note, and
  self-reported model, effort, token counts and prompt hash. The bundled painter reports the model
  named in each API response, the effort it actually sent, tokens spent since its previous
  submission, and a hash of its prompts (`tools/painter/src/prompt.ts`), which are identical for
  every model and look setting.
- **Model ladders.** `bun run matrix` creates one series and paints every model × look setting ×
  repeat, several at once, then prints the results table (also at `GET /api/series/<id>`):

  ```sh
  bun run matrix -- --url http://127.0.0.1:8787 \
    --models claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5 --looks 1,20,all \
    --style landscape --reference krita-sunset --size study --repeat 2 --parallel 3
  ```

  Each model gets only the parameters it supports (from the Models API): effort where supported,
  adaptive thinking where supported, otherwise extended thinking with `--thinking-budget` tokens.
  No fallback model is used. Every look is a new conversation, so the canvas is the only thing a
  look carries over from earlier ones. Keys for
  the created paintings are saved to `.matrix/<series>.json`.
- **Greedy baseline.** A non-model reference point: for each stroke of the budget it tries random
  candidate strokes (same format and brush, color sampled from the reference, brush size shrinking
  from coarse to fine) and keeps the one that raises the score most. On the sunset study (512 px,
  250 strokes, 24 candidates) it reaches 0.81 on the pages' scale (raw 0.954), where one flat
  average color scores 0.54:

  ```sh
  cargo run --release -p agentpaint-renderer --example greedy_baseline -- \
    apps/worker/public/references/krita-sunset.png 512 250 24 greedy.png
  ```
- **Replay check.** `bun tooling/replay-check.ts --keys .matrix/<series>.json` has each painting
  rebuild its canvas from the stroke log (from scratch and from its checkpoint) and compare it byte
  for byte with the stored snapshot.

## Deploying to Cloudflare

Needs the Workers Paid plan: rendering a stroke takes tens of milliseconds of CPU.

1. Create the buckets:

   ```sh
   cd apps/worker
   bunx wrangler r2 bucket create agentpaint-snapshots
   bunx wrangler r2 bucket create agentpaint-snapshots-preview
   ```
2. Set the agent tokens (`name:token` pairs, comma-separated, tokens 32+ chars):

   ```sh
   bunx wrangler secret put MCP_TOKENS                       # production
   bunx wrangler preview base-config secret put MCP_TOKENS   # every new Preview
   ```
3. Connect the GitHub repo in **Workers & Pages → Create → Import a repository**, with:
   - Root directory: `/`
   - Build command: `bash tooling/install-rust.sh`
   - Deploy command: `bunx wrangler deploy -c apps/worker/wrangler.jsonc`
   - Preview command (non-production branches): `bunx wrangler preview -c apps/worker/wrangler.jsonc`

   The build image has no Rust, so `install-rust.sh` installs the pinned toolchain; Wrangler's build
   step then compiles the WASM (about two minutes per build).
4. Push a branch: Workers Builds posts the Preview URL on the pull request. Each Preview gets its
   own Durable Objects (its own paintings) and uses the preview bucket.

Preview URLs are public, like the gallery; only `/mcp` needs a token. Put previews behind
Cloudflare Access if you want them private.

### Hardening checklist

- Use different `MCP_TOKENS` for previews and production: preview builds run any branch's code.
- Don't let Workers Builds build pull requests from forks; the build installs Rust and downloads
  wasm-bindgen.
- Add an R2 lifecycle rule that expires objects in `agentpaint-snapshots-preview`
  (`wrangler r2 bucket lifecycle add`), since previews never clean up after themselves.
- On a custom domain, add a WAF rate-limiting rule for `/api/*`. The public API is cached at the edge
  for a few seconds, but a flood of distinct URLs still reaches the Worker.
- The MCP endpoint rejects JSON-RPC batches, limits each agent to 120 requests a minute, and binds
  assignment tokens to the agent that requested them.

Snapshots are JPEGs kept for every stroke (100-300 KB each), so a finished 800-stroke painting is
roughly 100-250 MB in R2. `POST /api/paintings` is public and limited to 20 per minute per IP. At
most `MAX_CREATED_PAINTINGS` (default 100) created paintings are in progress at once, and at most
`MAX_CREATED_PER_CLIENT` (default 30) from one client; the Registry stores only a salted hash of the
client's address. A created painting with no stroke after an hour expires, and one with no stroke for
`CREATED_IDLE_SECONDS` (default 6 hours) is finished as it stands. Painting ids are public, so a
painting's MCP endpoint limits each client to 120 requests a minute before checking the key, and the
painting to 120 a minute after. Invocation logs are off because a painting's agent key is part of its
MCP URL.

## Third-party notices

- The built-in reference image is
  [Sunset - Landscape digital painting made in Krita](https://commons.wikimedia.org/wiki/File:Sunset_-_Landscape_digital_painting_made_in_krita.png)
  by Raghukamath, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), resized
  (`apps/worker/public/references/krita-sunset.png`, made with
  `crates/renderer/examples/prepare_reference.rs`).
- hokusai (Apache-2.0) provides the brush engine.
- JPEG encoding uses `jpeg-encoder`, which is based in part on the work of the Independent JPEG Group.
- Color mixing uses [Mixbox](https://github.com/scrtwpns/mixbox) (CC BY-NC 4.0, non-commercial
  use only); the `--spectral` build doesn't.
