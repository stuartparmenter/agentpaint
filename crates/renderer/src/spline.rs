//! Catmull-Rom interpolation of stroke control points.
//!
//! Agents send 2-50 control points; the brush engine expects dense, tablet-like
//! input, so each span is subdivided before it reaches hokusai.

/// A point in pixel space with pressure.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}

pub fn catmull_rom(points: &[Sample], segments_per_span: usize) -> Vec<Sample> {
    let n = points.len();
    if n < 2 || segments_per_span == 0 {
        return points.to_vec();
    }
    if n == 2 {
        return (0..=segments_per_span)
            .map(|i| lerp(points[0], points[1], i as f64 / segments_per_span as f64))
            .collect();
    }

    let mut out = Vec::with_capacity((n - 1) * segments_per_span + 1);
    for i in 0..n - 1 {
        let p0 = points[i.saturating_sub(1)];
        let p1 = points[i];
        let p2 = points[i + 1];
        let p3 = points[(i + 2).min(n - 1)];
        for seg in 0..segments_per_span {
            out.push(catmull_rom_point(
                p0,
                p1,
                p2,
                p3,
                seg as f64 / segments_per_span as f64,
            ));
        }
    }
    out.push(points[n - 1]);
    out
}

fn catmull_rom_scalar(v0: f64, v1: f64, v2: f64, v3: f64, t: f64) -> f64 {
    let (t2, t3) = (t * t, t * t * t);
    0.5 * ((2.0 * v1)
        + (-v0 + v2) * t
        + (2.0 * v0 - 5.0 * v1 + 4.0 * v2 - v3) * t2
        + (-v0 + 3.0 * v1 - 3.0 * v2 + v3) * t3)
}

fn catmull_rom_point(p0: Sample, p1: Sample, p2: Sample, p3: Sample, t: f64) -> Sample {
    Sample {
        x: catmull_rom_scalar(p0.x, p1.x, p2.x, p3.x, t),
        y: catmull_rom_scalar(p0.y, p1.y, p2.y, p3.y, t),
        pressure: catmull_rom_scalar(p0.pressure, p1.pressure, p2.pressure, p3.pressure, t)
            .clamp(0.0, 1.0),
    }
}

fn lerp(a: Sample, b: Sample, t: f64) -> Sample {
    Sample {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: f64, y: f64, pressure: f64) -> Sample {
        Sample { x, y, pressure }
    }

    #[test]
    fn two_points_interpolate_linearly() {
        let out = catmull_rom(&[s(0.0, 0.0, 0.0), s(100.0, 100.0, 1.0)], 10);
        assert_eq!(out.len(), 11);
        assert!(out[0].x.abs() < 1e-9);
        assert!((out[5].x - 50.0).abs() < 1e-9);
        assert!((out[10].pressure - 1.0).abs() < 1e-9);
    }

    #[test]
    fn single_point_passes_through() {
        assert_eq!(catmull_rom(&[s(5.0, 5.0, 0.5)], 10).len(), 1);
    }

    #[test]
    fn curve_hits_control_points_and_keeps_pressure_in_range() {
        let pts = [
            s(0.0, 0.0, 0.0),
            s(50.0, 100.0, 1.0),
            s(100.0, 50.0, 1.0),
            s(150.0, 80.0, 0.0),
        ];
        let out = catmull_rom(&pts, 10);
        assert_eq!(out.len(), 31);
        assert!((out[10].x - 50.0).abs() < 1e-9 && (out[10].y - 100.0).abs() < 1e-9);
        assert!(out.iter().all(|p| (0.0..=1.0).contains(&p.pressure)));
    }
}
