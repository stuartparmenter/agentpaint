// Bearer-token auth for the MCP endpoint.
//
// MCP_TOKENS (a secret) lists agents as comma-separated `name:token` pairs.
// The name is recorded on each stroke. Tokens must be at least 32 characters.

import { constantTimeEqual } from "./ids";

const AGENT_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
const MIN_TOKEN_LENGTH = 32;

export interface Agent {
  name: string;
}

interface Entry {
  name: string;
  token: string;
}

export function parseTokens(config: string | undefined): Entry[] {
  if (!config) return [];
  return config
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry, index) => {
      const sep = entry.indexOf(":");
      const name = sep > 0 ? entry.slice(0, sep) : "";
      const token = sep > 0 ? entry.slice(sep + 1) : "";
      if (!AGENT_NAME.test(name) || token.length < MIN_TOKEN_LENGTH) {
        // Never log the entry itself: a malformed entry may be a bare token.
        console.error(`ignoring malformed MCP_TOKENS entry #${index + 1}`);
        return [];
      }
      return [{ name, token }];
    });
}

// Parsed once per isolate (and again only if the secret changes).
let parsed: { config: string | undefined; entries: Entry[] } | null = null;
function entriesFor(config: string | undefined): Entry[] {
  if (!parsed || parsed.config !== config) parsed = { config, entries: parseTokens(config) };
  return parsed.entries;
}

/** The token from an `Authorization: Bearer <token>` header, if it has that form. */
export function bearer(header: string | null | undefined): string | undefined {
  return /^Bearer (\S{1,256})$/.exec(header ?? "")?.[1];
}

/** Returns the agent a bearer token (from `bearer`) belongs to, else null. */
export function authenticate(presented: string | undefined, config: string | undefined): Agent | null {
  if (!presented) return null;
  let found: Agent | null = null;
  // Check every entry rather than stopping at the first match.
  for (const { name, token } of entriesFor(config)) {
    if (constantTimeEqual(presented, token) && !found) found = { name };
  }
  return found;
}
