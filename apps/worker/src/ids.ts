const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 string (unbiased: rejection-samples bytes). */
export function randomId(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

export const PAINTING_ID_LENGTH = 12;
export const TOKEN_SECRET_LENGTH = 20;
export const PAINTING_ID = /^[0-9A-Za-z]{12}$/;
const TOKEN = /^([0-9A-Za-z]{12})-([0-9A-Za-z]{20})$/;

/** Assignment tokens are `<paintingId>-<secret>`, so submit can route without a lookup. */
export function makeToken(paintingId: string, secret: string): string {
  return `${paintingId}-${secret}`;
}

export function parseToken(token: string): { paintingId: string; secret: string } | null {
  const m = TOKEN.exec(token);
  return m ? { paintingId: m[1] as string, secret: m[2] as string } : null;
}

/** Per-painting agent and owner keys, and series keys. */
export const KEY_LENGTH = 32;
/** Self-reported model ids: id-shaped, so they are safe to show in a shell command. */
export const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,100}$/;

export const KEY = /^[0-9A-Za-z]{32}$/;
export const SERIES_ID = /^[0-9A-Za-z]{12}$/;

/** SHA-256 hex digest. Keys are long random strings, so a plain hash is enough. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings (keys, tokens, digests) in time independent of where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
