//! wasm-bindgen wrapper around [`Canvas`] for the Worker.
//!
//! Strokes cross the boundary as JSON (the same normalized format stored in the
//! database); errors become JS exceptions.

use wasm_bindgen::prelude::*;

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
    pub fn width(&self) -> u32 {
        self.0.width()
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.0.height()
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

    #[wasm_bindgen(js_name = renderPng)]
    pub fn render_png(&self) -> Result<Vec<u8>, JsError> {
        self.0.render_png().map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = renderJpeg)]
    pub fn render_jpeg(&self, quality: u8) -> Result<Vec<u8>, JsError> {
        self.0.render_jpeg(quality).map_err(|e| JsError::new(&e))
    }

    pub fn checkpoint(&self) -> Vec<u8> {
        self.0.checkpoint()
    }
}
