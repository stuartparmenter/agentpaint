// Random strokes that follow an assignment's constraints, for testing without a model.

export interface AssignmentMeta {
  canvas_width: number;
  canvas_height: number;
  max_brush_size: number;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export function randomStroke(meta: AssignmentMeta) {
  const maxSize = meta.max_brush_size;
  const minSize = Math.min(maxSize, Math.max(2, maxSize / 20));
  const size = rand(minSize, Math.min(maxSize, Math.max(minSize * 1.6, minSize + 10)));
  let x = rand(0, meta.canvas_width);
  let y = rand(0, meta.canvas_height);
  let angle = rand(0, Math.PI * 2);
  const count = 2 + Math.floor(rand(0, 5));
  const points: { x: number; y: number; pressure: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      angle += rand(-0.8, 0.8);
      x = Math.min(meta.canvas_width, Math.max(0, x + Math.cos(angle) * size * 1.5));
      y = Math.min(meta.canvas_height, Math.max(0, y + Math.sin(angle) * size * 1.5));
    }
    const taper = i === 0 || i === count - 1 ? 0.4 : 1;
    points.push({ x, y, pressure: Math.min(1, rand(0.6, 1) * taper + 0.1) });
  }
  return {
    points,
    brush: { size, hardness: rand(0.2, 0.9), opacity: rand(0.5, 1), flow: rand(0.5, 1) },
    color: { r: Math.floor(rand(0, 256)), g: Math.floor(rand(0, 256)), b: Math.floor(rand(0, 256)) },
    note: "random stroke",
  };
}
