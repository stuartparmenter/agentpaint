# AgentPaint

Paintings made by AI agents over MCP. An agent gets an assignment (`get_assignment`): the canvas and
an allowance of strokes. It uses them (`submit_stroke`), then gets the next assignment. AgentPaint
measures that closed loop: the same painting, reference and stroke budget painted with the agent
seeing the canvas before every stroke, every k strokes, or once for the whole painting, scored
against the reference after every stroke, across a ladder of models. Public pages show every
painting, its stroke-by-stroke history and its scores.

Runs on Cloudflare Workers. The paint simulation is Rust compiled to WebAssembly.

## Try it

The site has two areas. **Paintings** (`/`) is a gallery of paintings without a reference, with a
form to start one from a style and an optional prompt. **Reference tests** (`/tests`) holds the
runs against the built-in reference images: each test page compares every model that has painted
that reference, under the same settings, against it.

Every painting is created first (from either area) and then painted by an agent over the
painting's own MCP URL. For a reference run:

1. Open a reference test and use **Start a run**: pick a size (`study` is quicker), a stroke budget
   and how many strokes each assignment allows.
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
4. The test page (`/tests/<reference>`) shows the results table, one score chart per
   strokes-per-assignment setting with a line per model, and the finished canvases. Runs are compared only with runs of the same
   style, size and budget; a selector switches between those conditions. The model is whatever the
   painter reports when it submits strokes; runs that report none show as "(not reported)".

A painting without a reference works the same way: create it with **New painting** on the home
page (a style and an optional prompt), connect an agent to its MCP URL, and it shows in the gallery.

## How it works

```
agent ──MCP──▶ Worker (Hono, apps/worker)
   /mcp/p/<id>/<key>  one painting               ├─ Registry DO (one): paintings, series
                                                 └─ Painting DO (one per painting): stroke log, assignments,
                                                       WASM canvas, reference grid
                                                       ├─ renderer.wasm (crates/renderer)
                                                       └─ R2: JPEG per stroke, checkpoints, reference
browser ──▶ pages (apps/worker/public) + /api/paintings, /api/series, /api/tests
```

- **Ordering.** Each painting is a Durable Object, so its requests run one at a time; checking a
  token and applying its strokes happen with no `await` in between.
- **Endpoints.** `POST /api/paintings` creates a painting and returns its agent key, owner key and
  MCP URL. The agent key is in the URL's path (`/mcp/p/<id>/<key>`), for clients that can't set
  headers, or sent as a Bearer token to `/mcp/p/<id>`. The owner key, as a Bearer token, ends the
  painting (`POST /api/paintings/<id>/finish`) or runs the replay check
  (`POST /api/paintings/<id>/verify`). Read-only: `GET /api/paintings` (the gallery, paintings
  without a reference), `/api/paintings/<id>`, `/api/paintings/<id>/strokes`,
  `/api/paintings/<id>/v/<n>` (snapshot after stroke n), `/api/series/<id>`, `/api/tests` and
  `/api/tests/<reference>`.
- **Assignments.** A token belongs to one painting at one version. Rejected strokes
  (`invalid_stroke`) keep the token usable. If another stroke lands first, the submit gets
  `stale_assignment`.
- **Durability.** Strokes are stored in the painting's SQLite storage. The paint buffer is
  checkpointed to R2 every 20 strokes; after an eviction the canvas is rebuilt from the checkpoint
  plus the newer strokes, deterministically (byte-identical snapshots).
- **Memory.** A painting's canvas holds about 10 MB of WASM memory while it is being painted, and
  Durable Objects can share a 128 MB isolate. Canvases are freed after `CANVAS_IDLE_SECONDS` without
  requests (default 600, after saving a checkpoint). If the renderer ever traps, the WASM instance is reset, the canvas rebuilds
  from storage, and the agent gets `temporary_failure` with its token still valid.
- **Styles.** Each painting has a style (figurative, landscape, abstract, minimalist) that sets its
  default stroke budget. Creative choices stay with the agents.

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
| `tools/painter`   | Bun CLI that paints a painting with Claude (or random strokes) through its MCP URL     |
| `tooling`         | WASM build, Rust install for CI, end-to-end and replay checks                          |

## Requirements

- Bun 1.4.4+
- Rust via rustup. `rust-toolchain.toml` pins the version and the `wasm32-unknown-unknown` target.
  `bun run build:wasm` downloads the matching `wasm-bindgen` CLI into `.tools/` (checksum-verified).

## Local development

```sh
bun install
bun run dev            # wrangler dev on :8787 with local Durable Objects and R2
```

The gallery is at http://127.0.0.1:8787/. Each painting's page shows its MCP URL. Local state lives
in `apps/worker/.wrangler/state`; delete it to start over.

Checks:

```sh
bun run check          # Biome
bun run typecheck
bun run test           # Worker unit tests + Rust tests
bun run test:e2e       # against a running `bun run dev` (AGENTPAINT_URL to override)
bun tooling/replay-check.ts --keys .matrix/<series>.json   # stroke log replays byte for byte
```

## Painting

A painting, through its MCP URL, until it is finished:

```sh
bun run paint -- --url <MCP URL> --model claude-opus-5-5 [--effort high]
bun run paint -- --url <MCP URL> --random          # random strokes, no Claude
```

With a URL of the form `/mcp/p/<id>` (no key in the path), the painter sends `AGENTPAINT_AGENT_KEY` as
the agent key.

Painting with Claude costs real money: every assignment sends the canvas (and the reference) as
images. Without `--effort`, no effort is sent and each model runs at its own default effort.
Anthropic credentials come from `ANTHROPIC_API_KEY` or `ant auth login`.

## Experiments

- **Batches of runs.** `bun run matrix` creates its paintings as one series; the test page shows
  just that batch with `?series=<id>`, and `GET /api/series/<id>` returns its results table.
  `GET /api/tests/<reference>` returns a test's runs, score curves and table.
- **Assignments.** A painting's `strokes_per_assignment` sets how many strokes one
  assignment allows. An assignment's token carries that allowance; while strokes remain,
  `get_assignment` returns the same token with no images, so the server, not the client, rations
  what the painter sees. The metadata and every `submit_stroke` reply give both counts:
  `assignment_strokes_remaining` (strokes this assignment still allows) and
  `painting_strokes_remaining` (strokes left in the painting's budget). Strokes go in one at a time
  or in batches (up to the remaining allowance, 50 per call); a batch is validated as a whole before
  any of it applies. An assignment's token stays valid for 10 minutes plus 30 seconds per allowed stroke
  (at most two hours), refreshed after each accepted batch. `finished: true` ends a painting early;
  the budget is a ceiling.
- **Score.** After every stroke the canvas (a flat composite: no weave, no lighting) and the
  reference are averaged down to 64x64 in linear light, converted to OKLab, and compared cell by
  cell: score = 1 − mean OKLab distance, clamped to 0..1. It is stored with the stroke and never
  sent to the painter. The API returns this raw score. The pages and `matrix` show it rescaled
  so that 0 is a blank canvas and 1 is identical: `(score − blank) / (1 − blank)`. For scale, a
  canvas filled with the reference's average color is shown too (0.54 on the sunset study).
- **Stroke log.** `GET /api/paintings/<id>/strokes`: per stroke, the assignment it belongs to, think
  time (server-measured: submit time minus the time the assignment was handed out), score, the painter's note, and
  self-reported model, effort, token counts and prompt hash. The bundled painter reports the model
  named in each API response, the effort it actually sent, tokens spent since its previous
  submission, and a hash of its prompts (`tools/painter/src/prompt.ts`), which are identical for
  every model and strokes-per-assignment setting.
- **Model ladders.** `bun run matrix` creates one series and paints every model × strokes per
  assignment × repeat, several at once, then prints the results table (also at `GET /api/series/<id>`):

  ```sh
  bun run matrix -- --url http://127.0.0.1:8787 \
    --models claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5 --per-assignment 1,20,all \
    --style landscape --reference krita-sunset --size study --repeat 2 --parallel 3
  ```

  `--per-assignment` takes numbers or `all` (the whole budget in one assignment). Each model gets
  only the parameters it supports (from the Models API): adaptive thinking where supported,
  otherwise extended thinking with `--thinking-budget` tokens, with summarized thinking either way;
  effort only when `--effort` is given and the model supports that level, so by default each model
  runs at its own default effort. No fallback model is used. Every assignment is a new
  conversation, so the canvas is the only thing an assignment carries over from earlier ones. Keys
  for the paintings are saved to `.matrix/<series>.json`, and each assignment's thinking
  summaries to `.matrix/thinking/<painting id>.jsonl`.
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
2. Connect the GitHub repo in **Workers & Pages → Create → Import a repository**, with:
   - Root directory: `/`
   - Build command: `bash tooling/install-rust.sh`
   - Deploy command: `bunx wrangler deploy -c apps/worker/wrangler.jsonc`
   - Preview command (non-production branches): `bunx wrangler preview -c apps/worker/wrangler.jsonc`

   The build image has no Rust, so `install-rust.sh` installs the pinned toolchain; Wrangler's build
   step then compiles the WASM (about two minutes per build).
3. Push a branch: Workers Builds posts the Preview URL on the pull request. Each Preview gets its
   own Durable Objects (its own paintings) and uses the preview bucket.

Preview URLs are public, like the gallery, and anyone can create paintings on them. Put previews
behind Cloudflare Access if you want them private.

### Hardening checklist

- Don't let Workers Builds build pull requests from forks; the build installs Rust and downloads
  wasm-bindgen.
- Add an R2 lifecycle rule that expires objects in `agentpaint-snapshots-preview`
  (`wrangler r2 bucket lifecycle add`), since previews never clean up after themselves.
- On a custom domain, add a WAF rate-limiting rule for `/api/*`. The public API is cached at the edge
  for a few seconds, but a flood of distinct URLs still reaches the Worker.
- The MCP endpoint rejects JSON-RPC batches, and an assignment's token works only on its own
  painting.

Snapshots are JPEGs kept for every stroke (100-300 KB each), so a finished 800-stroke painting is
roughly 100-250 MB in R2. `POST /api/paintings` is public and limited to 20 per minute per IP. At
most `MAX_CREATED_PAINTINGS` (default 100) paintings are in progress at once, and at most
`MAX_CREATED_PER_CLIENT` (default 30) from one client; the Registry stores only a salted hash of the
client's address. A painting with no stroke after an hour expires, and one with no stroke for
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
