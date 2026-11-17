// Loads the Rust renderer. Importing a .wasm file in Workers yields a compiled
// WebAssembly.Module; initSync instantiates it once per isolate.

import { initSync } from "./wasm/renderer.js";
import wasmModule from "./wasm/renderer_bg.wasm";

initSync({ module: wasmModule });

export {
  __wbg_reset_state as resetRenderer,
  Canvas,
  mixingModel,
  prepareReference,
  validateStroke,
  version as rendererVersion,
} from "./wasm/renderer.js";
