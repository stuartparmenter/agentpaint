//! Pigment-style color mixing.
//!
//! Colors are stored as straight-alpha linear sRGB. Mixing converts both colors
//! into the mixing model's space, blends, and converts back, so the paint buffer
//! never stores model-specific data.
//!
//! - `mixbox` feature (default): Mixbox latent-space mixing. Vivid, and converting a
//!   color in and out is exact, so thin layers of one color don't drift.
//!   CC BY-NC 4.0, non-commercial use only.
//! - Without it: hokusai's 10-channel spectral weighted geometric mean (libmypaint's
//!   "pigment" mode). Apache-2.0. More muted, and saturated blues and greens shift
//!   slightly under many thin layers of the same color.

#[cfg(not(feature = "mixbox"))]
use hokusai_core::spectral::{fastpow, rgb_to_spectral, spectral_to_rgb};

pub type Linear = [f32; 3];

/// A brush color prepared once per dab, so per-pixel mixing only converts the canvas side.
pub struct BrushColor {
    pub linear: Linear,
    #[cfg(not(feature = "mixbox"))]
    spectral: [f32; 10],
    #[cfg(feature = "mixbox")]
    latent: [f32; mixbox::LATENT_SIZE],
}

impl BrushColor {
    pub fn new(linear: Linear) -> Self {
        Self {
            linear,
            #[cfg(not(feature = "mixbox"))]
            spectral: rgb_to_spectral(linear[0], linear[1], linear[2]),
            #[cfg(feature = "mixbox")]
            latent: mixbox::linear_float_rgb_to_latent(&linear),
        }
    }
}

/// Mix `brush` into `canvas`, where `fac` is the brush's share (0..1).
#[inline]
pub fn mix(canvas: Linear, brush: &BrushColor, fac: f32) -> Linear {
    if fac >= 0.999 {
        return brush.linear;
    }
    if fac <= 0.001 {
        return canvas;
    }
    mix_inner(canvas, brush, fac)
}

#[cfg(not(feature = "mixbox"))]
#[inline]
fn mix_inner(canvas: Linear, brush: &BrushColor, fac: f32) -> Linear {
    let spec_canvas = rgb_to_spectral(canvas[0], canvas[1], canvas[2]);
    let mut out = [0.0f32; 10];
    for i in 0..10 {
        out[i] = fastpow(brush.spectral[i], fac) * fastpow(spec_canvas[i], 1.0 - fac);
    }
    let (r, g, b) = spectral_to_rgb(&out);
    [r, g, b]
}

#[cfg(feature = "mixbox")]
#[inline]
fn mix_inner(canvas: Linear, brush: &BrushColor, fac: f32) -> Linear {
    let lat_canvas = mixbox::linear_float_rgb_to_latent(&canvas);
    let mut lat = [0.0f32; mixbox::LATENT_SIZE];
    for i in 0..mixbox::LATENT_SIZE {
        lat[i] = lat_canvas[i] * (1.0 - fac) + brush.latent[i] * fac;
    }
    mixbox::latent_to_linear_float_rgb(&lat)
}

pub fn model_name() -> &'static str {
    if cfg!(feature = "mixbox") {
        "mixbox"
    } else {
        "spectral"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hokusai_core::color::srgb_to_linear;

    fn lin(r: u8, g: u8, b: u8) -> Linear {
        [r, g, b].map(|v| srgb_to_linear(v as f32 / 255.0))
    }

    #[test]
    fn full_and_zero_share_return_endpoints() {
        let canvas = lin(255, 255, 255);
        let brush = BrushColor::new(lin(200, 30, 30));
        assert_eq!(mix(canvas, &brush, 1.0), brush.linear);
        assert_eq!(mix(canvas, &brush, 0.0), canvas);
    }

    #[test]
    fn blue_and_yellow_make_green() {
        let [r, g, b] = mix(lin(0, 33, 133), &BrushColor::new(lin(252, 211, 0)), 0.5);
        assert!(
            g > r && g > b,
            "expected green-dominant mix, got {r} {g} {b}"
        );
    }
}
