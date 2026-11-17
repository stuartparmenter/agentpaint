//! Acrylic brush configuration for hokusai.
//!
//! The brush starts from libmypaint's defaults (hokusai's `Brush::new()` is all
//! zeros), then sets explicit pressure mappings for radius and opacity. No
//! preset is loaded, which avoids preset scatter and speed dynamics.

use hokusai_core::color::rgb_to_hsv;
use hokusai_core::{Brush, BrushInput, BrushSetting as S, InputMapping, SettingValue};

use crate::stroke::Stroke;

/// libmypaint `brushsettings.json` defaults for the settings that are non-zero
/// there. Settings not listed default to 0 in both.
const LIBMYPAINT_DEFAULTS: &[(S, f32)] = &[
    (S::Opaque, 1.0),
    (S::OpaqueMultiply, 0.0),
    (S::OpaqueLinearize, 0.9),
    (S::Radius, 2.0),
    (S::Hardness, 0.8),
    (S::AntiAliasing, 1.0),
    (S::DabsPerActualRadius, 2.0),
    (S::Speed1Slowness, 0.04),
    (S::Speed2Slowness, 0.8),
    (S::Speed1Gamma, 4.0),
    (S::Speed2Gamma, 4.0),
    (S::OffsetBySpeedSlowness, 1.0),
    (S::SmudgeLength, 0.5),
    (S::StrokeDurationLogarithmic, 4.0),
    (S::StrokeHoldtime, 1.0),
    (S::EllipticalDabRatio, 1.0),
    (S::EllipticalDabAngle, 90.0),
    (S::DirectionFilter, 2.0),
    (S::PosterizeNum, 0.05),
];

fn set(brush: &mut Brush, setting: S, base: f32) {
    brush.get_mut(setting).base_value = base;
}

fn map_pressure(brush: &mut Brush, setting: S, points: &[(f32, f32)]) {
    let mut mapping = InputMapping::new(BrushInput::Pressure);
    mapping.points = points.to_vec();
    let value: &mut SettingValue = brush.get_mut(setting);
    value.inputs.retain(|m| m.input != BrushInput::Pressure);
    value.inputs.push(mapping);
}

/// Build the acrylic brush for a stroke on a canvas `canvas_width` pixels wide.
pub fn acrylic(stroke: &Stroke, canvas_width: f64) -> Brush {
    let mut brush = Brush::new();
    for &(setting, value) in LIBMYPAINT_DEFAULTS {
        set(&mut brush, setting, value);
    }

    let c = stroke.color;
    let hsv = rgb_to_hsv(c.r as f32 / 255.0, c.g as f32 / 255.0, c.b as f32 / 255.0);
    set(&mut brush, S::ColorH, hsv.h);
    set(&mut brush, S::ColorS, hsv.s);
    set(&mut brush, S::ColorV, hsv.v);

    // libmypaint radius is ln(pixels); brush.size is the diameter as a fraction of canvas width.
    let radius_px = (stroke.brush.size * canvas_width * 0.5).max(0.5);
    set(&mut brush, S::Radius, (radius_px as f32).ln());
    // Slightly thinner at zero pressure (e^-0.3 ≈ 0.74×), full radius at p=1.
    map_pressure(&mut brush, S::Radius, &[(0.0, -0.3), (1.0, 0.0)]);

    // Per-pass paint deposit is `flow`; opaque_linearize (left at the libmypaint
    // default) compensates for dab overlap, so one pass reaches roughly `flow`
    // coverage. The stroke's `opacity` cap is enforced by the surface.
    set(
        &mut brush,
        S::Opaque,
        stroke.brush.flow.clamp(0.0, 1.0) as f32,
    );
    // Pressure gates paint output: none at p=0, full from p=0.1.
    set(&mut brush, S::OpaqueMultiply, 0.0);
    map_pressure(
        &mut brush,
        S::OpaqueMultiply,
        &[(0.0, 0.0), (0.1, 1.0), (1.0, 1.0)],
    );

    set(
        &mut brush,
        S::Hardness,
        stroke.brush.hardness.clamp(0.0, 1.0) as f32,
    );
    set(&mut brush, S::DabsPerBasicRadius, 6.0);
    set(&mut brush, S::DabsPerActualRadius, 2.0);

    // Acrylic dries between strokes (each stroke is a separate agent call):
    // no smudging of the paint underneath.
    set(&mut brush, S::Smudge, 0.0);
    set(&mut brush, S::SmudgeLength, 0.0);
    set(&mut brush, S::Eraser, 0.0);
    set(&mut brush, S::Paint, 0.0);
    brush
}
