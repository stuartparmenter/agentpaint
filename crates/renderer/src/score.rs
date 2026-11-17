//! Scoring a canvas against a reference image.
//!
//! Both images are reduced to a 64x64 grid by averaging in linear light (the
//! canvas as a flat composite: paint over the plain canvas color, with no
//! weave texture or lighting), converted to OKLab, and compared cell by cell.
//! The score is `1 - mean OKLab distance`, clamped to 0..1: 1 is identical,
//! and the distance between black and white is 1.

use crate::color::{linear_to_srgb_rgb, srgb_to_linear_rgb};

pub const GRID: usize = 64;

/// OKLab colors, GRID x GRID, row-major.
pub type Grid = Vec<[f32; 3]>;

/// Linear RGB → OKLab (Björn Ottosson's reference matrices).
pub fn oklab(c: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = c;
    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l, m, s) = (l.max(0.0).cbrt(), m.max(0.0).cbrt(), s.max(0.0).cbrt());
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

/// Average linear-light colors into a GRID x GRID OKLab grid. Each cell averages
/// its own region of the image (at least one pixel, so small images work too).
pub fn grid_from<F: Fn(usize, usize) -> [f32; 3]>(width: usize, height: usize, linear_at: F) -> Grid {
    let span = |cell: usize, size: usize| {
        let lo = cell * size / GRID;
        let hi = ((cell + 1) * size / GRID).max(lo + 1).min(size);
        (lo.min(size - 1), hi)
    };
    let mut grid = Vec::with_capacity(GRID * GRID);
    for gy in 0..GRID {
        let (y0, y1) = span(gy, height);
        for gx in 0..GRID {
            let (x0, x1) = span(gx, width);
            let mut sum = [0.0f64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let c = linear_at(x, y);
                    for i in 0..3 {
                        sum[i] += c[i] as f64;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            grid.push(oklab([(sum[0] / n) as f32, (sum[1] / n) as f32, (sum[2] / n) as f32]));
        }
    }
    grid
}

/// Score `canvas` against `reference` (both grids); 0..1, higher is closer.
pub fn score(canvas: &[[f32; 3]], reference: &[[f32; 3]]) -> f32 {
    if canvas.len() != reference.len() || canvas.is_empty() {
        return 0.0;
    }
    let total: f64 = canvas
        .iter()
        .zip(reference)
        .map(|(a, b)| {
            let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
            ((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) as f64).sqrt()
        })
        .sum();
    (1.0 - total / canvas.len() as f64).clamp(0.0, 1.0) as f32
}

/// The plain canvas color used for flat composites (the weave's average), linear.
pub fn canvas_base_linear() -> [f32; 3] {
    srgb_to_linear_rgb([244.0 / 255.0, 239.0 / 255.0, 233.0 / 255.0])
}

/// A reference image prepared for one canvas size.
pub struct Reference {
    /// The reference resized to the canvas, sRGB RGB8 (what painters are shown).
    pub rgb: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub grid: Grid,
    /// Score of a blank canvas against this reference.
    pub blank_score: f32,
    /// Score of a canvas filled with the reference's average color.
    pub mean_color_score: f32,
}

impl Reference {
    /// Decode a PNG and fit it to a `width` x `height` canvas (center crop to the
    /// canvas aspect, then resample in linear light).
    pub fn from_png(png_bytes: &[u8], width: usize, height: usize) -> Result<Self, String> {
        let (src, sw, sh) = decode_png(png_bytes)?;
        let linear_src: Vec<[f32; 3]> = src.iter().map(|&c| srgb_to_linear_rgb(c)).collect();

        // Center crop to the canvas aspect ratio.
        let target_aspect = width as f64 / height as f64;
        let (cw, ch) = if sw as f64 / sh as f64 > target_aspect {
            ((sh as f64 * target_aspect).round() as usize, sh)
        } else {
            (sw, (sw as f64 / target_aspect).round() as usize)
        };
        let (cx, cy) = ((sw - cw) / 2, (sh - ch) / 2);

        let resized = resample(&linear_src, sw, cx, cy, cw.max(1), ch.max(1), width, height);
        let rgb: Vec<u8> = resized
            .iter()
            .flat_map(|&c| linear_to_srgb_rgb(c).map(|v| (v * 255.0 + 0.5) as u8))
            .collect();
        let grid = grid_from(width, height, |x, y| resized[y * width + x]);

        let base = canvas_base_linear();
        let blank = grid_from(GRID, GRID, |_, _| base);
        let mean = {
            let mut sum = [0.0f64; 3];
            for c in &resized {
                for i in 0..3 {
                    sum[i] += c[i] as f64;
                }
            }
            let n = resized.len().max(1) as f64;
            [
                (sum[0] / n) as f32,
                (sum[1] / n) as f32,
                (sum[2] / n) as f32,
            ]
        };
        let mean_fill = grid_from(GRID, GRID, |_, _| mean);
        Ok(Self {
            blank_score: score(&blank, &grid),
            mean_color_score: score(&mean_fill, &grid),
            rgb,
            width,
            height,
            grid,
        })
    }
}

/// Decode a PNG into sRGB float triples (alpha composited over white).
fn decode_png(bytes: &[u8]) -> Result<(Vec<[f32; 3]>, usize, usize), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (w, h) = (reader.info().width as usize, reader.info().height as usize);
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return Err(format!(
            "reference must be 1..=8192 px per side, got {w}x{h}"
        ));
    }
    let mut buf = vec![0u8; reader.output_buffer_size().ok_or("reference too large")?];
    let frame = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let data = &buf[..frame.buffer_size()];
    let channels = frame.color_type.samples();
    let pixels = data
        .chunks_exact(channels)
        .map(|p| {
            let f = |v: u8| v as f32 / 255.0;
            let (rgb, a) = match channels {
                1 => ([f(p[0]); 3], 1.0),
                2 => ([f(p[0]); 3], f(p[1])),
                3 => ([f(p[0]), f(p[1]), f(p[2])], 1.0),
                _ => ([f(p[0]), f(p[1]), f(p[2])], f(p[3])),
            };
            rgb.map(|v| v * a + (1.0 - a))
        })
        .collect();
    Ok((pixels, w, h))
}

/// Resample a crop of `src` (row stride `sw`) to `dw` x `dh`: box average when
/// shrinking, bilinear when enlarging.
#[allow(clippy::too_many_arguments)]
fn resample(
    src: &[[f32; 3]],
    sw: usize,
    cx: usize,
    cy: usize,
    cw: usize,
    ch: usize,
    dw: usize,
    dh: usize,
) -> Vec<[f32; 3]> {
    let (fx, fy) = (cw as f64 / dw as f64, ch as f64 / dh as f64);
    let at = |x: usize, y: usize| src[(cy + y.min(ch - 1)) * sw + cx + x.min(cw - 1)];
    let mut out = Vec::with_capacity(dw * dh);
    for y in 0..dh {
        for x in 0..dw {
            if fx >= 1.0 && fy >= 1.0 {
                let (x0, x1) = (
                    (x as f64 * fx) as usize,
                    (((x + 1) as f64 * fx) as usize).max((x as f64 * fx) as usize + 1),
                );
                let (y0, y1) = (
                    (y as f64 * fy) as usize,
                    (((y + 1) as f64 * fy) as usize).max((y as f64 * fy) as usize + 1),
                );
                let mut sum = [0.0f64; 3];
                for sy in y0..y1.min(ch) {
                    for sx in x0..x1.min(cw) {
                        let c = at(sx, sy);
                        for i in 0..3 {
                            sum[i] += c[i] as f64;
                        }
                    }
                }
                let n = ((y1.min(ch) - y0) * (x1.min(cw) - x0)).max(1) as f64;
                out.push([
                    (sum[0] / n) as f32,
                    (sum[1] / n) as f32,
                    (sum[2] / n) as f32,
                ]);
            } else {
                let sx = ((x as f64 + 0.5) * fx - 0.5).max(0.0);
                let sy = ((y as f64 + 0.5) * fy - 0.5).max(0.0);
                let (x0, y0) = (sx as usize, sy as usize);
                let (tx, ty) = ((sx - x0 as f64) as f32, (sy - y0 as f64) as f32);
                let (a, b, c, d) = (
                    at(x0, y0),
                    at(x0 + 1, y0),
                    at(x0, y0 + 1),
                    at(x0 + 1, y0 + 1),
                );
                out.push([0, 1, 2].map(|i| {
                    let top = a[i] + (b[i] - a[i]) * tx;
                    let bottom = c[i] + (d[i] - c[i]) * tx;
                    top + (bottom - top) * ty
                }));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, width, height);
            e.set_color(png::ColorType::Rgb);
            let mut data = Vec::with_capacity((width * height * 3) as usize);
            for y in 0..height {
                for x in 0..width {
                    data.extend_from_slice(&pixel(x, y));
                }
            }
            e.write_header().unwrap().write_image_data(&data).unwrap();
        }
        out
    }

    #[test]
    fn identical_grids_score_one_and_black_vs_white_scores_zero() {
        let white = grid_from(4, 4, |_, _| [1.0; 3]);
        let black = grid_from(4, 4, |_, _| [0.0; 3]);
        assert!((score(&white, &white) - 1.0).abs() < 1e-6);
        assert!(score(&white, &black) < 0.01);
    }

    #[test]
    fn reference_is_cropped_resized_and_anchored() {
        // 200x100 image: left half red, right half blue; square crop keeps the middle.
        let bytes = png(200, 100, |x, _| {
            if x < 100 {
                [220, 20, 20]
            } else {
                [20, 20, 220]
            }
        });
        let r = Reference::from_png(&bytes, 64, 64).unwrap();
        assert_eq!(r.rgb.len(), 64 * 64 * 3);
        let left = &r.rgb[(32 * 64 + 5) * 3..(32 * 64 + 5) * 3 + 3];
        let right = &r.rgb[(32 * 64 + 58) * 3..(32 * 64 + 58) * 3 + 3];
        assert!(
            left[0] > 150 && right[2] > 150,
            "left {left:?} right {right:?}"
        );
        assert!(
            r.mean_color_score > r.blank_score,
            "a mean-color fill should beat a blank canvas here"
        );
        assert!((0.0..=1.0).contains(&r.blank_score));
    }

    #[test]
    fn small_references_are_enlarged() {
        let bytes = png(8, 8, |_, _| [10, 200, 30]);
        let r = Reference::from_png(&bytes, 32, 32).unwrap();
        assert_eq!(&r.rgb[0..3], &[10, 200, 30]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(Reference::from_png(b"not a png", 64, 64).is_err());
    }
}
