//! wasm-bindgen wrapper around [`Canvas`] for the Worker.
//!
//! Strokes cross the boundary as JSON (the same normalized format stored in the
//! database); errors become JS exceptions.

use wasm_bindgen::prelude::*;

use crate::score::{GRID, Reference};
use crate::{Canvas, Stroke};

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen(js_name = mixingModel)]
pub fn mixing_model() -> String {
    crate::mixing_model().to_string()
}

/// Parse and validate a stroke (JSON) without touching any canvas.
#[wasm_bindgen(js_name = validateStroke)]
pub fn validate_stroke(stroke_json: &str) -> Result<(), JsError> {
    let stroke: Stroke =
        serde_json::from_str(stroke_json).map_err(|e| JsError::new(&e.to_string()))?;
    crate::validate(&stroke).map_err(|e| JsError::new(&e))
}

/// A reference image fitted to a canvas: the JPEG painters see, the scoring
/// grid, and the two anchor scores.
#[wasm_bindgen(js_name = PreparedReference)]
pub struct WasmReference {
    jpeg: Vec<u8>,
    grid: Vec<f32>,
    blank_score: f32,
    mean_color_score: f32,
}

#[wasm_bindgen(js_class = PreparedReference)]
impl WasmReference {
    #[wasm_bindgen(getter)]
    pub fn jpeg(&self) -> Vec<u8> {
        self.jpeg.clone()
    }

    /// OKLab grid, flattened (GRID * GRID * 3 floats).
    #[wasm_bindgen(getter)]
    pub fn grid(&self) -> Vec<f32> {
        self.grid.clone()
    }

    #[wasm_bindgen(getter, js_name = blankScore)]
    pub fn blank_score(&self) -> f32 {
        self.blank_score
    }

    #[wasm_bindgen(getter, js_name = meanColorScore)]
    pub fn mean_color_score(&self) -> f32 {
        self.mean_color_score
    }
}

/// Fit a PNG reference to a `width` x `height` canvas.
#[wasm_bindgen(js_name = prepareReference)]
pub fn prepare_reference(png: &[u8], width: u32, height: u32, jpeg_quality: u8) -> Result<WasmReference, JsError> {
    let r = Reference::from_png(png, width as usize, height as usize).map_err(|e| JsError::new(&e))?;
    let jpeg = crate::encode_jpeg(&r.rgb, width, height, jpeg_quality).map_err(|e| JsError::new(&e))?;
    Ok(WasmReference {
        jpeg,
        grid: r.grid.iter().flatten().copied().collect(),
        blank_score: r.blank_score,
        mean_color_score: r.mean_color_score,
    })
}

fn unflatten(grid: &[f32]) -> Result<Vec<[f32; 3]>, JsError> {
    if grid.len() != GRID * GRID * 3 {
        return Err(JsError::new("reference grid has the wrong size"));
    }
    Ok(grid.as_chunks::<3>().0.to_vec())
}

#[wasm_bindgen(js_name = Canvas)]
pub struct WasmCanvas(Canvas);

#[wasm_bindgen(js_class = Canvas)]
impl WasmCanvas {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<WasmCanvas, JsError> {
        Canvas::new(width, height)
            .map(Self)
            .map_err(|e| JsError::new(&e))
    }

    /// Restore a canvas of the given size; anything else is rejected before allocating.
    #[wasm_bindgen(js_name = fromCheckpoint)]
    pub fn from_checkpoint(data: &[u8], width: u32, height: u32) -> Result<WasmCanvas, JsError> {
        Canvas::from_checkpoint(data, width, height)
            .map(Self)
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u32 {
        self.0.version()
    }

    /// Apply a stroke given as JSON (normalized `Stroke`).
    #[wasm_bindgen(js_name = applyStroke)]
    pub fn apply_stroke(&mut self, stroke_json: &str, seed: u32) -> Result<(), JsError> {
        let stroke: Stroke =
            serde_json::from_str(stroke_json).map_err(|e| JsError::new(&e.to_string()))?;
        self.0
            .apply_stroke(&stroke, seed)
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = renderJpeg)]
    pub fn render_jpeg(&self, quality: u8) -> Result<Vec<u8>, JsError> {
        self.0.render_jpeg(quality).map_err(|e| JsError::new(&e))
    }

    /// Score against a reference grid from `prepareReference`.
    pub fn score(&self, grid: &[f32]) -> Result<f32, JsError> {
        Ok(self.0.score(&unflatten(grid)?))
    }

    pub fn checkpoint(&self) -> Vec<u8> {
        self.0.checkpoint()
    }
}
