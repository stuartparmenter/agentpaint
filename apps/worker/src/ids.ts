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
