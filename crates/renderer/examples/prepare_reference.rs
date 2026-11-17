//! Shrink a source image into a built-in reference: PNG in, PNG out, keeping
//! the aspect ratio, resampled in linear light like the scorer.
//!
//!     cargo run --release -p agentpaint-renderer --example prepare_reference -- source.png out.png [width]

use agentpaint_renderer::score::Reference;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output, rest @ ..] = args.as_slice() else {
        return Err("usage: prepare_reference <source.png> <out.png> [width]".into());
    };
    let width: usize = rest.first().map(|s| s.parse().map_err(|_| "bad width")).transpose()?.unwrap_or(1024);
    let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
    let (sw, sh) = png_size(&bytes)?;
    let height = ((width as f64) * sh as f64 / sw as f64).round() as usize;
    let reference = Reference::from_png(&bytes, width, height)?;

    let file = std::fs::File::create(output).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_compression(png::Compression::High);
    encoder
        .write_header()
        .and_then(|mut w| w.write_image_data(&reference.rgb))
        .map_err(|e| e.to_string())?;
    eprintln!(
        "{sw}x{sh} -> {width}x{height}; anchors: blank {:.3}, mean color {:.3}",
        reference.blank_score, reference.mean_color_score
    );
    Ok(())
}

fn png_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    let reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().map_err(|e| e.to_string())?;
    Ok((reader.info().width, reader.info().height))
}
