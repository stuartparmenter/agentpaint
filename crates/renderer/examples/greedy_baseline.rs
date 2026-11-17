//! A non-model baseline: paint a reference greedily with the same stroke format
//! and budget the painters use. Each stroke is the best of `candidates` random
//! strokes (color sampled from the reference under the stroke, brush size
//! shrinking from coarse to fine over the budget), judged by the score.
//!
//!     cargo run --release -p agentpaint-renderer --example greedy_baseline -- \
//!       reference.png <width> <budget> [candidates] [out.png]
//!
//! Prints the score every 10% of the budget, with the two anchors, and writes the
//! strokes as JSON next to the PNG.

use agentpaint_renderer::score::Reference;
use agentpaint_renderer::{Brush, Canvas, Color, Stroke, StrokePoint};

/// Small deterministic PRNG (xorshift), so runs are reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.next() * (hi - lo)
    }
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let [_, reference_path, width, budget, rest @ ..] = args.as_slice() else {
        return Err("usage: greedy_baseline <reference.png> <width> <budget> [candidates] [out.png]".into());
    };
    let width: usize = width.parse().map_err(|_| "bad width")?;
    let budget: usize = budget.parse().map_err(|_| "bad budget")?;
    let candidates: usize = rest.first().map(|s| s.parse().map_err(|_| "bad candidates")).transpose()?.unwrap_or(24);
    let out = rest.get(1).cloned().unwrap_or_else(|| "greedy.png".into());

    let bytes = std::fs::read(reference_path).map_err(|e| e.to_string())?;
    let (sw, sh) = {
        let r = png::Decoder::new(std::io::Cursor::new(&bytes)).read_info().map_err(|e| e.to_string())?;
        (r.info().width as usize, r.info().height as usize)
    };
    let height = (width as f64 * sh as f64 / sw as f64).round() as usize;
    let reference = Reference::from_png(&bytes, width, height)?;
    let (w, h) = (width as f64, height as f64);
    let sample = |x: f64, y: f64| {
        let (px, py) = (((x * w) as usize).min(width - 1), ((y * h) as usize).min(height - 1));
        let i = (py * width + px) * 3;
        Color { r: reference.rgb[i], g: reference.rgb[i + 1], b: reference.rgb[i + 2] }
    };

    let mut canvas = Canvas::new(width as u32, height as u32)?;
    let mut rng = Rng(0x5eed_1234_abcd_ef01);
    let mut strokes = Vec::with_capacity(budget);
    println!(
        "greedy baseline: {width}x{height}, budget {budget}, {candidates} candidates per stroke; anchors: blank {:.3}, flat average color {:.3}",
        reference.blank_score, reference.mean_color_score
    );
    for i in 0..budget {
        let progress = i as f64 / budget as f64;
        // Brush diameter as a fraction of width: 0.18 at the start down to 0.01.
        let size = (0.18 * (1.0 - progress).powi(2)).max(0.01);
        let mut best: Option<(f32, Stroke, Canvas)> = None;
        for _ in 0..candidates {
            let (x, y) = (rng.next(), rng.next());
            let angle = rng.range(0.0, std::f64::consts::TAU);
            let length = size * rng.range(1.0, 3.0);
            let (dx, dy) = (angle.cos() * length * 0.5, angle.sin() * length * 0.5 * w / h);
            let stroke = Stroke {
                points: vec![
                    StrokePoint { x: (x - dx).clamp(0.0, 1.0), y: (y - dy).clamp(0.0, 1.0), pressure: 0.9 },
                    StrokePoint { x: (x + dx).clamp(0.0, 1.0), y: (y + dy).clamp(0.0, 1.0), pressure: 0.9 },
                ],
                brush: Brush { size, hardness: 0.6, opacity: 1.0, flow: 0.9 },
                color: sample(x, y),
                speed: None,
            };
            let mut trial = canvas.clone();
            trial.apply_stroke(&stroke, i as u32 + 1)?;
            let score = trial.score(&reference.grid);
            if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                best = Some((score, stroke, trial));
            }
        }
        let (score, stroke, next) = best.ok_or("no candidates")?;
        canvas = next;
        strokes.push(stroke);
        if (i + 1) % (budget / 10).max(1) == 0 || i + 1 == budget {
            println!("stroke {:>5}: score {score:.4}", i + 1);
        }
    }
    std::fs::write(&out, canvas.render_png()?).map_err(|e| e.to_string())?;
    let json_path = std::path::Path::new(&out).with_extension("json");
    std::fs::write(&json_path, serde_json::to_string(&strokes).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    println!("wrote {out} and {}", json_path.display());
    Ok(())
}
