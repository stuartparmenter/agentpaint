//! sRGB ↔ linear helpers on RGB triples.

use hokusai_core::color::{linear_to_srgb, srgb_to_linear};

pub fn srgb_to_linear_rgb(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| srgb_to_linear(v.clamp(0.0, 1.0)))
}

pub fn linear_to_srgb_rgb(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| linear_to_srgb(v.clamp(0.0, 1.0)))
}
