// Compile crates/renderer to WebAssembly and generate JS bindings for the Worker.
//
// wasm-bindgen's CLI must match the crate's `wasm-bindgen = "=x.y.z"` pin, so
// a matching prebuilt CLI is downloaded into .tools/ (checksum-verified), with
// `cargo install` as the fallback on platforms without a pinned binary.
//
//   bun tooling/build-wasm.ts [--spectral]
//
// --spectral builds with hokusai's spectral mixing instead of the default, Mixbox.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const WASM_BINDGEN_VERSION = "0.2.130";
// SHA-256 of the release tarballs, from the release's .sha256sum files.
const WASM_BINDGEN_SHA256: Record<string, string> = {
  "x86_64-unknown-linux-musl": "9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f",
  "aarch64-unknown-linux-musl": "99ffc93ce80081b91632e2b539b782821a8f3439ab0fddc645287462b2f55d3d",
  "aarch64-apple-darwin": "b90ddb9357f584b1af897d58ad77e4cce2b48fc17e2a967bc249a87f72809444",
  "x86_64-apple-darwin": "eb209c115b7cb95832423c1aa3f4d06d6c53f63ef74fc4b6fb79ef0b2eea5f10",
};

const root = join(import.meta.dir, "..");
const tools = join(root, ".tools");
const bindgen = join(tools, "bin", "wasm-bindgen");
const outDir = join(root, "apps/worker/src/wasm");
const wasmFile = join(root, "target/wasm32-unknown-unknown/release/agentpaint_renderer.wasm");
const features = process.argv.includes("--spectral") ? ["--no-default-features"] : [];

// CI installs rustup into ~/.cargo/bin without touching PATH for later steps.
const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
const path = Bun.which("cargo") ? process.env.PATH : `${cargoBin}:${process.env.PATH ?? ""}`;
if (!Bun.which("cargo", { PATH: path })) {
  throw new Error("cargo not found; install Rust (tooling/install-rust.sh does this in CI)");
}

const manifest = await Bun.file(join(root, "crates/renderer/Cargo.toml")).text();
const pinned = manifest.match(/wasm-bindgen\s*=\s*"=([^"]+)"/)?.[1];
if (pinned !== WASM_BINDGEN_VERSION) {
  throw new Error(
    `crates/renderer pins wasm-bindgen ${pinned}, but tooling/build-wasm.ts expects ${WASM_BINDGEN_VERSION}; update both together`,
  );
}

function targetTriple(): string | null {
  const cpu = arch() === "x64" ? "x86_64" : arch() === "arm64" ? "aarch64" : null;
  if (!cpu) return null;
  if (platform() === "linux") return `${cpu}-unknown-linux-musl`;
  if (platform() === "darwin") return `${cpu}-apple-darwin`;
  return null;
}

async function installedVersion(): Promise<string | undefined> {
  if (!existsSync(bindgen)) return undefined;
  return (await $`${bindgen} --version`.text()).trim().split(" ")[1];
}

async function installBindgen() {
  const triple = targetTriple();
  const sha256 = triple ? WASM_BINDGEN_SHA256[triple] : undefined;
  if (!triple || !sha256) {
    console.log(
      `No pinned wasm-bindgen binary for this platform; building ${WASM_BINDGEN_VERSION} from source`,
    );
    await $`cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked --root ${tools}`.env({
      ...process.env,
      PATH: path,
    });
    return;
  }
  const name = `wasm-bindgen-${WASM_BINDGEN_VERSION}-${triple}`;
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${name}.tar.gz`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  const tarball = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  if (digest !== sha256) throw new Error(`wasm-bindgen checksum mismatch: got ${digest}, expected ${sha256}`);

  const staging = join(tools, "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(tools, "bin"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  await Bun.write(join(staging, "wasm-bindgen.tar.gz"), tarball);
  await $`tar -xzf ${join(staging, "wasm-bindgen.tar.gz")} -C ${staging}`;
  await $`mv ${join(staging, name, "wasm-bindgen")} ${bindgen}`;
  rmSync(staging, { recursive: true, force: true });
}

const installed = await installedVersion();
if (installed !== WASM_BINDGEN_VERSION) {
  console.log(`Installing wasm-bindgen ${WASM_BINDGEN_VERSION} into .tools/ (found ${installed ?? "none"})`);
  await installBindgen();
}

// Strip machine-specific paths (embedded in panic messages) so builds are
// reproducible across machines.
const rustflags = [
  `--remap-path-prefix=${root}=/agentpaint`,
  `--remap-path-prefix=${join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry")}=/cargo-registry`,
].join(" ");
await $`cargo build --locked --release --target wasm32-unknown-unknown -p agentpaint-renderer ${features}`
  .cwd(root)
  .env({ ...process.env, PATH: path, RUSTFLAGS: rustflags });

// --target web exposes initSync({ module }), which accepts the WebAssembly.Module
// that Workers gives us when importing a .wasm file. --omit-default-module-path
// drops the fetch-by-URL fallback, which Workers cannot use.
// --experimental-reset-state-function generates __wbg_reset_state, which the
// Worker calls to get a fresh instance if the renderer ever traps.
await $`${bindgen} --target web --omit-default-module-path --experimental-reset-state-function --out-dir ${outDir} --out-name renderer ${wasmFile}`;

console.log(`Renderer bindings written to ${outDir}`);
