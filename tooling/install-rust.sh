#!/usr/bin/env bash
# Install the Rust toolchain pinned in rust-toolchain.toml when cargo is missing.
# Used by Workers Builds, whose build image has no Rust. The rustup installer is
# downloaded at a pinned version and checked against a pinned SHA-256.
set -euo pipefail

RUSTUP_VERSION="1.29.3"
RUSTUP_TARGET="x86_64-unknown-linux-gnu"
RUSTUP_SHA256="b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55"

cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
      echo "install-rust.sh only installs on Linux x86_64; install Rust from https://rustup.rs" >&2
      exit 1
    fi
    echo "Installing rustup ${RUSTUP_VERSION} (minimal profile)"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl --proto '=https' --tlsv1.2 -sSf -o "$tmp/rustup-init" \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUSTUP_TARGET}/rustup-init"
    echo "${RUSTUP_SHA256}  $tmp/rustup-init" | sha256sum -c -
    chmod +x "$tmp/rustup-init"
    "$tmp/rustup-init" -y --profile minimal --default-toolchain none --no-modify-path
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Installs the channel and the wasm32 target listed in rust-toolchain.toml.
rustup show active-toolchain || rustup toolchain install
cargo --version
