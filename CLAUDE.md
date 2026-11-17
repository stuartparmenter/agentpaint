# CLAUDE.md

## Writing

- Plain, direct prose in docs, comments, UI text and messages. No mannered or literary phrasing.
- Use the words the code and the domain already use. Don't invent jargon or coin names for things.
- Comments describe what the code does now, in the present tense. No history ("now", "previously",
  "unchanged", "v1 did X"); that belongs in git.

## Tests

- A test must be able to fail for a real bug. Don't write tests that restate the implementation,
  check a constant against itself, or only prove that true is true.
- Test behavior through the public surface (the API, MCP tools, the renderer's output), not internals.

## Checks

`bun run check`, `bun run typecheck` and `bun run test` must pass. With `bun run dev` running,
`bun run test:e2e` must pass too.
