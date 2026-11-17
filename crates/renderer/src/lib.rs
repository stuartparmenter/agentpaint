//! AgentPaint renderer: hokusai brush engine + pigment mixing + impasto compositing.
//!
//! [`Canvas`] is the native API; [`wasm::WasmCanvas`] wraps it for the Worker.

mod brush;
mod color;
mod mixing;
mod paint_buffer;
mod spline;
mod stroke;
mod surface;

pub mod wasm;

use hokusai_core::BrushState;

pub use paint_buffer::{PaintBuffer, MAX_DIMENSION};
pub use stroke::{Brush, Color, Stroke, StrokePoint};

use spline::Sample;
use surface::PaintSurface;

/// Upper bound on control points per stroke, to bound per-stroke CPU.
pub const MAX_POINTS: usize = 64;
/// Catmull-Rom subdivisions per span; gives the brush engine dense, tablet-like input.
const SEGMENTS_PER_SPAN: usize = 16;

pub struct Canvas {
    buf: PaintBuffer,
    version: u32,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(format!(
                "canvas must be 1..={MAX_DIMENSION} px per side, got {width}x{height}"
            ));
        }
        Ok(Self {
            buf: PaintBuffer::new(width as usize, height as usize),
            version: 0,
        })
    }

    /// Restore a canvas of the given size from [`checkpoint`](Self::checkpoint) output.
    pub fn from_checkpoint(data: &[u8], width: u32, height: u32) -> Result<Self, String> {
        let (buf, version) = PaintBuffer::from_checkpoint(data, width, height)?;
        Ok(Self { buf, version })
    }

    pub fn width(&self) -> u32 {
        self.buf.width as u32
    }

    pub fn height(&self) -> u32 {
        self.buf.height as u32
    }

    /// Number of strokes applied (restored from the checkpoint, then counted).
    pub fn version(&self) -> u32 {
        self.version
    }

    /// Apply one stroke. `seed` feeds the brush engine's RNG, so replaying the
    /// same strokes with the same seeds reproduces the painting exactly.
    pub fn apply_stroke(&mut self, stroke: &Stroke, seed: u32) -> Result<(), String> {
        validate(stroke)?;
        let (w, h) = (self.buf.width as f64, self.buf.height as f64);
        let samples: Vec<Sample> = stroke
            .points
            .iter()
            .map(|p| Sample {
                x: p.x * w,
                y: p.y * h,
                pressure: p.pressure.clamp(0.0, 1.0),
            })
            .collect();
        let mut path = spline::catmull_rom(&samples, SEGMENTS_PER_SPAN);
        // Dabs are spaced by brush radius, so a stroke that barely moves emits
        // none at all. Make it a dot: extend it by a quarter radius (two dabs).
        let radius_px = (stroke.brush.size * w * 0.5).max(0.5);
        let length: f64 = path.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
        if length < radius_px * 0.25 {
            let end = path[path.len() - 1];
            path.push(Sample { x: end.x + radius_px * 0.25 - length, ..end });
        }

        let engine = brush::acrylic(stroke, w);
        let mut state = BrushState::new(seed);
        let speed = stroke.effective_speed(w);
        let c = stroke.color;
        let color = color::srgb_to_linear_rgb([c.r, c.g, c.b].map(|v| v as f32 / 255.0));
        let mut surface = PaintSurface::new(&mut self.buf, stroke.brush.opacity as f32, color);

        // The first event only seeds the brush position. hokusai derives dab
        // density (and so opacity linearization) from the *previous* step's
        // settings, which are zero on a fresh state: without a warm-up, the
        // first dab lands unlinearized as a hard, overly opaque disc. A
        // zero-pressure event paints nothing (pressure gates opacity) but runs
        // one evaluation so the first real dab is linearized.
        let first = path[0];
        let (fx, fy) = (first.x as f32, first.y as f32);
        engine.stroke_to(&mut state, &mut surface, fx, fy, 0.0, 0.0, 0.0, 0.0);
        engine.stroke_to(&mut state, &mut surface, fx, fy, 0.0, 0.0, 0.0, 0.01);
        engine.stroke_to(
            &mut state,
            &mut surface,
            fx,
            fy,
            first.pressure as f32,
            0.0,
            0.0,
            0.001,
        );
        for pair in path.windows(2) {
            let (prev, p) = (pair[0], pair[1]);
            let dist = ((p.x - prev.x).powi(2) + (p.y - prev.y).powi(2)).sqrt();
            // hokusai treats a gap of 5 s or more as a new stroke and draws
            // nothing for it, so very slow strokes must not reach that.
            let dtime = (dist / speed).clamp(0.001, 1.0);
            engine.stroke_to(
                &mut state,
                &mut surface,
                p.x as f32,
                p.y as f32,
                p.pressure as f32,
                0.0,
                0.0,
                dtime,
            );
        }
        surface.commit();

        self.version += 1;
        Ok(())
    }

    /// Composite and encode the current painting as an RGB PNG.
    pub fn render_png(&self) -> Result<Vec<u8>, String> {
        encode_png(&self.buf.composite_rgb(), self.width(), self.height())
    }

    /// Composite and encode as JPEG. The canvas weave is fine-grained noise that
    /// PNG compresses poorly (~2 MB at 1024²); JPEG at quality 90 is several
    /// times smaller and visually identical. Lossless state lives in checkpoints.
    pub fn render_jpeg(&self, quality: u8) -> Result<Vec<u8>, String> {
        let (w, h) = (self.width(), self.height());
        let (w16, h16) = (u16::try_from(w), u16::try_from(h));
        let (Ok(w16), Ok(h16)) = (w16, h16) else {
            return Err("canvas too large for JPEG".into());
        };
        let mut out = Vec::new();
        let encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
        encoder
            .encode(&self.buf.composite_rgb(), w16, h16, jpeg_encoder::ColorType::Rgb)
            .map_err(|e| e.to_string())?;
        Ok(out)
    }

    /// Serialize the paint state (including the stroke count) for later restore.
    pub fn checkpoint(&self) -> Vec<u8> {
        self.buf.checkpoint(self.version)
    }
}

/// Check a stroke without applying it.
pub fn validate(stroke: &Stroke) -> Result<(), String> {
    let n = stroke.points.len();
    if !(2..=MAX_POINTS).contains(&n) {
        return Err(format!("stroke needs 2..={MAX_POINTS} points, got {n}"));
    }
    let finite_in = |v: f64, lo: f64, hi: f64| v.is_finite() && (lo..=hi).contains(&v);
    for (i, p) in stroke.points.iter().enumerate() {
        // Allow a little overshoot so strokes can run off the canvas edge.
        if !finite_in(p.x, -0.5, 1.5)
            || !finite_in(p.y, -0.5, 1.5)
            || !finite_in(p.pressure, 0.0, 1.0)
        {
            return Err(format!("point {i} out of range"));
        }
    }
    let b = &stroke.brush;
    if !finite_in(b.size, 0.0, 0.5)
        || !finite_in(b.hardness, 0.0, 1.0)
        || !finite_in(b.opacity, 0.0, 1.0)
        || !finite_in(b.flow, 0.0, 1.0)
    {
        return Err("brush parameter out of range".into());
    }
    if let Some(speed) = stroke.speed
        && (!speed.is_finite() || speed <= 0.0)
    {
        return Err("speed must be a positive number".into());
    }
    Ok(())
}

fn encode_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(rgb.len() / 3);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn mixing_model() -> &'static str {
    mixing::model_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(points: &[(f64, f64, f64)], color: (u8, u8, u8), size: f64, opacity: f64) -> Stroke {
        Stroke {
            points: points
                .iter()
                .map(|&(x, y, pressure)| StrokePoint { x, y, pressure })
                .collect(),
            brush: Brush {
                size,
                hardness: 0.8,
                opacity,
                flow: 1.0,
            },
            color: Color {
                r: color.0,
                g: color.1,
                b: color.2,
            },
            speed: None,
        }
    }

    fn pixel(c: &Canvas, x: usize, y: usize) -> [f32; 3] {
        c.buf.pixels[c.buf.index(x, y)].linear()
    }

    fn opacity(c: &Canvas, x: usize, y: usize) -> f32 {
        c.buf.pixels[c.buf.index(x, y)].opacity_f()
    }

    #[test]
    fn stroke_paints_along_its_path_only() {
        let mut c = Canvas::new(128, 128).unwrap();
        c.apply_stroke(
            &stroke(&[(0.1, 0.5, 0.8), (0.9, 0.5, 0.8)], (200, 30, 30), 0.1, 1.0),
            1,
        )
        .unwrap();
        assert!(
            opacity(&c, 64, 64) > 0.9,
            "center coverage {}",
            opacity(&c, 64, 64)
        );
        assert_eq!(opacity(&c, 64, 10), 0.0);
        let [r, g, b] = pixel(&c, 64, 64);
        assert!(r > g && r > b);
        assert_eq!(c.version(), 1);
    }

    #[test]
    fn opaque_stroke_covers_regardless_of_paint_underneath() {
        // The v1 bug: thick paint resisted new color. Stack many red strokes,
        // then one opaque blue stroke must still read as blue.
        let mut c = Canvas::new(96, 96).unwrap();
        for i in 0..20 {
            c.apply_stroke(
                &stroke(&[(0.1, 0.5, 0.9), (0.9, 0.5, 0.9)], (230, 20, 10), 0.2, 1.0),
                i,
            )
            .unwrap();
        }
        c.apply_stroke(
            &stroke(&[(0.1, 0.5, 0.9), (0.9, 0.5, 0.9)], (10, 30, 200), 0.2, 1.0),
            99,
        )
        .unwrap();
        let [r, _, b] = pixel(&c, 48, 48);
        assert!(b > r * 4.0, "expected blue on top, got r={r} b={b}");
    }

    #[test]
    fn slow_strokes_still_paint() {
        // At 10 px/s each long span would exceed hokusai's 5 s stroke break.
        let mut s = stroke(&[(0.02, 0.5, 1.0), (0.98, 0.5, 1.0)], (0, 0, 0), 0.05, 1.0);
        s.speed = Some(10.0);
        let mut c = Canvas::new(1024, 64).unwrap();
        c.apply_stroke(&s, 1).unwrap();
        assert!(opacity(&c, 512, 32) > 0.9, "slow stroke painted nothing");
    }

    #[test]
    fn a_stroke_that_does_not_move_paints_a_dot() {
        let s = stroke(&[(0.5, 0.5, 1.0), (0.5, 0.5, 1.0)], (0, 0, 0), 0.1, 1.0);
        let mut c = Canvas::new(200, 200).unwrap();
        c.apply_stroke(&s, 1).unwrap();
        assert!(opacity(&c, 100, 100) > 0.5, "dot stroke painted nothing");
        assert_eq!(opacity(&c, 150, 100), 0.0);
    }

    #[test]
    fn stroke_start_is_not_a_hard_blob() {
        // Without the warm-up event, hokusai's first dab skips opacity
        // linearization and leaves a disc at the start denser than the stroke body.
        let mut s = stroke(&[(0.2, 0.5, 1.0), (0.8, 0.5, 1.0)], (0, 0, 0), 0.1, 1.0);
        s.brush.flow = 0.4;
        let mut c = Canvas::new(200, 200).unwrap();
        c.apply_stroke(&s, 1).unwrap();
        let (start, middle) = (opacity(&c, 40, 100), opacity(&c, 100, 100));
        assert!(start <= middle + 0.02, "start {start} vs middle {middle}");
    }

    #[test]
    fn opacity_caps_single_stroke_coverage() {
        let mut c = Canvas::new(96, 96).unwrap();
        // Loop back and forth over the same spot: coverage must not exceed the cap.
        let zigzag: Vec<_> = (0..12)
            .map(|i| (if i % 2 == 0 { 0.2 } else { 0.8 }, 0.5, 1.0))
            .collect();
        c.apply_stroke(&stroke(&zigzag, (0, 0, 0), 0.2, 0.4), 1)
            .unwrap();
        let o = opacity(&c, 48, 48);
        assert!(
            (0.3..=0.41).contains(&o),
            "coverage {o} should approach but not exceed 0.4"
        );
    }

    #[test]
    fn replay_is_deterministic_and_checkpoint_restores_exactly() {
        let strokes = [
            stroke(
                &[(0.2, 0.2, 0.5), (0.5, 0.7, 1.0), (0.8, 0.3, 0.4)],
                (20, 120, 200),
                0.08,
                0.9,
            ),
            stroke(
                &[(0.1, 0.9, 1.0), (0.9, 0.1, 1.0)],
                (240, 200, 10),
                0.05,
                0.6,
            ),
        ];
        let mut a = Canvas::new(64, 64).unwrap();
        let mut b = Canvas::new(64, 64).unwrap();
        for (i, s) in strokes.iter().enumerate() {
            a.apply_stroke(s, i as u32).unwrap();
            b.apply_stroke(s, i as u32).unwrap();
        }
        assert_eq!(a.buf.pixels, b.buf.pixels);

        let restored = Canvas::from_checkpoint(&a.checkpoint(), 64, 64).unwrap();
        assert_eq!(restored.version(), 2);
        assert_eq!(restored.buf.pixels, a.buf.pixels);
        assert_eq!(restored.render_png().unwrap(), a.render_png().unwrap());
        assert_eq!(restored.render_jpeg(90).unwrap(), a.render_jpeg(90).unwrap());
    }

    #[test]
    fn rejects_invalid_strokes() {
        let mut c = Canvas::new(32, 32).unwrap();
        let mut s = stroke(&[(0.1, 0.1, 1.0), (0.2, 0.2, 1.0)], (0, 0, 0), 0.1, 1.0);
        s.points[0].x = f64::NAN;
        assert!(c.apply_stroke(&s, 0).is_err());
        let s = stroke(&[(0.1, 0.1, 1.0)], (0, 0, 0), 0.1, 1.0);
        assert!(c.apply_stroke(&s, 0).is_err());
        let s = stroke(&[(0.1, 0.1, 1.0), (0.2, 0.2, 1.0)], (0, 0, 0), 5.0, 1.0);
        assert!(c.apply_stroke(&s, 0).is_err());
        assert_eq!(c.version(), 0);
        assert!(Canvas::new(0, 10).is_err());
        assert!(Canvas::new(MAX_DIMENSION + 1, 10).is_err());
    }
}
