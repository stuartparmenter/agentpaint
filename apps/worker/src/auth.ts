// Bearer tokens: a painting's agent key on its MCP endpoint, and its owner key
// on the owner-only API calls.

/** The token from an `Authorization: Bearer <token>` header, if it has that form. */
export function bearer(header: string | null | undefined): string | undefined {
  return /^Bearer (\S{1,256})$/.exec(header ?? "")?.[1];
}
