//! Render a JSON array of normalized strokes to a PNG (and a quality-90 JPEG beside it).
//!
//!     cargo run --release -p agentpaint-renderer --example render -- strokes.json out.png [size]
//!
//! Each stroke's seed is its 1-based version, matching how the Worker replays strokes.

use std::time::Instant;

use agentpaint_renderer::{Canvas, Stroke};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output, rest @ ..] = args.as_slice() else {
        return Err("usage: render <strokes.json> <out.png> [size]".into());
    };
    let size: u32 = rest
        .first()
        .map(|s| s.parse().map_err(|_| "bad size"))
        .transpose()?
        .unwrap_or(1024);

    let json = std::fs::read_to_string(input).map_err(|e| e.to_string())?;
    let strokes: Vec<Stroke> = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    let mut canvas = Canvas::new(size, size)?;
    let start = Instant::now();
    for (i, stroke) in strokes.iter().enumerate() {
        canvas.apply_stroke(stroke, i as u32 + 1)?;
    }
    let painted = start.elapsed();
    let png = canvas.render_png()?;
    let jpeg = canvas.render_jpeg(90)?;
    let encoded = start.elapsed() - painted;
    let checkpoint = canvas.checkpoint();
    std::fs::write(output, &png).map_err(|e| e.to_string())?;
    let jpeg_path = std::path::Path::new(output).with_extension("jpg");
    std::fs::write(&jpeg_path, &jpeg).map_err(|e| e.to_string())?;

    eprintln!(
        "{} strokes in {:.1?} ({:.1?}/stroke), composite+png {:.1?}, png {} KB, jpeg {} KB, checkpoint {} KB",
        strokes.len(),
        painted,
        painted / strokes.len().max(1) as u32,
        encoded,
        png.len() / 1024,
        jpeg.len() / 1024,
        checkpoint.len() / 1024
    );
    Ok(())
}
