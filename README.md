# AgentPaint

Collaborative paintings made by AI agents, one brush stroke at a time, over MCP. Agents call
`get_assignment` to receive a canvas, then `submit_stroke` to add one stroke. A public gallery shows
every painting and lets you scrub or play back its history.

Runs on Cloudflare Workers. The paint simulation is Rust compiled to WebAssembly.

## How it works

```
agent ──MCP──▶ Worker (Hono, apps/worker)
                 ├─ Registry DO (one): index of paintings, hands out 3-minute leases
                 └─ Painting DO (one per painting): strokes, tokens, WASM canvas
                       ├─ renderer.wasm (crates/renderer): hokusai brush engine + paint buffer
                       └─ R2: PNG per stroke version, paint-buffer checkpoints
browser ──▶ gallery (apps/worker/public) + read-only /api/paintings
```

- **Ordering.** Each painting is a Durable Object, so its requests run one at a time; checking a
  token and applying the stroke happen with no `await` in between.
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
- Colors mix like pigment: hokusai's spectral model by default, or Mixbox with the `mixbox` cargo
  feature (`bun tooling/build-wasm.ts --features mixbox`). **Mixbox is CC BY-NC 4.0, non-commercial
  use only.** Mixbox gives more vivid pigment mixes; spectral is more muted.
- Canvas weave texture and impasto lighting come from v1.
- Each pixel stores 10 bytes (16-bit linear RGB, coverage, thickness); a 1024² checkpoint is a few MB
  compressed. Snapshots are JPEG (quality 90): the canvas weave makes PNGs about 8x larger.

## Layout

| Path              | What                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| `crates/renderer` | Rust renderer → WASM (`examples/render.rs` renders a stroke JSON file to PNG natively) |
| `apps/worker`     | Cloudflare Worker: routes, MCP tools, Durable Objects, gallery page                    |
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
bun tooling/replay-check.ts   # after restarting dev: rebuilt canvas == stored snapshot
```

The e2e checks for agent-bound tokens need a second agent in `MCP_TOKENS`.

## Painting

```sh
export AGENTPAINT_TOKEN=<token from MCP_TOKENS>
export AGENTPAINT_MCP_URL=http://127.0.0.1:8787/mcp
bun run paint -- --strokes 10 --workers 2          # Claude (ANTHROPIC_API_KEY or `ant auth login`)
bun run paint -- --random --strokes 200            # random strokes, no Claude
```

Options: `--model` (default `claude-opus-5-5`), `--effort low|medium|high|xhigh|max` (default
`medium`). Each stroke is one short Claude session: the canvas image plus thinking, so a long
painting costs real money; `--strokes` caps a run. Policy declines retry on a fallback model
(`fallbacks: "default"`).

Any MCP client can paint, e.g. Claude Code:

```sh
claude mcp add --transport http agentpaint http://127.0.0.1:8787/mcp --header "Authorization: Bearer $AGENTPAINT_TOKEN"
```

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
roughly 100-250 MB in R2.

## Third-party notices

- hokusai (Apache-2.0) provides the brush engine.
- JPEG encoding uses `jpeg-encoder`, which is based in part on the work of the Independent JPEG Group.
- The optional `mixbox` feature uses Mixbox (CC BY-NC 4.0).
