import { describe, expect, test } from "bun:test";
import { authenticate, parseTokens } from "../src/auth";
import { makeToken, PAINTING_ID, parseToken, randomId } from "../src/ids";
import { checkBounds, normalize, strokeInput } from "../src/stroke";
import { currentPhase, STYLES } from "../src/styles";

const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);
const CONFIG = `alice:${TOKEN_A}, bob:${TOKEN_B}`;

describe("auth", () => {
  test("accepts configured tokens and names the agent", () => {
    expect(authenticate(`Bearer ${TOKEN_A}`, CONFIG)).toEqual({ name: "alice" });
    expect(authenticate(`Bearer ${TOKEN_B}`, CONFIG)).toEqual({ name: "bob" });
  });

  test("rejects missing, malformed and wrong tokens", () => {
    expect(authenticate(null, CONFIG)).toBeNull();
    expect(authenticate(TOKEN_A, CONFIG)).toBeNull();
    expect(authenticate(`Basic ${TOKEN_A}`, CONFIG)).toBeNull();
    expect(authenticate(`Bearer ${TOKEN_A.slice(1)}`, CONFIG)).toBeNull();
    expect(authenticate(`Bearer ${TOKEN_A}x`, CONFIG)).toBeNull();
    expect(authenticate(`Bearer ${TOKEN_A}`, undefined)).toBeNull();
  });

  test("ignores short tokens and bad names", () => {
    expect(parseTokens(`short:abc, bad name:${TOKEN_A},:${TOKEN_A}`).length).toBe(0);
    expect(authenticate("Bearer abc", "short:abc")).toBeNull();
  });
});

describe("ids", () => {
  test("random ids are base62 of the requested length", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId(12)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(PAINTING_ID.test(id)).toBe(true);
  });

  test("tokens round-trip and reject anything else", () => {
    const pid = randomId(12);
    const secret = randomId(20);
    expect(parseToken(makeToken(pid, secret))).toEqual({ paintingId: pid, secret });
    expect(parseToken(`${pid}-${secret}x`)).toBeNull();
    expect(parseToken(`../${pid}-${secret}`)).toBeNull();
    expect(parseToken("")).toBeNull();
  });
});

describe("styles", () => {
  test("phases advance with progress and the last phase holds", () => {
    const style = STYLES.figurative;
    expect(currentPhase(style, 0).name).toBe("foundation");
    expect(currentPhase(style, 79).name).toBe("foundation");
    expect(currentPhase(style, 80).name).toBe("structure");
    expect(currentPhase(style, 799).name).toBe("detail");
    expect(currentPhase(style, 5000).name).toBe("detail");
  });

  test("every style starts with a large minimum brush and ends allowing detail", () => {
    for (const style of Object.values(STYLES)) {
      expect(currentPhase(style, 0).minBrushSize).toBeGreaterThanOrEqual(40);
      expect(style.phases.at(-1)?.minBrushSize).toBe(1);
      expect(style.phases.at(-1)?.until).toBe(1);
    }
  });
});

describe("stroke", () => {
  const stroke = {
    points: [
      { x: 0, y: 512, pressure: 1 },
      { x: 1024, y: 256, pressure: 0.5 },
    ],
    brush: { size: 102.4, hardness: 0.5, opacity: 1, flow: 0.8 },
    color: { r: 10, g: 20, b: 30 },
  };

  test("schema accepts a valid stroke and strips unknown fields", () => {
    const parsed = strokeInput.parse({ ...stroke, blend_mode: "normal" });
    expect(parsed).toEqual(stroke);
  });

  test("schema rejects out-of-range values", () => {
    expect(strokeInput.safeParse({ ...stroke, points: [stroke.points[0]] }).success).toBe(false);
    expect(strokeInput.safeParse({ ...stroke, brush: { ...stroke.brush, size: 500 } }).success).toBe(false);
    expect(strokeInput.safeParse({ ...stroke, color: { r: 1.5, g: 0, b: 0 } }).success).toBe(false);
  });

  test("bounds are checked against the canvas", () => {
    expect(checkBounds(stroke, 1024, 1024)).toBeNull();
    expect(checkBounds(stroke, 512, 1024)).toContain("points[1]");
  });

  test("normalizes to canvas fractions", () => {
    const n = normalize(stroke, 1024, 1024);
    expect(n.points[1]).toEqual({ x: 1, y: 0.25, pressure: 0.5 });
    expect(n.brush.size).toBeCloseTo(0.1);
    expect(n.speed).toBeNull();
  });
});
