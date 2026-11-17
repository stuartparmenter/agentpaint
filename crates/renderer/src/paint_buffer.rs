//! Per-pixel paint state, canvas texture, compositing and checkpoints.
//!
//! Each pixel stores 10 bytes: straight-alpha linear RGB (u16), paint coverage
//! over the bare canvas (u16), and paint thickness (u16, fixed point) which only
//! drives impasto lighting. Colors are mixed on the fly (see `mixing`), so no
//! model-specific pigment data is stored.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::OnceLock;

use hokusai_core::color::linear_to_srgb;

pub const MAX_DIMENSION: u32 = 4096;

/// Thickness saturates here, so stacked layers keep visible relief at stroke
/// edges instead of growing without bound (v1's thickness grew ~1.6 per stroke).
pub const MAX_THICKNESS: f32 = 4.0;

const U16_MAX: f32 = u16::MAX as f32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PaintPixel {
    pub r: u16,
    pub g: u16,
    pub b: u16,
    /// Paint coverage over the bare canvas, 0..1.
    pub opacity: u16,
    /// 0..MAX_THICKNESS in fixed point.
    pub thickness: u16,
}

impl PaintPixel {
    #[inline]
    pub fn linear(&self) -> [f32; 3] {
        [
            self.r as f32 / U16_MAX,
            self.g as f32 / U16_MAX,
            self.b as f32 / U16_MAX,
        ]
    }

    #[inline]
    pub fn set_linear(&mut self, c: [f32; 3]) {
        self.r = to_u16(c[0]);
        self.g = to_u16(c[1]);
        self.b = to_u16(c[2]);
    }

    #[inline]
    pub fn opacity_f(&self) -> f32 {
        self.opacity as f32 / U16_MAX
    }

    #[inline]
    pub fn set_opacity(&mut self, v: f32) {
        self.opacity = to_u16(v);
    }

    #[inline]
    pub fn thickness_f(&self) -> f32 {
        self.thickness as f32 / U16_MAX * MAX_THICKNESS
    }

    #[inline]
    pub fn set_thickness(&mut self, v: f32) {
        self.thickness = to_u16(v / MAX_THICKNESS);
    }
}

#[inline]
fn to_u16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * U16_MAX + 0.5) as u16
}

pub struct PaintBuffer {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<PaintPixel>,
    /// Canvas weave heightfield, 0..255. Shared by all canvases of the same size.
    texture: Rc<[u8]>,
}

impl PaintBuffer {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            pixels: vec![PaintPixel::default(); width * height],
            texture: shared_texture(width, height),
        }
    }

    #[inline]
    pub fn index(&self, x: usize, y: usize) -> usize {
        y * self.width + x
    }

    /// Composite paint over the textured canvas with impasto lighting.
    /// Returns tightly packed sRGB RGB8.
    pub fn composite_rgb(&self) -> Vec<u8> {
        let (w, h) = (self.width, self.height);
        let lut = srgb_lut();
        // Light from the upper left, as in v1.
        let (lx, ly) = {
            let (x, y) = (0.5f32, -0.3f32);
            let len = (x * x + y * y).sqrt();
            (x / len, y / len)
        };

        // Combined surface height: canvas weave fades under opaque paint,
        // paint thickness adds relief.
        let heights: Vec<f32> = self
            .pixels
            .iter()
            .zip(self.texture.iter())
            .map(|(p, &t)| {
                let canvas_h = t as f32 / 255.0;
                canvas_h * 0.3 * (1.0 - p.opacity_f()) + p.thickness_f() * 0.5
            })
            .collect();

        let mut out = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (nx, ny) = sobel_normal(&heights, w, h, x, y);
                let ndotl = nx * lx + ny * ly;

                let tex = self.texture[i] as f32 / 255.0;
                let canvas = [235.0 + tex * 18.0, 230.0 + tex * 18.0, 225.0 + tex * 16.0];
                let p = &self.pixels[i];
                let alpha = p.opacity_f();
                let o = i * 3;

                if alpha < 0.001 {
                    let light = (1.0 + ndotl * 0.15).clamp(0.85, 1.15);
                    for c in 0..3 {
                        out[o + c] = (canvas[c] * light).clamp(0.0, 255.0) as u8;
                    }
                    continue;
                }

                let diffuse = (1.0 + ndotl * 0.15).clamp(0.85, 1.15);
                let thickness = p.thickness_f();
                let specular = if thickness > 0.1 {
                    ndotl.max(0.0).powf(12.0) * thickness.min(1.0) * 0.12 * 255.0
                } else {
                    0.0
                };
                let canvas_light = 1.0 + ndotl * 0.1;
                let paint = [lut[p.r as usize], lut[p.g as usize], lut[p.b as usize]];
                for c in 0..3 {
                    let pc = paint[c] as f32 * diffuse + specular;
                    let cc = canvas[c] * canvas_light;
                    out[o + c] = (pc * alpha + cc * (1.0 - alpha)).clamp(0.0, 255.0) as u8;
                }
            }
        }
        out
    }

    /// Serialize the paint state (not the canvas texture).
    ///
    /// Format: b"APB2", u32 format=1, u32 width, u32 height, u32 version, then
    /// zlib-compressed byte planes (each u16 channel split into low/high bytes,
    /// channel by channel) — flat regions compress very well this way.
    pub fn checkpoint(&self, version: u32) -> Vec<u8> {
        let n = self.pixels.len();
        let mut planes = vec![0u8; n * 10];
        let channels: [fn(&PaintPixel) -> u16; 5] =
            [|p| p.r, |p| p.g, |p| p.b, |p| p.opacity, |p| p.thickness];
        for (c, get) in channels.iter().enumerate() {
            let (lo, hi) = (c * 2 * n, (c * 2 + 1) * n);
            for (i, p) in self.pixels.iter().enumerate() {
                let [l, h] = get(p).to_le_bytes();
                planes[lo + i] = l;
                planes[hi + i] = h;
            }
        }
        let mut out = Vec::with_capacity(20 + n);
        out.extend_from_slice(b"APB2");
        for v in [1u32, self.width as u32, self.height as u32, version] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(&planes, 3));
        out
    }

    /// Restore from [`checkpoint`](Self::checkpoint) output for a canvas of the
    /// expected size (checked before anything is allocated). Returns the buffer
    /// and its version.
    pub fn from_checkpoint(data: &[u8], width: u32, height: u32) -> Result<(Self, u32), String> {
        let (expected_w, expected_h) = (width, height);
        if data.len() < 20 || &data[0..4] != b"APB2" {
            return Err("not a paint buffer checkpoint".into());
        }
        let word = |i: usize| u32::from_le_bytes(data[4 + i * 4..8 + i * 4].try_into().unwrap());
        let (format, width, height, version) = (word(0), word(1), word(2), word(3));
        if format != 1 {
            return Err(format!("unsupported checkpoint format {format}"));
        }
        if width != expected_w || height != expected_h {
            return Err(format!("checkpoint is {width}x{height}, expected {expected_w}x{expected_h}"));
        }
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(format!("invalid checkpoint dimensions {width}x{height}"));
        }
        let n = (width * height) as usize;
        let planes = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&data[20..], n * 10)
            .map_err(|e| format!("corrupt checkpoint: {e:?}"))?;
        if planes.len() != n * 10 {
            return Err("checkpoint size mismatch".into());
        }
        let mut buf = Self::new(width as usize, height as usize);
        let read = |c: usize, i: usize| {
            u16::from_le_bytes([planes[c * 2 * n + i], planes[(c * 2 + 1) * n + i]])
        };
        for (i, p) in buf.pixels.iter_mut().enumerate() {
            *p = PaintPixel {
                r: read(0, i),
                g: read(1, i),
                b: read(2, i),
                opacity: read(3, i),
                thickness: read(4, i),
            };
        }
        Ok((buf, version))
    }
}

#[inline]
fn sobel_normal(h: &[f32], w: usize, ht: usize, x: usize, y: usize) -> (f32, f32) {
    if x == 0 || y == 0 || x + 1 >= w || y + 1 >= ht {
        return (0.0, 0.0);
    }
    let at = |dx: isize, dy: isize| h[(y as isize + dy) as usize * w + (x as isize + dx) as usize];
    let gx = (at(1, -1) + 2.0 * at(1, 0) + at(1, 1)) - (at(-1, -1) + 2.0 * at(-1, 0) + at(-1, 1));
    let gy = (at(-1, 1) + 2.0 * at(0, 1) + at(1, 1)) - (at(-1, -1) + 2.0 * at(0, -1) + at(1, -1));
    let len = (gx * gx + gy * gy + 1.0).sqrt();
    (-gx / len, -gy / len)
}

/// Linear u16 → sRGB u8.
fn srgb_lut() -> &'static [u8] {
    static LUT: OnceLock<Vec<u8>> = OnceLock::new();
    LUT.get_or_init(|| {
        (0..=u16::MAX)
            .map(|v| (linear_to_srgb(v as f32 / U16_MAX) * 255.0 + 0.5).clamp(0.0, 255.0) as u8)
            .collect()
    })
}

/// The canvas texture for a size, generated once and shared (1 MB at 1024²).
fn shared_texture(width: usize, height: usize) -> Rc<[u8]> {
    type Cached = Option<(usize, usize, Rc<[u8]>)>;
    thread_local! {
        static CACHE: RefCell<Cached> = const { RefCell::new(None) };
    }
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((w, h, texture)) = cache.as_ref()
            && (*w, *h) == (width, height)
        {
            return texture.clone();
        }
        let texture: Rc<[u8]> = canvas_weave(width, height).into();
        *cache = Some((width, height, texture.clone()));
        texture
    })
}

/// Procedural plain-weave canvas texture (v1's algorithm), quantized to u8.
fn canvas_weave(width: usize, height: usize) -> Vec<u8> {
    let scale = width as f32 / 256.0;
    let spacing = (scale * 1.5).max(2.0);
    let tau = std::f32::consts::TAU;
    let mut out = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            let (fx, fy) = (x as f32, y as f32);
            let warp =
                ((fy + hash_noise(x as u32, y as u32) * 0.3) / spacing * tau).sin() * 0.5 + 0.5;
            let weft = ((fx + hash_noise(x as u32 + 7919, y as u32) * 0.3) / spacing * tau).sin()
                * 0.5
                + 0.5;
            let over = ((fx / spacing) as i32 + (fy / spacing) as i32) % 2 == 0;
            let weave = if over {
                warp * 0.7 + weft * 0.3
            } else {
                weft * 0.7 + warp * 0.3
            };
            let fiber = hash_noise(x as u32 + 31337, y as u32 + 42) * 0.08;
            out[y * width + x] = ((weave + fiber).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    out
}

fn hash_noise(x: u32, y: u32) -> f32 {
    let mut h = x
        .wrapping_mul(374761393)
        .wrapping_add(y.wrapping_mul(668265263));
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    (h as f32 / u32::MAX as f32) * 2.0 - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_round_trips() {
        let mut buf = PaintBuffer::new(37, 21);
        for (i, p) in buf.pixels.iter_mut().enumerate() {
            let v = (i * 977 % 65536) as u16;
            *p = PaintPixel {
                r: v,
                g: v / 2,
                b: 65535 - v,
                opacity: v / 3,
                thickness: v / 7,
            };
        }
        let data = buf.checkpoint(42);
        let (restored, version) = PaintBuffer::from_checkpoint(&data, 37, 21).unwrap();
        assert_eq!(version, 42);
        assert_eq!((restored.width, restored.height), (37, 21));
        assert_eq!(restored.pixels, buf.pixels);
    }

    #[test]
    fn blank_1024_checkpoint_is_small() {
        let data = PaintBuffer::new(1024, 1024).checkpoint(0);
        assert!(
            data.len() < 100_000,
            "blank checkpoint was {} bytes",
            data.len()
        );
    }

    #[test]
    fn rejects_bad_checkpoints() {
        assert!(PaintBuffer::from_checkpoint(b"nope", 4, 4).is_err());
        let mut data = PaintBuffer::new(4, 4).checkpoint(1);
        data[8..12].copy_from_slice(&100_000u32.to_le_bytes());
        assert!(PaintBuffer::from_checkpoint(&data, 100_000, 4).is_err());
        assert!(PaintBuffer::from_checkpoint(&data, 4, 4).is_err());
        let data = PaintBuffer::new(4, 4).checkpoint(1);
        assert!(PaintBuffer::from_checkpoint(&data, 4, 5).is_err(), "height must match");
        let mut data = PaintBuffer::new(4, 4).checkpoint(1);
        data.truncate(30);
        assert!(PaintBuffer::from_checkpoint(&data, 4, 4).is_err());
    }

    #[test]
    fn blank_canvas_composites_to_warm_off_white() {
        let rgb = PaintBuffer::new(16, 16).composite_rgb();
        let i = (8 * 16 + 8) * 3;
        assert!(
            rgb[i] >= 200 && rgb[i] >= rgb[i + 2],
            "got {:?}",
            &rgb[i..i + 3]
        );
    }
}
