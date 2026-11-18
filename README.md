# AgentPaint

AgentPaint lets an AI agent paint with real brush strokes, then shows you how it went. You create a
painting, connect an agent to it over MCP, and watch it work stroke by stroke. Give it a reference
image and every stroke is scored against it, so you can compare models and see whether letting an
agent look at its own work more often makes it paint better.

Live site: https://agentpaint.pavlov-5eb.workers.dev

## Using it

### Paint something with your agent

1. On the **Paintings** page, create a painting: pick a style and describe what to paint.
2. The painting's page shows its MCP URL and a ready-made command. With Claude Code:

   ```sh
   claude mcp add --transport http agentpaint-<id> <MCP URL>
   ```

   Then ask Claude to paint the AgentPaint painting until it's done. Any MCP client works the same
   way: the painting has two tools, `get_assignment` and `submit_stroke`.
3. Watch the canvas fill in, with the agent's note for every stroke. Afterwards, play it back with
   the slider.

### Compare models on a reference

**Reference tests** holds runs against built-in images (a sunset, a Mondrian and a hot-air balloon).
Each run is a model painting the reference with a fixed stroke budget, under one setting for how
often it sees the canvas:

- **after every stroke**,
- **every N strokes** (it places N strokes without seeing them land), or
- **once, at the start** (it paints the whole budget blind).

A test page puts the runs side by side: one lane per model, the finished canvases, and score charts
per setting. To add a run, use **Start a run** on the test page and connect an agent as above. The
run is listed under the model the agent reports.

**Scores** go from 0 (a blank canvas) to 1 (identical to the reference), comparing colors on a 64×64
grid. Each test page also shows what one flat average color would score, for scale.

## Running experiments

The bundled painter (`tools/painter`) paints with Claude through the Anthropic API. It needs
`ANTHROPIC_API_KEY` or an `ant auth login` profile, and it costs real money: each assignment sends
the canvas and the reference as images.

Paint one painting:

```sh
bun run paint -- --url <MCP URL> --model claude-opus-5-5
bun run paint -- --url <MCP URL> --random        # random strokes, no API calls
```

Paint a whole comparison (every model × setting) in one batch:

```sh
bun run matrix -- --url https://agentpaint.pavlov-5eb.workers.dev \
  --models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 \
  --per-assignment 1,20,all --reference krita-sunset --size study --no-finish
```

| Flag               | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `--models`         | Model ids. Each runs at its own default effort unless you pass `--effort`. |
| `--per-assignment` | Strokes between views of the canvas: numbers, or `all` for one view.       |
| `--reference`      | `krita-sunset`, `mondrian-composition-ii` or `cappadocia-balloon`.         |
| `--size`           | `study` (512 px wide, cheaper) or `full` (1024 px).                        |
| `--max-strokes`    | Stroke budget; defaults to the style's.                                    |
| `--no-finish`      | The agent can't end a painting early, so every run uses its full budget.   |
| `--repeat`         | Runs per model and setting.                                                |
| `--join`           | A saved `.matrix/<series>.json`: add these runs to that batch.             |

The matrix prints a results table and a link to the test page filtered to the batch. It saves the
paintings' keys to `.matrix/<series>.json` and each model's thinking summaries to
`.matrix/thinking/<painting>.jsonl`.

Every assignment starts a new conversation, so the canvas is the only thing an agent carries over
from earlier ones. If a conversation ends before using its assignment's strokes, the next one gets
the same assignment, showing the reference and the canvas as they were when it started. The prompts
are fixed and hashed, and every stroke records the hash, the model and the token counts.

To check that a batch's paintings rebuild exactly from their stroke logs:

```sh
bun tooling/replay-check.ts --keys .matrix/<series>.json
```

To delete paintings from a batch (everything stored for them, and their entries in the keys file):

```sh
bun tooling/delete-paintings.ts --keys .matrix/<series>.json --id <painting> [--id <painting> ...]
```

The owner key can also delete a single painting: `DELETE /api/paintings/<id>` with
`Authorization: Bearer <owner key>`.

## Building and running locally

You need [Bun](https://bun.sh) 1.4.4+ and Rust via rustup (`rust-toolchain.toml` pins the version
and the WebAssembly target).

```sh
bun install
bun run dev        # http://127.0.0.1:8787, with local storage
```

`bun run dev` compiles the Rust renderer to WebAssembly first. Local data lives in
`apps/worker/.wrangler/state`; delete it to start over.

Checks:

```sh
bun run check      # lint and format
bun run typecheck
bun run test       # unit tests and Rust tests
bun run test:e2e   # against a running `bun run dev`
```

| Path              | What's there                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker`     | The Cloudflare Worker: pages, API, MCP tools, storage, reference images                                                          |
| `crates/renderer` | The paint engine (Rust, compiled to WebAssembly), the scorer, and tools for preparing references and a greedy non-model baseline |
| `tools/painter`   | The painter and matrix CLIs                                                                                                      |
| `tooling`         | WebAssembly build, end-to-end and replay checks                                                                                  |

## Deploying

AgentPaint runs on Cloudflare Workers with Durable Objects and R2, and needs the Workers Paid plan
(rendering a stroke takes more CPU than the free plan allows).

```sh
cd apps/worker
bunx wrangler r2 bucket create agentpaint-snapshots
bunx wrangler r2 bucket create agentpaint-snapshots-preview
bunx wrangler deploy
```

To deploy from GitHub instead, import the repository in **Workers & Pages** with build command
`bash tooling/install-rust.sh` and deploy command `bunx wrangler deploy -c apps/worker/wrangler.jsonc`.

Anyone can view the site and create paintings. Creation is rate-limited per address, and paintings
that go unpainted expire. A painting's MCP URL contains its key, so request logging is turned off.
Each stroke keeps a JPEG snapshot in R2 for playback, about 50–300 KB.

## Credits

- Brush engine: [hokusai](https://github.com/reearth/hokusai) (Apache-2.0).
- Color mixing: [Mixbox](https://github.com/scrtwpns/mixbox) (CC BY-NC 4.0, non-commercial use
  only). `bun tooling/build-wasm.ts --spectral` builds with hokusai's spectral mixing instead.
- JPEG encoding: `jpeg-encoder`, based in part on the work of the Independent JPEG Group.
- Reference images, resized:
  - [Sunset - Landscape digital painting made in Krita](https://commons.wikimedia.org/wiki/File:Sunset_-_Landscape_digital_painting_made_in_krita.png)
    by Raghukamath, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  - [Composition II in Red, Blue, and Yellow](https://commons.wikimedia.org/wiki/File:Piet_Mondriaan,_1930_-_Mondrian_Composition_II_in_Red,_Blue,_and_Yellow.jpg)
    by Piet Mondrian (1930), public domain.
  - [Cappadocia Balloon Inflating](https://commons.wikimedia.org/wiki/File:Cappadocia_Balloon_Inflating_Wikimedia_Commons.JPG)
    by Benh LIEU SONG, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
