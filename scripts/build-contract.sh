#!/usr/bin/env bash
# Build the Stipend policy engine wasm.
#
# RUSTFLAGS="--cfg near" is REQUIRED. near-sdk-env gates its host calls
# (panic messages, sha256, and friends) behind that custom cfg; a plain
# cargo build silently swaps in local fallbacks, and on chain every
# rejection then surfaces as a bare "WebAssembly trap" with no message.
# Verified live on testnet 2026-11-05: without the flag the wasm imports
# neither env.panic_utf8 nor env.sha256; with it, both are present and
# rejections carry their reasons.
set -euo pipefail
cd "$(dirname "$0")/../contracts/policy-engine"
export PATH="$HOME/.cargo/bin:$PATH"
RUSTFLAGS="--cfg near" cargo build --target wasm32-unknown-unknown --release
echo "wasm: target/wasm32-unknown-unknown/release/stipend_policy_engine.wasm"
