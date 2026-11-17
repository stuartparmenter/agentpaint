//! Stroke input, in canvas-independent units.
//!
//! The Worker validates the agent's pixel-space stroke and normalizes it:
//! point coordinates and brush size become fractions of the canvas width/height,
//! so the same stroke list can be replayed at any resolution. Fields this
//! format doesn't use (such as `tip_shape` and `blend_mode`) are ignored.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StrokePoint {
    /// 0..1, fraction of canvas width.
    pub x: f64,
    /// 0..1, fraction of canvas height.
    pub y: f64,
    /// 0..1.
    pub pressure: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Brush {
    /// Brush diameter as a fraction of canvas width.
    pub size: f64,
    /// 0 = soft edge, 1 = hard edge.
    pub hardness: f64,
    /// Maximum coverage a single stroke can reach (0..1).
    pub opacity: f64,
    /// How much paint each pass deposits (0..1); coverage builds up to `opacity`.
    pub flow: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub points: Vec<StrokePoint>,
    pub brush: Brush,
    pub color: Color,
    /// Drawing speed in canvas pixels per second; estimated from point spacing when absent.
    #[serde(default)]
    pub speed: Option<f64>,
}

impl Stroke {
    /// Drawing speed in pixels per second, estimated when not given:
    /// points spaced far apart relative to the brush were drawn quickly.
    pub fn effective_speed(&self, canvas_width: f64) -> f64 {
        if let Some(speed) = self.speed {
            return speed.clamp(10.0, 5000.0);
        }
        if self.points.len() < 2 {
            return 400.0;
        }
        let total: f64 = self
            .points
            .windows(2)
            .map(|w| {
                let dx = (w[1].x - w[0].x) * canvas_width;
                let dy = (w[1].y - w[0].y) * canvas_width;
                (dx * dx + dy * dy).sqrt()
            })
            .sum();
        let avg_spacing = total / (self.points.len() - 1) as f64;
        let brush_px = self.brush.size * canvas_width;
        (avg_spacing / brush_px.max(1.0) * 400.0).clamp(100.0, 1000.0)
    }
}
