//! hokusai surface backed by the paint buffer.
//!
//! hokusai's stroke engine decides where dabs go and how big/opaque they are;
//! this surface rasterizes each dab's coverage, and [`PaintSurface::commit`]
//! mixes the stroke's paint into the buffer once the stroke is done.
//!
//! Coverage model: a stroke tracks its own per-pixel coverage, which builds up
//! with every dab (driven by `flow`) but never exceeds the stroke's `opacity`.
//! At commit, each touched pixel gets the brush color composited source-over at
//! that coverage, so an opaque stroke fully covers whatever is underneath, no
//! matter how much paint is already there (v1 weighted old paint by its
//! ever-growing thickness, so late strokes barely changed the color).
//!
//! A stroke is one color (acrylic has no smudge or color dynamics), so mixing
//! once per pixel at commit gives the same result as mixing per dab, at a
//! fraction of the cost. The canvas under a stroke therefore doesn't change
//! until commit, which only matters for smudging brushes reading `get_color`.

use hokusai_core::color::RgbaF32;
use hokusai_core::tile::{empty_tile, TilePixels};
use hokusai_core::{Dab, TiledSurface};

use crate::color::linear_to_srgb_rgb;
use crate::mixing::{self, BrushColor};
use crate::paint_buffer::{PaintBuffer, MAX_THICKNESS};

/// Thickness a fully covering stroke adds, before saturation.
const THICKNESS_PER_COVERAGE: f32 = 1.2;

pub struct PaintSurface<'a> {
    buf: &'a mut PaintBuffer,
    /// Per-pixel coverage of this stroke (0..1 as u16); lives only for the stroke.
    coverage: Vec<u16>,
    touched: Vec<u32>,
    /// Stroke opacity cap, 0..1.
    cap: f32,
    brush: BrushColor,
    /// Never used: hokusai only touches tiles from its default draw_dab/get_color,
    /// which this surface overrides. Present to satisfy the trait.
    scratch: Box<TilePixels>,
}

impl<'a> PaintSurface<'a> {
    /// `color` is the stroke color in linear RGB.
    pub fn new(buf: &'a mut PaintBuffer, opacity_cap: f32, color: [f32; 3]) -> Self {
        let n = buf.pixels.len();
        Self {
            buf,
            coverage: vec![0; n],
            touched: Vec::new(),
            cap: opacity_cap.clamp(0.0, 1.0),
            brush: BrushColor::new(color),
            scratch: empty_tile(),
        }
    }

    /// Mix the finished stroke into the paint buffer.
    pub fn commit(self) {
        for &i in &self.touched {
            let i = i as usize;
            let a = self.coverage[i] as f32 / u16::MAX as f32;
            let p = &mut self.buf.pixels[i];
            let o0 = p.opacity_f();
            let o1 = a + (1.0 - a) * o0;
            let fac = if o1 > 0.0 { a / o1 } else { 1.0 };
            p.set_linear(mixing::mix(p.linear(), &self.brush, fac));
            p.set_opacity(o1);
            let th = p.thickness_f();
            p.set_thickness(th + a * THICKNESS_PER_COVERAGE * (1.0 - th / MAX_THICKNESS));
        }
    }
}

impl TiledSurface for PaintSurface<'_> {
    fn tile_request_start(&mut self, _tx: i32, _ty: i32) -> &mut TilePixels {
        &mut self.scratch
    }

    fn tile_request_end(&mut self, _tx: i32, _ty: i32) {}

    fn draw_dab(&mut self, dab: &Dab) -> bool {
        let (width, height) = (self.buf.width, self.buf.height);
        draw_dab_coverage(width, height, &mut self.coverage, &mut self.touched, self.cap, dab)
    }

    fn get_color(&self, x: f32, y: f32, radius: f32) -> RgbaF32 {
        average_color(self.buf, x, y, radius)
    }

    fn get_color_pigment(&self, x: f32, y: f32, radius: f32, _paint: f32) -> RgbaF32 {
        average_color(self.buf, x, y, radius)
    }
}

/// Accumulate one dab into the stroke's coverage, capped at the stroke opacity.
fn draw_dab_coverage(
    width: usize,
    height: usize,
    coverage: &mut [u16],
    touched: &mut Vec<u32>,
    cap: f32,
    dab: &Dab,
) -> bool {
    if dab.radius < 0.5 || dab.opaque < 0.001 || cap <= 0.0 {
        return false;
    }
    let (w, h) = (width as i32, height as i32);
    let aspect = dab.aspect_ratio.max(1.0);
    let (sin, cos) = dab.angle.to_radians().sin_cos();
    let reach = (dab.radius * aspect + 1.0).ceil() as i32;
    let (cx, cy) = (dab.x.round() as i32, dab.y.round() as i32);
    let hardness = dab.hardness.clamp(0.0, 1.0);
    let inv_radius = 1.0 / dab.radius;
    let cap_u16 = (cap * u16::MAX as f32 + 0.5) as u16;
    let mut changed = false;

    for py in (cy - reach).max(0)..=(cy + reach).min(h - 1) {
        // Distances are measured from pixel centers, as in libmypaint.
        let dy = py as f32 + 0.5 - dab.y;
        for px in (cx - reach).max(0)..=(cx + reach).min(w - 1) {
            let dx = px as f32 + 0.5 - dab.x;
            // Rotate into dab space; the major axis is stretched by the aspect ratio.
            let (lx, ly) = (dx * cos + dy * sin, -dx * sin + dy * cos);
            let d = ((lx / aspect).powi(2) + ly * ly).sqrt() * inv_radius;
            if d > 1.0 {
                continue;
            }
            // Hard core out to `hardness`, quadratic falloff beyond (v1's profile).
            let mask = if hardness >= 1.0 || d <= hardness {
                1.0
            } else {
                let t = (d - hardness) / (1.0 - hardness);
                (1.0 - t * t).max(0.0)
            };
            let dab_alpha = (mask * dab.opaque).min(1.0);
            if dab_alpha < 0.003 {
                continue;
            }

            let i = py as usize * width + px as usize;
            let c0u = coverage[i];
            if c0u >= cap_u16 {
                continue;
            }
            let c0 = c0u as f32 / u16::MAX as f32;
            let c1 = (c0 + dab_alpha * (1.0 - c0)).min(cap);
            if c0u == 0 {
                touched.push(i as u32);
            }
            coverage[i] = ((c1 * u16::MAX as f32 + 0.5) as u16).max(1);
            changed = true;
        }
    }
    changed
}

/// Weighted average of the canvas color under a circle, composited over white,
/// in the same (sRGB) space as brush colors. Used by smudging brushes.
fn average_color(buf: &PaintBuffer, x: f32, y: f32, radius: f32) -> RgbaF32 {
    let radius = radius.max(0.5);
    let (w, h) = (buf.width as i32, buf.height as i32);
    let reach = (radius + 1.0).ceil() as i32;
    let (cx, cy) = (x.round() as i32, y.round() as i32);
    let (mut sum, mut total) = ([0.0f64; 3], 0.0f64);
    for py in (cy - reach).max(0)..=(cy + reach).min(h - 1) {
        for px in (cx - reach).max(0)..=(cx + reach).min(w - 1) {
            let dist = ((px as f32 + 0.5 - x).powi(2) + (py as f32 + 0.5 - y).powi(2)).sqrt();
            if dist > radius {
                continue;
            }
            let weight = (1.0 - dist / radius) as f64;
            let p = &buf.pixels[buf.index(px as usize, py as usize)];
            let alpha = p.opacity_f();
            let srgb = linear_to_srgb_rgb(p.linear());
            for c in 0..3 {
                sum[c] += (srgb[c] * alpha + (1.0 - alpha)) as f64 * weight;
            }
            total += weight;
        }
    }
    if total <= 0.0 {
        return RgbaF32::new(1.0, 1.0, 1.0, 1.0);
    }
    RgbaF32::new(
        (sum[0] / total) as f32,
        (sum[1] / total) as f32,
        (sum[2] / total) as f32,
        1.0,
    )
}
