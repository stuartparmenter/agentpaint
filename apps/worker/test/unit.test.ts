import { describe, expect, test } from "bun:test";
import { bearer } from "../src/auth";
import { assignmentTtlMs, envNumber } from "../src/config";
import { makeToken, PAINTING_ID, parseToken, randomId } from "../src/ids";
import { canvasSize, findReference, REFERENCES } from "../src/references";
import { seriesTable } from "../src/series";
import { createInput, studyBudget } from "../src/settings";
import { checkBounds, maxBrushSize, normalize, strokeInput } from "../src/stroke";
import { conditionKey, conditions, downsample, selectRuns, testsIndex } from "../src/tests";
import type { PaintingSummary } from "../src/types";

describe("auth", () => {
  test("reads a bearer token and rejects other header forms", () => {
    const key = "a".repeat(32);
    expect(bearer(`Bearer ${key}`)).toBe(key);
    for (const header of [
      null,
      undefined,
      "",
      key,
      `Basic ${key}`,
      `Bearer  ${key}`,
      `Bearer ${key} x`,
      "Bearer ",
    ])
      expect(bearer(header)).toBeUndefined();
    expect(bearer(`Bearer ${"a".repeat(257)}`)).toBeUndefined();
  });
});

describe("config", () => {
  test("environment overrides fall back on unset, empty, zero, negative and non-numeric values", () => {
    expect(envNumber("600", 10)).toBe(600);
    expect(envNumber("0.5", 10)).toBe(0.5);
    for (const value of [undefined, "", "0", "-3", "abc", "Infinity"]) expect(envNumber(value, 10)).toBe(10);
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
    expect(checkBounds(stroke, 600, 1024)).toContain("points[1]");
    expect(checkBounds(stroke, 512, 1024)).toContain("brush.size");
  });

  test("normalizes to canvas fractions", () => {
    const n = normalize(stroke, 1024, 1024);
    expect(n.points[1]).toEqual({ x: 1, y: 0.25, pressure: 0.5 });
    expect(n.brush.size).toBeCloseTo(0.1);
    expect(n.speed).toBeNull();
  });
});

describe("created paintings", () => {
  test("settings default sensibly and reject bad values", () => {
    const parsed = createInput.parse({ style: "landscape" });
    expect(parsed).toMatchObject({ size: "full", strokes_per_assignment: 1 });
    expect(createInput.safeParse({ style: "watercolor" }).success).toBe(false);
    expect(createInput.safeParse({ style: "landscape", strokes_per_assignment: 0 }).success).toBe(false);
    expect(createInput.safeParse({ style: "landscape", max_strokes: 5000 }).success).toBe(false);
    expect(createInput.safeParse({ style: "landscape", series: "../x" }).success).toBe(false);
    expect(studyBudget(1000)).toBe(250);
    expect(studyBudget(1)).toBe(1);
  });

  test("canvas size follows the reference's aspect ratio", () => {
    const ref = findReference("krita-sunset");
    expect(canvasSize(1024, ref)).toEqual({ width: 1024, height: 576 });
    expect(canvasSize(512, ref)).toEqual({ width: 512, height: 288 });
    expect(canvasSize(512, undefined)).toEqual({ width: 512, height: 512 });
  });

  test("the maximum brush size scales with the canvas", () => {
    expect(maxBrushSize(1024)).toBe(200);
    expect(maxBrushSize(512)).toBe(100);
  });

  test("an assignment's token lives longer for larger allowances, up to two hours", () => {
    expect(assignmentTtlMs(1)).toBe(10 * 60_000 + 30_000);
    expect(assignmentTtlMs(250)).toBe(2 * 60 * 60_000);
  });

  test("the series table groups by models and strokes per assignment and averages repeats", () => {
    const base = {
      status: "done",
      style: "landscape",
      prompt: null,
      width: 512,
      height: 288,
      maxStrokes: 250,
      createdAt: 0,
      lastStrokeAt: 0,
      finishedAt: 0,
      seriesId: "s",
      size: "study",
      reference: "krita-sunset",
      blankScore: 0.75,
      meanColorScore: 0.88,
    } as const;
    const p = (id: string, models: string[], spl: number, score: number, strokes: number, think: number) =>
      ({
        ...base,
        id,
        models,
        strokesPerAssignment: spl,
        lastScore: score,
        strokeCount: strokes,
        assignments: Math.ceil(strokes / spl),
        meanThinkMs: think,
        tokensIn: 100,
        tokensOut: 10,
      }) as PaintingSummary;
    const table = seriesTable([
      p("a", ["m1"], 1, 0.8, 250, 1000),
      p("b", ["m1"], 1, 0.9, 250, 3000),
      p("c", ["m1"], 250, 0.85, 200, 5000),
      p("d", [], 1, 0.7, 250, 10),
    ]);
    expect(table.map((c) => [c.models, c.strokes_per_assignment, c.painting_ids])).toEqual([
      ["(not reported)", 1, ["d"]],
      ["m1", 1, ["a", "b"]],
      ["m1", 250, ["c"]],
    ]);
    const m1 = table.find((c) => c.models === "m1" && c.strokes_per_assignment === 1);
    expect(m1?.final_score).toBeCloseTo(0.85);
    expect(m1?.mean_think_ms).toBe(2000);
  });
});

describe("reference tests", () => {
  const run = (over: Partial<PaintingSummary>): PaintingSummary =>
    ({
      id: "x",
      status: "active",
      style: "landscape",
      prompt: null,
      width: 512,
      height: 288,
      strokeCount: 0,
      maxStrokes: 250,
      createdAt: 0,
      lastStrokeAt: null,
      finishedAt: null,
      seriesId: "s1",
      size: "study",
      strokesPerAssignment: 1,
      reference: "krita-sunset",
      blankScore: 0.75,
      meanColorScore: 0.88,
      lastScore: null,
      assignments: 0,
      meanThinkMs: null,
      tokensIn: 0,
      tokensOut: 0,
      models: [],
      ...over,
    }) satisfies PaintingSummary;

  test("groups runs into comparable conditions, most runs first", () => {
    const runs = [run({ id: "a" }), run({ id: "b", maxStrokes: 30 }), run({ id: "c" })];
    expect(conditions(runs).map((c) => [c.maxStrokes, c.runs])).toEqual([
      [250, 2],
      [30, 1],
    ]);
  });

  test("selects the requested condition, else the largest, within a series", () => {
    const runs = [
      run({ id: "a", seriesId: "s1" }),
      run({ id: "b", seriesId: "s2", maxStrokes: 30 }),
      run({ id: "c", seriesId: "s2", maxStrokes: 30 }),
      run({ id: "d", seriesId: "s2" }),
      run({ id: "e", seriesId: "s1", maxStrokes: 30 }),
    ];
    expect(selectRuns(runs, {}).paintings.map((p) => p.id)).toEqual(["b", "c", "e"]);
    const key = conditionKey(runs[0] as PaintingSummary);
    expect(selectRuns(runs, { condition: key }).paintings.map((p) => p.id)).toEqual(["a", "d"]);
    expect(selectRuns(runs, { condition: key, series: "s2" }).paintings.map((p) => p.id)).toEqual(["d"]);
    expect(selectRuns([], {}).condition).toBeNull();
  });

  test("the index lists every reference with its best finished score", () => {
    const [entry] = testsIndex(REFERENCES, [
      run({ id: "a", status: "done", lastScore: 0.8, models: ["m1"] }),
      run({ id: "b", status: "active", lastScore: 0.9, models: ["m2"] }),
    ]);
    expect(entry?.runs).toBe(2);
    expect(entry?.finished).toBe(1);
    expect(entry?.best).toEqual({ score: 0.8, blankScore: 0.75 });
    expect(entry?.models).toEqual(["m1", "m2"]);
  });

  test("downsampling keeps the first and last points", () => {
    const points = Array.from({ length: 1000 }, (_, i) => i);
    const kept = downsample(points, 200);
    expect(kept.length).toBe(200);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(999);
    expect(downsample([1, 2], 200)).toEqual([1, 2]);
  });
});
